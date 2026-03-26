pub mod types;
pub mod pool_math;
pub mod scanner;
pub mod websocket;
pub mod geyser;

use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tracing::{info, warn, error};
use crate::types::Opportunity;
use types::*;

/// Start the pool monitor system
/// Scans DEXes for multi-DEX tokens, then monitors via Geyser gRPC (preferred) or WebSocket (fallback)
pub async fn run_pool_monitor(
    rpc: Arc<solana_client::rpc_client::RpcClient>,
    rpc_url: String,
    opportunity_tx: mpsc::Sender<Opportunity>,
) {
    info!("=== POOL MONITOR STARTING ===");

    // 1. Initial scan
    info!("Scanning Raydium + Orca + Meteora for multi-DEX tokens...");
    let scanner_inst = scanner::PoolScanner::new(rpc.clone());
    let map = scanner_inst.scan_all().await;
    let pool_addresses = scanner::PoolScanner::get_pool_addresses(&map);
    info!("Found {} multi-DEX tokens, monitoring {} pools", map.len(), pool_addresses.len());

    if map.is_empty() {
        warn!("No multi-DEX tokens found — pool monitor has nothing to watch");
    }

    let multi_dex_map = Arc::new(RwLock::new(map));

    // 2. Spread detection channel
    let (spread_tx, mut spread_rx) = mpsc::channel::<SpreadOpportunity>(256);

    // 3. Start streaming — Geyser gRPC preferred, WebSocket fallback
    let use_geyser = geyser::GeyserMonitor::from_env();

    if let Some(geyser_monitor) = use_geyser {
        info!("Using Geyser gRPC for pool monitoring (sub-100ms latency)");
        let g_addrs = pool_addresses.clone();
        let g_map = multi_dex_map.clone();
        let g_tx = spread_tx.clone();
        tokio::spawn(async move {
            geyser_monitor.run(g_addrs, g_map, g_tx).await;
        });
    } else {
        info!("Geyser not configured — using Helius WebSocket for pool monitoring");
        let ws = websocket::PoolWebSocket::new(&rpc_url);
        {
            let map_read = multi_dex_map.read().await;
            ws.init_pool_state(&map_read).await;
        }
        let ws_addrs = pool_addresses.clone();
        let ws_map = multi_dex_map.clone();
        tokio::spawn(async move {
            ws.run(ws_addrs, ws_map, spread_tx).await;
        });
    }

    // 4. Periodic re-scanner (every 10 min)
    let rescan_rpc = rpc.clone();
    let rescan_map = multi_dex_map.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(600)).await;
            info!("Re-scanning DEX pools...");
            let s = scanner::PoolScanner::new(rescan_rpc.clone());
            let new_map = s.scan_all().await;
            info!("Pool re-scan: {} multi-DEX tokens", new_map.len());
            *rescan_map.write().await = new_map;
        }
    });

    // 5. Convert spread opportunities to engine Opportunities and forward
    while let Some(spread) = spread_rx.recv().await {
        let net_profit = spread.spread_pct - 0.05;
        if net_profit <= 0.0 {
            continue;
        }

        info!("SPREAD OPPORTUNITY: {} {:.4}% net ({} -> {})",
            spread.symbol.as_deref().unwrap_or("?"),
            net_profit, spread.buy_dex, spread.sell_dex);

        let opp = Opportunity {
            id: uuid::Uuid::new_v4().to_string(),
            strategy: crate::types::StrategyKind::Triangular,
            route: format!("{} buy {} @ {:.6} -> sell {} @ {:.6} (spread {:.4}%)",
                spread.symbol.as_deref().unwrap_or("?"),
                spread.buy_dex, spread.buy_price,
                spread.sell_dex, spread.sell_price,
                spread.spread_pct,
            ),
            expected_profit_pct: rust_decimal::Decimal::from_f64_retain(net_profit)
                .unwrap_or_default(),
            trade_size_usdc: rust_decimal::Decimal::new(100, 0),
            estimated_fees_pct: rust_decimal::Decimal::from_f64_retain(0.05)
                .unwrap_or_default(),
            instructions: vec![],
            detected_at: std::time::Instant::now(),
        };

        if let Err(e) = opportunity_tx.send(opp).await {
            warn!("Failed to send pool monitor opportunity: {}", e);
            break;
        }
    }
}
