use futures::{SinkExt, StreamExt};
use solana_sdk::pubkey::Pubkey;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, info, warn, error};
use super::types::*;

fn usdc_mint() -> Pubkey {
    Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap()
}

pub struct PoolWebSocket {
    rpc_url: String,
    /// Map of subscription_id -> pool_address for tracking
    subscriptions: Arc<RwLock<HashMap<u64, Pubkey>>>,
    /// Map of pool_address -> latest pool info
    pool_state: Arc<RwLock<HashMap<Pubkey, PoolInfo>>>,
}

impl PoolWebSocket {
    pub fn new(rpc_url: &str) -> Self {
        // Convert HTTP URL to WebSocket URL
        let ws_url = rpc_url
            .replace("https://", "wss://")
            .replace("http://", "ws://");

        Self {
            rpc_url: ws_url,
            subscriptions: Arc::new(RwLock::new(HashMap::new())),
            pool_state: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Initialize pool state from the scanner results
    pub async fn init_pool_state(&self, multi_dex_map: &MultiDexMap) {
        let mut state = self.pool_state.write().await;
        for token in multi_dex_map.values() {
            for pool in &token.pools {
                state.insert(pool.address, pool.clone());
            }
        }
        info!("Initialized pool state with {} pools", state.len());
    }

    /// Get current pool state (for spread calculation)
    pub async fn get_pool_state(&self) -> HashMap<Pubkey, PoolInfo> {
        self.pool_state.read().await.clone()
    }

    /// Subscribe to pool accounts and stream updates.
    /// Sends SpreadOpportunity through the channel when spreads are detected.
    pub async fn run(
        &self,
        pool_addresses: Vec<Pubkey>,
        multi_dex_map: Arc<RwLock<MultiDexMap>>,
        opportunity_tx: mpsc::Sender<SpreadOpportunity>,
    ) {
        loop {
            match self.connect_and_subscribe(&pool_addresses, &multi_dex_map, &opportunity_tx).await {
                Ok(_) => {
                    warn!("WebSocket connection closed, reconnecting in 5s...");
                }
                Err(e) => {
                    error!("WebSocket error: {}, reconnecting in 5s...", e);
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    }

    async fn connect_and_subscribe(
        &self,
        pool_addresses: &[Pubkey],
        multi_dex_map: &Arc<RwLock<MultiDexMap>>,
        opportunity_tx: &mpsc::Sender<SpreadOpportunity>,
    ) -> anyhow::Result<()> {
        info!("Connecting to WebSocket: {}", self.rpc_url);
        let (ws_stream, _) = connect_async(&self.rpc_url).await?;
        let (mut write, mut read) = ws_stream.split();
        info!("WebSocket connected");

        // Subscribe to each pool account
        // Batch subscriptions to avoid overwhelming the connection
        let batch_size = 50;
        for (i, chunk) in pool_addresses.chunks(batch_size).enumerate() {
            for (j, address) in chunk.iter().enumerate() {
                let sub_id = (i * batch_size + j) as u64;
                let msg = serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": sub_id,
                    "method": "accountSubscribe",
                    "params": [
                        address.to_string(),
                        {
                            "encoding": "base64",
                            "commitment": "confirmed"
                        }
                    ]
                });
                write.send(Message::Text(msg.to_string())).await?;
            }
            // Small delay between batches
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }

        info!("Subscribed to {} pool accounts", pool_addresses.len());

        // Process incoming messages
        while let Some(msg) = read.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    let data: serde_json::Value = match serde_json::from_str(&text) {
                        Ok(d) => d,
                        Err(_) => continue,
                    };

                    // Handle subscription confirmations
                    if data.get("result").is_some() && data.get("id").is_some() {
                        let req_id = data["id"].as_u64().unwrap_or(0);
                        let sub_id = data["result"].as_u64().unwrap_or(0);
                        if req_id < pool_addresses.len() as u64 {
                            self.subscriptions.write().await.insert(sub_id, pool_addresses[req_id as usize]);
                        }
                        continue;
                    }

                    // Handle account update notifications
                    if let Some(params) = data.get("params") {
                        let sub_id = params["subscription"].as_u64().unwrap_or(0);
                        let pool_address = {
                            let subs = self.subscriptions.read().await;
                            subs.get(&sub_id).cloned()
                        };

                        if let Some(address) = pool_address {
                            // Account data changed — a swap happened in this pool.
                            // For now, we detect the change and check spreads.
                            // Full implementation would decode the account data to get new reserves.
                            debug!("Pool {} updated", address);

                            // Check all tokens that include this pool for spread opportunities
                            let map = multi_dex_map.read().await;
                            for token in map.values() {
                                if token.pools.iter().any(|p| p.address == address) {
                                    if let Some(spread) = token.best_spread(&usdc_mint()) {
                                        if spread.spread_pct > 0.1 { // > 0.1% spread
                                            info!(
                                                "Spread detected: {} {:.4}% ({} @ {:.4} -> {} @ {:.4})",
                                                spread.symbol.as_deref().unwrap_or("?"),
                                                spread.spread_pct,
                                                spread.buy_dex, spread.buy_price,
                                                spread.sell_dex, spread.sell_price,
                                            );
                                            let _ = opportunity_tx.send(spread).await;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(Message::Ping(data)) => {
                    let _ = write.send(Message::Pong(data)).await;
                }
                Ok(Message::Close(_)) => {
                    warn!("WebSocket closed by server");
                    break;
                }
                Err(e) => {
                    error!("WebSocket read error: {}", e);
                    break;
                }
                _ => {}
            }
        }

        Ok(())
    }
}
