use serde::Deserialize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;
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
    tokens: RwLock<Vec<WatchedToken>>,
    api_base: String,
    last_refresh: RwLock<Instant>,
    refresh_interval: Duration,
}

impl TokenRegistry {
    pub fn new(api_base: &str) -> Self {
        Self {
            tokens: RwLock::new(Vec::new()),
            api_base: api_base.to_string(),
            last_refresh: RwLock::new(Instant::now() - Duration::from_secs(9999)),
            refresh_interval: Duration::from_secs(600), // 10 minutes
        }
    }

    pub async fn load_from_api(api_base: &str) -> Self {
        let registry = Self::new(api_base);
        registry.refresh().await;
        registry
    }

    /// Refresh token list from API if stale
    async fn refresh_if_needed(&self) {
        let last = *self.last_refresh.read().await;
        if last.elapsed() >= self.refresh_interval {
            self.refresh().await;
        }
    }

    /// Force refresh from API
    pub async fn refresh(&self) {
        let url = format!("{}/api/watched-tokens", self.api_base);
        let client = reqwest::Client::new();

        match client.get(&url).timeout(Duration::from_secs(5)).send().await {
            Ok(resp) => {
                match resp.json::<Vec<WatchedToken>>().await {
                    Ok(tokens) => {
                        info!("Refreshed token registry: {} tokens from DB", tokens.len());
                        *self.tokens.write().await = tokens;
                        *self.last_refresh.write().await = Instant::now();
                    }
                    Err(e) => {
                        warn!("Failed to parse token list: {}", e);
                        self.ensure_defaults().await;
                    }
                }
            }
            Err(e) => {
                warn!("Failed to load tokens from API: {}", e);
                self.ensure_defaults().await;
            }
        }
    }

    /// Only set defaults if we have zero tokens (don't overwrite a good list)
    async fn ensure_defaults(&self) {
        if self.tokens.read().await.is_empty() {
            warn!("Using fallback default token list");
            *self.tokens.write().await = Self::default_tokens();
        }
    }

    fn default_tokens() -> Vec<WatchedToken> {
        vec![
            WatchedToken { symbol: "SOL".into(), mint: "So11111111111111111111111111111111111111112".into(), decimals: 9, strategies: "all".into() },
            WatchedToken { symbol: "USDC".into(), mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v".into(), decimals: 6, strategies: "all".into() },
            WatchedToken { symbol: "RAY".into(), mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R".into(), decimals: 6, strategies: "all".into() },
            WatchedToken { symbol: "BONK".into(), mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263".into(), decimals: 5, strategies: "all".into() },
            WatchedToken { symbol: "JitoSOL".into(), mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn".into(), decimals: 9, strategies: "all".into() },
            WatchedToken { symbol: "mSOL".into(), mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So".into(), decimals: 9, strategies: "all".into() },
            WatchedToken { symbol: "WIF".into(), mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm".into(), decimals: 6, strategies: "all".into() },
        ]
    }

    pub fn new_with_defaults() -> Self {
        let registry = Self::new("http://localhost:3000");
        // Bypass async — set defaults directly for tests
        let tokens = Self::default_tokens();
        let rt = tokio::runtime::Handle::try_current();
        if let Ok(handle) = rt {
            let t = registry.tokens.clone();
            handle.spawn(async move {
                *t.write().await = tokens;
            });
        }
        registry
    }

    /// Spawn background refresh task
    pub fn spawn_refresh_task(self: &Arc<Self>) {
        let registry = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(600)).await;
                registry.refresh().await;
            }
        });
    }

    pub async fn all(&self) -> Vec<WatchedToken> {
        self.refresh_if_needed().await;
        self.tokens.read().await.clone()
    }

    pub async fn for_strategy(&self, strategy: &str) -> Vec<WatchedToken> {
        self.refresh_if_needed().await;
        self.tokens.read().await.iter()
            .filter(|t| t.supports_strategy(strategy))
            .cloned()
            .collect()
    }

    pub async fn resolve_mint(&self, symbol: &str) -> Option<String> {
        self.tokens.read().await.iter()
            .find(|t| t.symbol == symbol)
            .map(|t| t.mint.clone())
    }

    pub async fn resolve_decimals(&self, symbol: &str) -> u32 {
        self.tokens.read().await.iter()
            .find(|t| t.symbol == symbol)
            .map(|t| t.decimals as u32)
            .unwrap_or(6)
    }
}
