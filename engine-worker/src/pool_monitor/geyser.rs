//! Geyser gRPC client for real-time pool monitoring via Chainstack Yellowstone

use std::collections::HashMap;
use std::sync::Arc;
use std::str::FromStr;
use futures::{SinkExt, StreamExt};
use tokio::sync::{mpsc, RwLock};
use tracing::{info, warn, error, debug};
use solana_sdk::pubkey::Pubkey;
use yellowstone_grpc_client::GeyserGrpcClient;
use yellowstone_grpc_proto::geyser::{
    SubscribeRequest, SubscribeRequestFilterAccounts,
    subscribe_update::UpdateOneof,
    CommitmentLevel,
};
use super::types::*;

pub struct GeyserMonitor {
    endpoint: String,
    token: String,
}

impl GeyserMonitor {
    pub fn new(endpoint: &str, token: &str) -> Self {
        Self {
            endpoint: endpoint.to_string(),
            token: token.to_string(),
        }
    }

    pub fn from_env() -> Option<Self> {
        let endpoint = std::env::var("GEYSER_ENDPOINT").ok()?;
        let token = std::env::var("GEYSER_TOKEN").ok().unwrap_or_default();
        if endpoint.is_empty() || !endpoint.starts_with("http") || endpoint.contains("disabled") {
            return None;
        }
        Some(Self::new(&endpoint, &token))
    }

    pub async fn run(
        &self,
        pool_addresses: Vec<Pubkey>,
        multi_dex_map: Arc<RwLock<MultiDexMap>>,
        spread_tx: mpsc::Sender<SpreadOpportunity>,
    ) {
        loop {
            match self.connect_and_stream(&pool_addresses, &multi_dex_map, &spread_tx).await {
                Ok(_) => warn!("Geyser stream ended, reconnecting in 5s..."),
                Err(e) => error!("Geyser error: {:?}, reconnecting in 5s...", e),
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    }

    async fn connect_and_stream(
        &self,
        pool_addresses: &[Pubkey],
        multi_dex_map: &Arc<RwLock<MultiDexMap>>,
        spread_tx: &mpsc::Sender<SpreadOpportunity>,
    ) -> anyhow::Result<()> {
        info!("Connecting to Geyser gRPC: {} (token length: {})", self.endpoint, self.token.len());

        // Load system CA bundle so rustls trusts ZeroSSL (Chainstack's CA)
        let ca_pem = std::fs::read("/etc/ssl/certs/ca-certificates.crt")
            .unwrap_or_else(|_| Vec::new());

        let mut builder = GeyserGrpcClient::build_from_shared(self.endpoint.clone())
            .map_err(|e| anyhow::anyhow!("build_from_shared failed: {:?}", e))?
            .x_token(Some(self.token.clone()))
            .map_err(|e| anyhow::anyhow!("x_token failed: {:?}", e))?;

        if !ca_pem.is_empty() {
            let cert = tonic::transport::Certificate::from_pem(ca_pem);
            let tls = yellowstone_grpc_client::ClientTlsConfig::new()
                .ca_certificate(cert);
            builder = builder.tls_config(tls)
                .map_err(|e| anyhow::anyhow!("tls_config failed: {:?}", e))?;
            info!("Loaded system CA certificates for Geyser TLS");
        }

        let connect_result = builder
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(10))
            .connect()
            .await;

        let mut client = match connect_result {
            Ok(c) => c,
            Err(e) => return Err(anyhow::anyhow!("Geyser connect failed: {:?}", e)),
        };

        info!("Geyser gRPC connected");

        // Subscribe to DEX program accounts — catches ALL pool updates across all DEXes
        let mut accounts_filter = HashMap::new();

        // Subscribe to specific pool accounts if we have them
        if !pool_addresses.is_empty() {
            let account_keys: Vec<String> = pool_addresses.iter()
                .map(|p| p.to_string())
                .collect();
            accounts_filter.insert(
                "pools".to_string(),
                SubscribeRequestFilterAccounts {
                    account: account_keys,
                    owner: vec![],
                    filters: vec![],
                    nonempty_txn_signature: None,
                },
            );
            info!("Subscribed to {} specific pool accounts", pool_addresses.len());
        }

        // Also subscribe to ALL accounts owned by major DEX programs
        // This catches every pool state change without needing to know pool addresses upfront
        accounts_filter.insert(
            "dex_programs".to_string(),
            SubscribeRequestFilterAccounts {
                account: vec![],
                owner: vec![
                    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8".to_string(), // Raydium AMM V4
                    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc".to_string(),  // Orca Whirlpool
                    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo".to_string(),  // Meteora DLMM
                    "PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP".to_string(),  // PumpSwap AMM
                ],
                filters: vec![],
                nonempty_txn_signature: None,
            },
        );

        let (mut subscribe_tx, mut stream) = client.subscribe().await?;

        let request = SubscribeRequest {
            accounts: accounts_filter,
            slots: HashMap::new(),
            transactions: HashMap::new(),
            transactions_status: HashMap::new(),
            blocks: HashMap::new(),
            blocks_meta: HashMap::new(),
            entry: HashMap::new(),
            commitment: Some(CommitmentLevel::Confirmed as i32),
            accounts_data_slice: vec![],
            ping: None,
            from_slot: None,
        };

        subscribe_tx.send(request).await?;
        info!("Geyser subscription active — streaming {} specific pools + 4 DEX programs (Raydium, Orca, Meteora, PumpSwap)", pool_addresses.len());

        let usdc_mint = Pubkey::from_str("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").unwrap();
        let mut updates: u64 = 0;

        while let Some(Ok(msg)) = stream.next().await {
            if let Some(update) = msg.update_oneof {
                match update {
                    UpdateOneof::Account(acct) => {
                        if let Some(info) = acct.account {
                            if info.pubkey.len() == 32 {
                                let mut arr = [0u8; 32];
                                arr.copy_from_slice(&info.pubkey);
                                let pubkey = Pubkey::new_from_array(arr);

                                updates += 1;
                                if updates % 100 == 1 {
                                    debug!("Geyser: {} pool updates received", updates);
                                }

                                let map = multi_dex_map.read().await;
                                for token in map.values() {
                                    if token.pools.iter().any(|p| p.address == pubkey) {
                                        if let Some(spread) = token.best_spread(&usdc_mint) {
                                            if spread.spread_pct > 0.1 {
                                                info!(
                                                    "GEYSER SPREAD: {} {:.4}% ({} -> {})",
                                                    spread.symbol.as_deref().unwrap_or("?"),
                                                    spread.spread_pct,
                                                    spread.buy_dex, spread.sell_dex,
                                                );
                                                let _ = spread_tx.send(spread).await;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    UpdateOneof::Ping(_) => {
                        debug!("Geyser ping");
                    }
                    _ => {}
                }
            }
        }

        Ok(())
    }
}
