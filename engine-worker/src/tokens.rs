use serde::Deserialize;
use tracing::{info, warn};

#[derive(Debug, Clone, Deserialize)]
pub struct WatchedToken {
    pub symbol: String,
    pub mint: String,
    pub decimals: i32,
    pub strategies: String,
}

impl WatchedToken {
    pub fn supports_strategy(&self, strategy: &str) -> bool {
        self.strategies == "all" || self.strategies.contains(strategy)
    }
}

pub struct TokenRegistry {
    tokens: Vec<WatchedToken>,
}

impl TokenRegistry {
    pub fn new() -> Self {
        Self { tokens: Vec::new() }
    }

    pub async fn load_from_api(api_base: &str) -> Self {
        let url = format!("{}/api/watched-tokens", api_base);
        let client = reqwest::Client::new();

        match client.get(&url).send().await {
            Ok(resp) => {
                match resp.json::<Vec<WatchedToken>>().await {
                    Ok(tokens) => {
                        info!("Loaded {} watched tokens from DB", tokens.len());
                        Self { tokens }
                    }
                    Err(e) => {
                        warn!("Failed to parse token list: {} — using defaults", e);
                        Self::defaults()
                    }
                }
            }
            Err(e) => {
                warn!("Failed to load tokens from API: {} — using defaults", e);
                Self::defaults()
            }
        }
    }

    fn defaults() -> Self {
        // Fallback hardcoded list if API is unreachable
        let tokens = vec![
            WatchedToken { symbol: "SOL".into(), mint: "So11111111111111111111111111111111111111112".into(), decimals: 9, strategies: "all".into() },
            WatchedToken { symbol: "USDC".into(), mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".into(), decimals: 6, strategies: "all".into() },
            WatchedToken { symbol: "RAY".into(), mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R".into(), decimals: 6, strategies: "all".into() },
            WatchedToken { symbol: "BONK".into(), mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263".into(), decimals: 5, strategies: "all".into() },
            WatchedToken { symbol: "JitoSOL".into(), mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn".into(), decimals: 9, strategies: "all".into() },
            WatchedToken { symbol: "mSOL".into(), mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So".into(), decimals: 9, strategies: "all".into() },
            WatchedToken { symbol: "WIF".into(), mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm".into(), decimals: 6, strategies: "all".into() },
        ];
        Self { tokens }
    }

    /// Create a registry with the hardcoded default tokens (useful for tests).
    pub fn new_with_defaults() -> Self {
        Self::defaults()
    }

    pub fn all(&self) -> &[WatchedToken] {
        &self.tokens
    }

    pub fn for_strategy(&self, strategy: &str) -> Vec<&WatchedToken> {
        self.tokens.iter().filter(|t| t.supports_strategy(strategy)).collect()
    }

    pub fn resolve_mint(&self, symbol: &str) -> Option<&str> {
        self.tokens.iter().find(|t| t.symbol == symbol).map(|t| t.mint.as_str())
    }

    pub fn resolve_decimals(&self, symbol: &str) -> u32 {
        self.tokens.iter().find(|t| t.symbol == symbol).map(|t| t.decimals as u32).unwrap_or(6)
    }
}
