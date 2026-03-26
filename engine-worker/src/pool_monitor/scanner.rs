use solana_client::rpc_client::RpcClient;
use solana_sdk::pubkey::Pubkey;
use solana_sdk::account::Account;
use solana_client::rpc_config::{RpcAccountInfoConfig, RpcProgramAccountsConfig};
use solana_client::rpc_filter::{RpcFilterType, Memcmp, MemcmpEncodedBytes};
use solana_account_decoder::UiAccountEncoding;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use tracing::{info, warn, debug};
use super::types::*;

// Raydium AMM V4 program ID
const RAYDIUM_AMM_V4: &str = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
// Orca Whirlpool program ID
const ORCA_WHIRLPOOL: &str = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
// Meteora DLMM program ID
const METEORA_DLMM: &str = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";

// Known USDC mint for filtering
const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_MINT: &str = "So11111111111111111111111111111111111111112";

pub struct PoolScanner {
    rpc: Arc<RpcClient>,
}

impl PoolScanner {
    pub fn new(rpc: Arc<RpcClient>) -> Self {
        Self { rpc }
    }

    /// Scan all DEXes and build a map of tokens on 2+ DEXes
    pub async fn scan_all(&self) -> MultiDexMap {
        let mut all_pools: Vec<PoolInfo> = Vec::new();

        // Scan each DEX
        info!("Scanning Raydium pools...");
        match self.scan_raydium().await {
            Ok(pools) => {
                info!("Found {} Raydium pools", pools.len());
                all_pools.extend(pools);
            }
            Err(e) => warn!("Raydium scan failed: {}", e),
        }

        info!("Scanning Orca pools...");
        match self.scan_orca().await {
            Ok(pools) => {
                info!("Found {} Orca pools", pools.len());
                all_pools.extend(pools);
            }
            Err(e) => warn!("Orca scan failed: {}", e),
        }

        info!("Scanning Meteora pools...");
        match self.scan_meteora().await {
            Ok(pools) => {
                info!("Found {} Meteora pools", pools.len());
                all_pools.extend(pools);
            }
            Err(e) => warn!("Meteora scan failed: {}", e),
        }

        // Build multi-DEX map
        self.build_multi_dex_map(all_pools)
    }

    /// Scan Raydium AMM V4 pools
    /// Account layout: first 8 bytes = discriminator, then various fields
    /// We use Helius enhanced API for efficiency instead of getProgramAccounts
    async fn scan_raydium(&self) -> anyhow::Result<Vec<PoolInfo>> {
        let program_id = Pubkey::from_str(RAYDIUM_AMM_V4)?;

        // Use Helius enhanced transactions API to get pool data
        // For now, use a curated list of high-liquidity Raydium pools
        // Full getProgramAccounts would return thousands of pools and be slow
        let pools = self.get_curated_raydium_pools().await?;
        Ok(pools)
    }

    /// Scan Orca Whirlpool pools
    async fn scan_orca(&self) -> anyhow::Result<Vec<PoolInfo>> {
        let pools = self.get_curated_orca_pools().await?;
        Ok(pools)
    }

    /// Scan Meteora DLMM pools
    async fn scan_meteora(&self) -> anyhow::Result<Vec<PoolInfo>> {
        let pools = self.get_curated_meteora_pools().await?;
        Ok(pools)
    }

    /// Get curated Raydium pools via their API (faster than on-chain scan)
    async fn get_curated_raydium_pools(&self) -> anyhow::Result<Vec<PoolInfo>> {
        let client = reqwest::Client::new();
        let resp = client.get("https://api.raydium.io/v2/ammV3/ammPools")
            .timeout(std::time::Duration::from_secs(10))
            .send().await?;

        let data: serde_json::Value = resp.json().await?;
        let mut pools = Vec::new();

        if let Some(pool_list) = data["data"].as_array() {
            for pool in pool_list {
                let address = match pool["id"].as_str().and_then(|s| Pubkey::from_str(s).ok()) {
                    Some(a) => a,
                    None => continue,
                };
                let mint_a = match pool["mintA"]["address"].as_str().and_then(|s| Pubkey::from_str(s).ok()) {
                    Some(m) => m,
                    None => continue,
                };
                let mint_b = match pool["mintB"]["address"].as_str().and_then(|s| Pubkey::from_str(s).ok()) {
                    Some(m) => m,
                    None => continue,
                };

                let symbol_a = pool["mintA"]["symbol"].as_str().map(|s| s.to_string());
                let symbol_b = pool["mintB"]["symbol"].as_str().map(|s| s.to_string());
                let decimals_a = pool["mintA"]["decimals"].as_u64().unwrap_or(6) as u8;
                let decimals_b = pool["mintB"]["decimals"].as_u64().unwrap_or(6) as u8;

                // Get reserves from tvl data if available
                let reserve_a = pool["mintAmountA"].as_f64()
                    .map(|v| (v * 10_f64.powi(decimals_a as i32)) as u64)
                    .unwrap_or(0);
                let reserve_b = pool["mintAmountB"].as_f64()
                    .map(|v| (v * 10_f64.powi(decimals_b as i32)) as u64)
                    .unwrap_or(0);

                pools.push(PoolInfo {
                    address,
                    dex: DexType::Raydium,
                    token_a_mint: mint_a,
                    token_b_mint: mint_b,
                    token_a_symbol: symbol_a,
                    token_b_symbol: symbol_b,
                    reserve_a,
                    reserve_b,
                    token_a_decimals: decimals_a,
                    token_b_decimals: decimals_b,
                });
            }
        }

        Ok(pools)
    }

