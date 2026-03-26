use serde::{Serialize, Deserialize};
use solana_sdk::pubkey::Pubkey;
use std::collections::HashMap;

/// A liquidity pool on a specific DEX
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoolInfo {
    pub address: Pubkey,
    pub dex: DexType,
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub token_a_symbol: Option<String>,
    pub token_b_symbol: Option<String>,
    pub reserve_a: u64,
    pub reserve_b: u64,
    pub token_a_decimals: u8,
    pub token_b_decimals: u8,
}

impl PoolInfo {
    /// Calculate price of token_a in terms of token_b from reserves
    pub fn price_a_in_b(&self) -> f64 {
        if self.reserve_a == 0 {
            return 0.0;
        }
        let adj_a = self.reserve_a as f64 / 10_f64.powi(self.token_a_decimals as i32);
        let adj_b = self.reserve_b as f64 / 10_f64.powi(self.token_b_decimals as i32);
        adj_b / adj_a
    }

    /// Calculate price of token_b in terms of token_a from reserves
    pub fn price_b_in_a(&self) -> f64 {
        if self.reserve_b == 0 {
            return 0.0;
        }
        let adj_a = self.reserve_a as f64 / 10_f64.powi(self.token_a_decimals as i32);
        let adj_b = self.reserve_b as f64 / 10_f64.powi(self.token_b_decimals as i32);
        adj_a / adj_b
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum DexType {
    Raydium,
    Orca,
    Meteora,
}

impl std::fmt::Display for DexType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DexType::Raydium => write!(f, "Raydium"),
            DexType::Orca => write!(f, "Orca"),
            DexType::Meteora => write!(f, "Meteora"),
        }
    }
}

/// A token that exists on multiple DEXes with its pool addresses
#[derive(Debug, Clone)]
pub struct MultiDexToken {
    pub mint: Pubkey,
    pub symbol: Option<String>,
    pub pools: Vec<PoolInfo>,
}

impl MultiDexToken {
    pub fn dex_count(&self) -> usize {
        let mut dexes = std::collections::HashSet::new();
        for pool in &self.pools {
            dexes.insert(pool.dex);
        }
        dexes.len()
    }

    /// Find best buy price (lowest) and best sell price (highest) across DEXes
    /// for this token priced in a quote token (e.g., USDC)
    pub fn best_spread(&self, quote_mint: &Pubkey) -> Option<SpreadOpportunity> {
        let mut prices: Vec<(DexType, Pubkey, f64)> = Vec::new();

        for pool in &self.pools {
            let price = if pool.token_a_mint == *quote_mint {
                // quote is token_a, so price of token_b in quote = price_b_in_a inverted
                pool.price_a_in_b() // how much quote per 1 token
            } else if pool.token_b_mint == *quote_mint {
                pool.price_b_in_a()
            } else {
                continue;
            };

            if price > 0.0 {
                prices.push((pool.dex, pool.address, price));
            }
        }

        if prices.len() < 2 {
            return None;
        }

        let (buy_dex, buy_pool, buy_price) = prices.iter()
            .min_by(|a, b| a.2.partial_cmp(&b.2).unwrap())
            .cloned()?;

        let (sell_dex, sell_pool, sell_price) = prices.iter()
            .filter(|(dex, _, _)| *dex != buy_dex)
            .max_by(|a, b| a.2.partial_cmp(&b.2).unwrap())
            .cloned()?;

        let spread_pct = ((sell_price - buy_price) / buy_price) * 100.0;

        Some(SpreadOpportunity {
            mint: self.mint,
            symbol: self.symbol.clone(),
            buy_dex,
            buy_pool,
            buy_price,
            sell_dex,
            sell_pool,
            sell_price,
            spread_pct,
        })
    }
}

#[derive(Debug, Clone)]
pub struct SpreadOpportunity {
    pub mint: Pubkey,
    pub symbol: Option<String>,
    pub buy_dex: DexType,
    pub buy_pool: Pubkey,
    pub buy_price: f64,
    pub sell_dex: DexType,
    pub sell_pool: Pubkey,
    pub sell_price: f64,
    pub spread_pct: f64,
}

/// Map of token mint → MultiDexToken (only tokens on 2+ DEXes)
pub type MultiDexMap = HashMap<Pubkey, MultiDexToken>;
