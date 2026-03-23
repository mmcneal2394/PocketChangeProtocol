use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, RwLock};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use tracing::warn;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use crate::types::PriceSnapshot;
use crate::price::PriceCache;

type HmacSha256 = Hmac<Sha256>;

const PAIRS: &[(&str, &str)] = &[
    ("SOL", "SOLUSDT"),
    ("RAY", "RAYUSDT"),
    ("BONK", "BONKUSDT"),
    ("WIF", "WIFUSDT"),
];

pub struct BitgetPoller {
    cache: Arc<RwLock<PriceCache>>,
    tx: broadcast::Sender<PriceSnapshot>,
    client: reqwest::Client,
    api_key: String,
    api_secret: String,
    passphrase: String,
}

impl BitgetPoller {
    pub fn new(
        cache: Arc<RwLock<PriceCache>>,
        tx: broadcast::Sender<PriceSnapshot>,
        api_key: String,
        api_secret: String,
        passphrase: String,
    ) -> Self {
        Self {
            cache,
            tx,
            client: reqwest::Client::new(),
            api_key,
            api_secret,
            passphrase,
        }
    }

    pub fn from_env(cache: Arc<RwLock<PriceCache>>, tx: broadcast::Sender<PriceSnapshot>) -> Option<Self> {
        let api_key = std::env::var("BITGET_API_KEY").ok()?;
        let api_secret = std::env::var("BITGET_API_SECRET").ok()?;
        let passphrase = std::env::var("BITGET_PASSPHRASE").ok()?;
        Some(Self::new(cache, tx, api_key, api_secret, passphrase))
    }

    pub fn sign(timestamp: &str, method: &str, path: &str, body: &str, secret: &str) -> String {
        let message = format!("{}{}{}{}", timestamp, method, path, body);
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
            .expect("HMAC key length");
        mac.update(message.as_bytes());
        B64.encode(mac.finalize().into_bytes())
    }

    pub async fn run(self, interval_ms: u64) {
        let mut backoff_ms: u64 = 0;

        loop {
            if backoff_ms > 0 {
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            }

            match self.fetch_tickers().await {
                Ok(prices) => {
                    backoff_ms = 0;
                    for (name, price) in prices {
                        let snapshot = PriceSnapshot {
                            mint: name,
                            price_usdc: price,
                            source: "bitget".to_string(),
                            timestamp: Instant::now(),
                        };
                        self.cache.write().await.update(&snapshot);
                        let _ = self.tx.send(snapshot);
                    }
                }
                Err(e) => {
                    backoff_ms = (backoff_ms * 2).max(2000).min(30000);
                    warn!("Bitget fetch failed, backing off {}ms: {}", backoff_ms, e);
                }
            }

            // Mark stale after 10s
            {
                let mut cache = self.cache.write().await;
                cache.mark_stale("bitget", Duration::from_secs(10));
            }

            tokio::time::sleep(Duration::from_millis(interval_ms)).await;
        }
    }

    async fn fetch_tickers(&self) -> anyhow::Result<Vec<(String, f64)>> {
        let path = "/api/v2/spot/market/tickers";
        let url = format!("https://api.bitget.com{}", path);
        let timestamp = chrono::Utc::now().timestamp_millis().to_string();
        let signature = Self::sign(&timestamp, "GET", path, "", &self.api_secret);

        let resp = self.client.get(&url)
            .header("ACCESS-KEY", &self.api_key)
            .header("ACCESS-SIGN", &signature)
            .header("ACCESS-TIMESTAMP", &timestamp)
            .header("ACCESS-PASSPHRASE", &self.passphrase)
            .header("Content-Type", "application/json")
            .timeout(Duration::from_secs(5))
            .send()
            .await?;

        if resp.status() == 429 {
            return Err(anyhow::anyhow!("Rate limited"));
        }

        let body: serde_json::Value = resp.json().await?;
        let data = body["data"].as_array()
            .ok_or_else(|| anyhow::anyhow!("Missing data array"))?;

        let mut results = Vec::new();
        for (token_name, pair_symbol) in PAIRS {
            if let Some(ticker) = data.iter().find(|t| t["symbol"].as_str() == Some(pair_symbol)) {
                if let Some(price_str) = ticker["lastPr"].as_str() {
                    if let Ok(price) = price_str.parse::<f64>() {
                        results.push((token_name.to_string(), price));
                    }
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
    fn test_bitget_hmac_signature() {
        let sig = BitgetPoller::sign("1234567890", "GET", "/api/v2/spot/market/tickers", "", "test_secret");
        assert!(!sig.is_empty());
        // Verify it's valid base64
        B64.decode(&sig).unwrap();
    }
}