    /// Get curated Orca pools via their API
    async fn get_curated_orca_pools(&self) -> anyhow::Result<Vec<PoolInfo>> {
        let client = reqwest::Client::new();
        let resp = client.get("https://api.mainnet.orca.so/v1/whirlpool/list")
            .timeout(std::time::Duration::from_secs(10))
            .send().await?;

        let data: serde_json::Value = resp.json().await?;
        let mut pools = Vec::new();

        if let Some(whirlpools) = data["whirlpools"].as_array() {
            for pool in whirlpools {
                let address = match pool["address"].as_str().and_then(|s| Pubkey::from_str(s).ok()) {
                    Some(a) => a,
                    None => continue,
                };
                let mint_a = match pool["tokenA"]["mint"].as_str().and_then(|s| Pubkey::from_str(s).ok()) {
                    Some(m) => m,
                    None => continue,
                };
                let mint_b = match pool["tokenB"]["mint"].as_str().and_then(|s| Pubkey::from_str(s).ok()) {
                    Some(m) => m,
                    None => continue,
                };

                let symbol_a = pool["tokenA"]["symbol"].as_str().map(|s| s.to_string());
                let symbol_b = pool["tokenB"]["symbol"].as_str().map(|s| s.to_string());
                let decimals_a = pool["tokenA"]["decimals"].as_u64().unwrap_or(6) as u8;
                let decimals_b = pool["tokenB"]["decimals"].as_u64().unwrap_or(6) as u8;

                // TVL filter — skip low-liquidity pools
                let tvl = pool["tvl"].as_f64().unwrap_or(0.0);
                if tvl < 10000.0 { continue; } // Skip pools with < $10k TVL

                pools.push(PoolInfo {
                    address,
                    dex: DexType::Orca,
                    token_a_mint: mint_a,
                    token_b_mint: mint_b,
                    token_a_symbol: symbol_a,
                    token_b_symbol: symbol_b,
                    reserve_a: 0, // Orca uses concentrated liquidity — reserves calculated differently
                    reserve_b: 0,
                    token_a_decimals: decimals_a,
                    token_b_decimals: decimals_b,
                });
            }
        }

        Ok(pools)
    }

    /// Get curated Meteora pools via their API
    async fn get_curated_meteora_pools(&self) -> anyhow::Result<Vec<PoolInfo>> {
        let client = reqwest::Client::new();
        let resp = client.get("https://dlmm-api.meteora.ag/pair/all")
            .timeout(std::time::Duration::from_secs(10))
            .send().await?;

        let pools_data: Vec<serde_json::Value> = resp.json().await?;
        let mut pools = Vec::new();

        for pool in &pools_data {
            let address = match pool["address"].as_str().and_then(|s| Pubkey::from_str(s).ok()) {
                Some(a) => a,
                None => continue,
            };
            let mint_a = match pool["mint_x"].as_str().and_then(|s| Pubkey::from_str(s).ok()) {
                Some(m) => m,
                None => continue,
            };
            let mint_b = match pool["mint_y"].as_str().and_then(|s| Pubkey::from_str(s).ok()) {
                Some(m) => m,
                None => continue,
            };

            let symbol_a = pool["name"].as_str()
                .and_then(|n| n.split('-').next())
                .map(|s| s.trim().to_string());
            let symbol_b = pool["name"].as_str()
                .and_then(|n| n.split('-').nth(1))
                .map(|s| s.trim().to_string());

            // TVL filter
            let liquidity = pool["liquidity"].as_f64().unwrap_or(0.0);
            if liquidity < 10000.0 { continue; }

            pools.push(PoolInfo {
                address,
                dex: DexType::Meteora,
                token_a_mint: mint_a,
                token_b_mint: mint_b,
                token_a_symbol: symbol_a,
                token_b_symbol: symbol_b,
                reserve_a: 0,
                reserve_b: 0,
                token_a_decimals: 0, // Will be filled from on-chain data
                token_b_decimals: 0,
            });
        }

        Ok(pools)
    }

    /// Build map of tokens that exist on 2+ DEXes
    fn build_multi_dex_map(&self, pools: Vec<PoolInfo>) -> MultiDexMap {
        // Group pools by token mint
        let mut token_pools: HashMap<Pubkey, Vec<PoolInfo>> = HashMap::new();

        for pool in pools {
            token_pools.entry(pool.token_a_mint).or_default().push(pool.clone());
            token_pools.entry(pool.token_b_mint).or_default().push(pool);
        }

        // Filter to tokens on 2+ DEXes
        let mut multi_dex_map = MultiDexMap::new();

        for (mint, pools) in token_pools {
            let mut dexes = std::collections::HashSet::new();
            for pool in &pools {
                dexes.insert(pool.dex);
            }
            if dexes.len() >= 2 {
                let symbol = pools.iter()
                    .find_map(|p| {
                        if p.token_a_mint == mint { p.token_a_symbol.clone() }
                        else { p.token_b_symbol.clone() }
                    });

                debug!("Multi-DEX token: {} ({}) on {} DEXes",
                    symbol.as_deref().unwrap_or("?"), mint, dexes.len());

                multi_dex_map.insert(mint, MultiDexToken {
                    mint,
                    symbol,
                    pools,
                });
            }
        }

        info!("Found {} tokens on 2+ DEXes", multi_dex_map.len());
        multi_dex_map
    }

    /// Get all pool addresses for WebSocket subscription
    pub fn get_pool_addresses(map: &MultiDexMap) -> Vec<Pubkey> {
        map.values()
            .flat_map(|t| t.pools.iter().map(|p| p.address))
            .collect()
    }
}
