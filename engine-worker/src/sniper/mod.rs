//! Momentum sniper — Rust-native token momentum detection and scalping.
//! Runs in the same process as the Geyser monitor for sub-ms latency.
//!
//! Architecture:
//!   Geyser account updates → velocity tracker → scoring → Jupiter execution → position mgmt
//!   DexScreener polling → candidate discovery → scoring → Jupiter execution → position mgmt

pub mod discovery;
pub mod velocity;
pub mod scorer;
pub mod positions;
pub mod executor;

use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::info;

use crate::pool_monitor::decode::PoolUpdate;
use velocity::VelocityTracker;
use scorer::AdaptiveScorer;
use positions::PositionManager;

/// Sniper configuration
#[derive(Clone, Debug)]
pub struct SniperConfig {
    pub paper_mode: bool,
    pub buy_size_sol: f64,
    pub max_positions: usize,
    pub max_hold_secs: u64,
    pub min_volume_1h: f64,
    pub min_price_change_1h: f64,
    pub min_buy_ratio: f64,
    pub min_buys_1h: u64,
    pub poll_interval_secs: u64,
    pub telegram_token: String,
    pub telegram_chat_id: String,
    pub jupiter_api_key: String,
    pub rpc_url: String,
}

impl SniperConfig {
    pub fn from_env() -> Self {
        let paper_mode = std::env::var("PAPER_MODE")
            .map(|v| v.to_lowercase() == "true")
            .unwrap_or(true);
        let buy_size = if paper_mode { 0.1 } else { 0.03 };

        Self {
            paper_mode,
            buy_size_sol: std::env::var("SNIPER_BUY_SOL")
                .ok().and_then(|v| v.parse().ok()).unwrap_or(buy_size),
            max_positions: std::env::var("SNIPER_MAX_POS")
                .ok().and_then(|v| v.parse().ok()).unwrap_or(1),
            max_hold_secs: std::env::var("SNIPER_MAX_HOLD_SECS")
                .ok().and_then(|v| v.parse().ok()).unwrap_or(1800),
            min_volume_1h: std::env::var("SNIPER_MIN_VOL")
                .ok().and_then(|v| v.parse().ok()).unwrap_or(8000.0),
            min_price_change_1h: std::env::var("SNIPER_MIN_CHG")
                .ok().and_then(|v| v.parse().ok()).unwrap_or(3.0),
            min_buy_ratio: std::env::var("SNIPER_MIN_BR")
                .ok().and_then(|v| v.parse().ok()).unwrap_or(3.5),
            min_buys_1h: std::env::var("SNIPER_MIN_BUYS")
                .ok().and_then(|v| v.parse().ok()).unwrap_or(30),
            poll_interval_secs: std::env::var("SNIPER_POLL_SECS")
                .ok().and_then(|v| v.parse().ok()).unwrap_or(5),
            telegram_token: std::env::var("TELEGRAM_BOT_TOKEN").unwrap_or_default(),
            telegram_chat_id: std::env::var("TELEGRAM_CHAT_ID").unwrap_or_default(),
            jupiter_api_key: std::env::var("JUPITER_API_KEY").unwrap_or_default(),
            rpc_url: std::env::var("SOLANA_RPC_URL").unwrap_or_default(),
        }
    }
}

/// Main sniper runtime — call from engine main
pub async fn run_sniper(
    config: SniperConfig,
    pool_rx: tokio::sync::mpsc::Receiver<PoolUpdate>,
) {
    let mode = if config.paper_mode { "PAPER" } else { "LIVE" };
    info!("=== PCP MOMENTUM SNIPER (Rust) [{}] ===", mode);
    info!("Buy: {} SOL | Max pos: {} | Hold: {}s", config.buy_size_sol, config.max_positions, config.max_hold_secs);

    let velocity = Arc::new(RwLock::new(VelocityTracker::new()));
    let scorer = Arc::new(RwLock::new(AdaptiveScorer::new()));
    let positions = Arc::new(RwLock::new(PositionManager::new(config.clone())));

    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("HTTP client");

    // Task 1: DexScreener discovery polling
    let disc_config = config.clone();
    let disc_http = http.clone();
    let disc_velocity = velocity.clone();
    let disc_scorer = scorer.clone();
    let disc_positions = positions.clone();
    tokio::spawn(async move {
        discovery::poll_loop(disc_config, disc_http, disc_velocity, disc_scorer, disc_positions).await;
    });

    // Task 2: Position monitoring (exits, trailing stops)
    let exit_config = config.clone();
    let exit_http = http.clone();
    let exit_positions = positions.clone();
    let exit_velocity = velocity.clone();
    tokio::spawn(async move {
        positions::exit_monitor_loop(exit_config, exit_http, exit_positions, exit_velocity).await;
    });

    // Task 3: Process Geyser pool updates for velocity tracking + instant pricing
    let upd_velocity = velocity.clone();
    let upd_positions = positions.clone();
    tokio::spawn(async move {
        info!("Sniper listening for Geyser pool updates via channel...");
        let mut update_count: u64 = 0;
        let mut pool_rx = pool_rx;
        loop {
            match pool_rx.recv().await {
                Some(update) => {
                    update_count += 1;
                    if update_count % 10000 == 1 {
                        info!("Sniper: processed {} pool updates from Geyser", update_count);
                    }
                    let mut vel = upd_velocity.write().await;
                    vel.record_pool_update(&update);
                    drop(vel);
                    let mut pos = upd_positions.write().await;
                    pos.update_pool_price(&update);
                }
                None => {
                    info!("Pool update channel idle — Geyser pipe not connected yet");
                    // Don't exit — just wait. Channel will get data when wired.
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                }
            }
        }
    });

    // Task 4: Periodic velocity cleanup + snapshot
    let cleanup_vel = velocity.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            let mut vel = cleanup_vel.write().await;
            vel.cleanup();
            vel.snapshot_velocities();
        }
    });

    // Keep main sniper task alive
    info!("Rust sniper running — discovery + exits + pool updates active");
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
    }
}
