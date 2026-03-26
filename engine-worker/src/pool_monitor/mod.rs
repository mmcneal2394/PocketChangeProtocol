pub mod types;
pub mod pool_math;
pub mod scanner;
pub mod websocket;

use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tracing::{info, warn};
use crate::types::Opportunity;
use types::*;

/// Start the pool monitor system
/// Scans DEXes for multi-DEX tokens, subscribes via WebSocket, and emits opportunities
pub async fn run_pool_monitor(
    rpc: Arc<solana_client::rpc_client::RpcClient>,
    rpc_url: String,
    opportunity_tx: mpsc::Sender<Opportunity>,
) {
    // 1. Initial scan
    info!("Starting pool monitor — scanning DEXes...");
    let scanner = scanner::PoolScanner::new(rpc.clone());
    let map = scanner.scan_all().await;
    let pool_addresses = scanner::PoolScanner::get_pool_addresses(&map);
    info!("Monitoring {} pools across {} multi-DEX tokens", pool_addresses.len(), map.len());

    let multi_dex_map = Arc::new(RwLock::new(map));

    // 2. Initialize WebSocket
    let ws = websocket::PoolWebSocket::new(&rpc_url);
    {
        let map_read = multi_dex_map.read().await;
        ws.init_pool_state(&map_read).await;
    }

    // 3. Spread detection channel
    let (spread_tx, mut spread_rx) = mpsc::channel::<SpreadOpportunity>(256);

    // 4. Spawn WebSocket listener
    let ws_addrs = pool_addresses.clone();
    let ws_map = multi_dex_map.clone();
    tokio::spawn(async move {
        ws.run(ws_addrs, ws_map, spread_tx).await;
    });

    // 5. Spawn periodic re-scanner (every 10 min)
    let rescan_rpc = rpc.clone();
    let rescan_map = multi_dex_map.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(600)).await;
            info!("Re-scanning DEX pools...");
            let s = scanner::PoolScanner::new(rescan_rpc.clone());
            let new_map = s.scan_all().await;
            let new_count = new_map.len();
            *rescan_map.write().await = new_map;
            info!("Pool re-scan complete: {} multi-DEX tokens", new_count);
        }
    });

    // 6. Convert spread opportunities to engine Opportunities and forward
    while let Some(spread) = spread_rx.recv().await {
        let net_profit = spread.spread_pct - 0.05; // rough fee estimate
        if net_profit <= 0.0 {
            continue;
        }

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
