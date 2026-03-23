use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, RwLock};
use tracing::{info, warn};
use crate::types::PriceSnapshot;
use crate::price::PriceCache;

/// Token mints to poll
const MINTS: &[(&str, &str)] = &[
    ("SOL", "So11111111111111111111111111111111111111112"),
    ("USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    ("RAY", "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"),
    ("BONK", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
    ("JitoSOL", "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"),
    ("mSOL", "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"),
    ("WIF", "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"),
];

/// USDC mint for quote denomination
const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/// 1 SOL in lamports for quote amount
const QUOTE_AMOUNT: u64 = 1_000_000_000;

pub struct JupiterPoller {
    cache: Arc<RwLock<PriceCache>>,
    tx: broadcast::Sender<PriceSnapshot>,
    client: reqwest::Client,
}

impl JupiterPoller {
    pub fn new(cache: Arc<RwLock<PriceCache>>, tx: broadcast::Sender<PriceSnapshot>) -> Self {
        Self {
            cache,
            tx,
            client: reqwest::Client::new(),
        }
    }

    pub async fn run(self, interval_ms: u64) {
        let mut backoff_ms: u64 = 0;

        loop {
            if backoff_ms > 0 {
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
            }

            let mut success = false;
            for (name, mint) in MINTS.iter() {
                if *mint == USDC_MINT {
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

        let resp = self
            .client
            .get(&url)
            .timeout(Duration::from_secs(5))
            .send()
            .await?;

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
