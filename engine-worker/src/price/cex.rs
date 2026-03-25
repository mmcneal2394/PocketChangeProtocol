use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, RwLock};
use tracing::{info, warn};
use crate::types::PriceSnapshot;
use crate::price::PriceCache;

const PAIRS: &[(&str, &str)] = &[
    ("SOL", "SOLUSDT"),
    ("RAY", "RAYUSDT"),
    ("BONK", "BONKUSDT"),
    ("WIF", "WIFUSDT"),
];

// ---------------------------------------------------------------------------
// Per-exchange configuration (public ticker endpoints — no API key needed)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum ExchangeKind {
    Mexc,
    Gate,
    KuCoin,
}

impl ExchangeKind {
    fn source_id(&self) -> &'static str {
        match self {
            ExchangeKind::Mexc => "mexc",
            ExchangeKind::Gate => "gate",
            ExchangeKind::KuCoin => "kucoin",
        }
    }

    fn label(&self) -> &'static str {
        match self {
            ExchangeKind::Mexc => "MEXC",
            ExchangeKind::Gate => "Gate.io",
            ExchangeKind::KuCoin => "KuCoin",
        }
    }
}

struct ExchangeFeed {
    kind: ExchangeKind,
    base_url: String,
}

// ---------------------------------------------------------------------------
// MultiCexPoller — polls public ticker endpoints on all configured exchanges
// ---------------------------------------------------------------------------

pub struct MultiCexPoller {
    cache: Arc<RwLock<PriceCache>>,
    tx: broadcast::Sender<PriceSnapshot>,
    client: reqwest::Client,
    feeds: Vec<ExchangeFeed>,
}

impl MultiCexPoller {
    /// Build the poller. Enables each exchange if the corresponding env var is
    /// set (even if empty) OR unconditionally — public endpoints need no key.
    /// We check env vars so operators can selectively disable an exchange by
    /// *not* setting MEXC_ENABLED / GATE_ENABLED / KUCOIN_ENABLED.
    /// Default: all three enabled.
    pub fn new(
        cache: Arc<RwLock<PriceCache>>,
        tx: broadcast::Sender<PriceSnapshot>,
    ) -> Self {
        let mut feeds = Vec::new();

        let mexc_disabled = std::env::var("MEXC_DISABLED").map(|v| v == "1" || v == "true").unwrap_or(false);
        let gate_disabled = std::env::var("GATE_DISABLED").map(|v| v == "1" || v == "true").unwrap_or(false);
        let kucoin_disabled = std::env::var("KUCOIN_DISABLED").map(|v| v == "1" || v == "true").unwrap_or(false);

        if !mexc_disabled {
            feeds.push(ExchangeFeed {
                kind: ExchangeKind::Mexc,
                base_url: "https://api.mexc.com".to_string(),
            });
            info!("MEXC price feed enabled");
        }
        if !gate_disabled {
            feeds.push(ExchangeFeed {
                kind: ExchangeKind::Gate,
                base_url: "https://api.gateio.ws".to_string(),
            });
            info!("Gate.io price feed enabled");
        }
        if !kucoin_disabled {
            feeds.push(ExchangeFeed {
                kind: ExchangeKind::KuCoin,
                base_url: "https://api.kucoin.com".to_string(),
            });
            info!("KuCoin price feed enabled");
        }

        if feeds.is_empty() {
            warn!("All CEX price feeds disabled");
        }

        Self {
            cache,
            tx,
            client: reqwest::Client::new(),
            feeds,
        }
    }

    pub fn has_feeds(&self) -> bool {
        !self.feeds.is_empty()
    }

    pub async fn run(self, interval_ms: u64) {
        let mut backoffs: Vec<u64> = vec![0; self.feeds.len()];

        loop {
            for (i, feed) in self.feeds.iter().enumerate() {
                if backoffs[i] > 0 {
                    // Skip this feed until backoff expires (checked per-tick)
                    backoffs[i] = backoffs[i].saturating_sub(interval_ms);
                    continue;
                }

                match self.fetch_tickers(feed).await {
                    Ok(prices) => {
                        backoffs[i] = 0;
                        for (name, price) in prices {
                            let snapshot = PriceSnapshot {
                                mint: name,
                                price_usdc: price,
                                source: feed.kind.source_id().to_string(),
                                timestamp: Instant::now(),
                            };
                            self.cache.write().await.update(&snapshot);
                            let _ = self.tx.send(snapshot);
                        }
                    }
                    Err(e) => {
                        backoffs[i] = (backoffs[i] * 2).max(2000).min(30000);
                        warn!(
                            "{} fetch failed, backing off {}ms: {}",
                            feed.kind.label(),
                            backoffs[i],
                            e
                        );
                    }
                }

                // Mark stale prices from this source after 10s
                {
                    let mut cache = self.cache.write().await;
                    cache.mark_stale(feed.kind.source_id(), Duration::from_secs(10));
                }
            }

            tokio::time::sleep(Duration::from_millis(interval_ms)).await;
        }
    }

