use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, RwLock};
use tracing::{info, warn};
use crate::types::PriceSnapshot;
use crate::price::PriceCache;
use crate::tokens::TokenRegistry;

/// USDC mint for quote denomination
const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/// 1 SOL in lamports for quote amount
const QUOTE_AMOUNT: u64 = 1_000_000_000;

pub struct JupiterPoller {
    cache: Arc<RwLock<PriceCache>>,
    tx: broadcast::Sender<PriceSnapshot>,
    client: reqwest::Client,
    registry: Arc<TokenRegistry>,
}

impl JupiterPoller {
    pub fn new(
        cache: Arc<RwLock<PriceCache>>,
        tx: broadcast::Sender<PriceSnapshot>,
        registry: Arc<TokenRegistry>,
    ) -> Self {
        Self {
            cache,
            tx,
            client: reqwest::Client::new(),
            registry,
        }
    }

    pub async fn run(self, interval_ms: u64) {
        let mut backoff_ms: u64 = 0;

        loop {
            if backoff_ms > 0 {
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            }

            let mut success = false;
            for token in self.registry.all() {
                let name = &token.symbol;
                let mint = &token.mint;

                if mint == USDC_MINT {
                    // USDC is always $1
                    let snapshot = PriceSnapshot {
                        mint: name.to_string(),
                        price_usdc: 1.0,
                        source: "jupiter".into(),
                        timestamp: Instant::now(),
                    };
                    self.cache.write().await.update(&snapshot);
                    let _ = self.tx.send(snapshot);
                    continue;
                }

                match self.fetch_price(mint).await {
                    Ok(price) => {
                        let snapshot = PriceSnapshot {
                            mint: name.to_string(),
                            price_usdc: price,
                            source: "jupiter".into(),
                            timestamp: Instant::now(),
                        };
                        info!("{} = ${:.4} (jupiter)", name, price);
                        self.cache.write().await.update(&snapshot);
                        let _ = self.tx.send(snapshot);
                        success = true;
                    }
                    Err(e) => {
                        warn!("Jupiter quote failed for {}: {}", name, e);
                    }
                }
            }

            if success {
                backoff_ms = 0;
            } else {
                backoff_ms = (backoff_ms * 2).max(1000).min(30_000);
                warn!("All Jupiter quotes failed, backing off {}ms", backoff_ms);
            }

            // Mark stale prices
            {
                let mut cache = self.cache.write().await;
                cache.mark_stale("jupiter", Duration::from_secs(5));
            }

            tokio::time::sleep(Duration::from_millis(interval_ms)).await;
        }
    }

    async fn fetch_price(&self, mint: &str) -> anyhow::Result<f64> {
        let url = format!(
            "https://public.jupiterapi.com/quote?inputMint={}&outputMint={}&amount={}&slippageBps=50",
            mint, USDC_MINT, QUOTE_AMOUNT
        );

        let mut req = self.client.get(&url).timeout(Duration::from_secs(5));
        if let Ok(key) = std::env::var("JUPITER_API_KEY") {
            req = req.header("x-api-key", key);
        }
        let resp = req.send().await?;

        if resp.status() == 429 {
            return Err(anyhow::anyhow!("Rate limited"));
        }

        let body: serde_json::Value = resp.json().await?;
        let out_amount = body["outAmount"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing outAmount"))?
            .parse::<f64>()?;

        // outAmount is in USDC (6 decimals), input was 1 SOL equivalent
        let price = out_amount / 1_000_000.0;
        Ok(price)
    }
}