    async fn fetch_tickers(&self, feed: &ExchangeFeed) -> anyhow::Result<Vec<(String, f64)>> {
        match feed.kind {
            ExchangeKind::Mexc => self.fetch_mexc(feed).await,
            ExchangeKind::Gate => self.fetch_gate(feed).await,
            ExchangeKind::KuCoin => self.fetch_kucoin(feed).await,
        }
    }

    // -----------------------------------------------------------------------
    // MEXC — GET /api/v3/ticker/price (public, no auth)
    // -----------------------------------------------------------------------
    async fn fetch_mexc(&self, feed: &ExchangeFeed) -> anyhow::Result<Vec<(String, f64)>> {
        let url = format!("{}/api/v3/ticker/price", feed.base_url);
        let resp: Vec<serde_json::Value> = self.client.get(&url)
            .timeout(Duration::from_secs(5))
            .send().await?.json().await?;

        let mut results = Vec::new();
        for (token_name, pair_symbol) in PAIRS {
            if let Some(ticker) = resp.iter().find(|t| t["symbol"].as_str() == Some(pair_symbol)) {
                if let Some(price) = ticker["price"].as_str().and_then(|p| p.parse::<f64>().ok()) {
                    results.push((token_name.to_string(), price));
                }
            }
        }
        Ok(results)
    }

    // -----------------------------------------------------------------------
    // Gate.io — GET /api/v4/spot/tickers (public, no auth)
    // -----------------------------------------------------------------------
    async fn fetch_gate(&self, feed: &ExchangeFeed) -> anyhow::Result<Vec<(String, f64)>> {
        let url = format!("{}/api/v4/spot/tickers", feed.base_url);
        let resp: Vec<serde_json::Value> = self.client.get(&url)
            .timeout(Duration::from_secs(5))
            .send().await?.json().await?;

        let mut results = Vec::new();
        for (token_name, pair_symbol) in PAIRS {
            // Gate uses underscore separator: SOLUSDT -> SOL_USDT
            let gate_symbol = pair_symbol.replace("USDT", "_USDT");
            if let Some(ticker) = resp.iter().find(|t| t["currency_pair"].as_str() == Some(&gate_symbol)) {
                if let Some(price) = ticker["last"].as_str().and_then(|p| p.parse::<f64>().ok()) {
                    results.push((token_name.to_string(), price));
                }
            }
        }
        Ok(results)
    }

    // -----------------------------------------------------------------------
    // KuCoin — GET /api/v1/market/allTickers (public, no auth)
    // -----------------------------------------------------------------------
    async fn fetch_kucoin(&self, feed: &ExchangeFeed) -> anyhow::Result<Vec<(String, f64)>> {
        let url = format!("{}/api/v1/market/allTickers", feed.base_url);
        let resp: serde_json::Value = self.client.get(&url)
            .timeout(Duration::from_secs(5))
            .send().await?.json().await?;

        let tickers = resp["data"]["ticker"].as_array()
            .ok_or_else(|| anyhow::anyhow!("KuCoin missing data.ticker array"))?;

        let mut results = Vec::new();
        for (token_name, pair_symbol) in PAIRS {
            // KuCoin uses dash separator: SOLUSDT -> SOL-USDT
            let kc_symbol = pair_symbol.replace("USDT", "-USDT");
            if let Some(ticker) = tickers.iter().find(|t| t["symbol"].as_str() == Some(&kc_symbol)) {
                if let Some(price) = ticker["last"].as_str().and_then(|p| p.parse::<f64>().ok()) {
                    results.push((token_name.to_string(), price));
                }
            }
        }
        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_exchange_source_ids() {
        assert_eq!(ExchangeKind::Mexc.source_id(), "mexc");
        assert_eq!(ExchangeKind::Gate.source_id(), "gate");
        assert_eq!(ExchangeKind::KuCoin.source_id(), "kucoin");
    }

    #[test]
    fn test_gate_symbol_format() {
        let pair = "SOLUSDT";
        let gate = pair.replace("USDT", "_USDT");
        assert_eq!(gate, "SOL_USDT");
    }

    #[test]
    fn test_kucoin_symbol_format() {
        let pair = "SOLUSDT";
        let kc = pair.replace("USDT", "-USDT");
        assert_eq!(kc, "SOL-USDT");
    }
}
