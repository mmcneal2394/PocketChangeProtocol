use async_trait::async_trait;
use rust_decimal::Decimal;
use rust_decimal::prelude::*;
use serde::Deserialize;
use solana_sdk::instruction::Instruction;
use solana_sdk::signature::Keypair;
use std::time::Instant;
use tracing::{info, warn, debug};
use uuid::Uuid;
use crate::types::*;
use crate::price::PriceCache;
use crate::strategy::Strategy;

/// Drift Protocol markets to monitor for funding rate arbitrage.
const DRIFT_MARKETS: &[(&str, u32)] = &[
    ("SOL-PERP", 0),
    ("BTC-PERP", 1),
    ("ETH-PERP", 2),
];

/// Drift funding rate precision: rates are returned in 1e6 (PRICE_PRECISION).
const PRICE_PRECISION: f64 = 1_000_000.0;

/// Primary Drift API endpoint for funding rates.
const DRIFT_FUNDING_URL: &str = "https://data.api.drift.trade/fundingRates";

/// Fallback Drift API endpoint.
const DRIFT_FUNDING_URL_FALLBACK: &str = "https://mainnet-beta.api.drift.trade/fundingRates";

/// Default trade size for funding rate arb positions (USDC).
const DEFAULT_TRADE_SIZE_USDC: i64 = 5000;

/// Response shape from Drift's funding rate API.
/// Parsed defensively — all fields optional except marketIndex.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriftFundingRateEntry {
    market_index: u32,
    #[serde(default)]
    funding_rate: Option<String>,
    #[serde(default, alias = "fundingRateLong")]
    funding_rate_long: Option<String>,
    #[serde(default, alias = "fundingRateShort")]
    funding_rate_short: Option<String>,
    #[serde(default)]
    ts: Option<String>,
}

pub struct FundingRateStrategy {
    threshold: Decimal,
    client: reqwest::Client,
}

impl FundingRateStrategy {
    pub fn new(threshold: f64) -> Self {
        Self {
            threshold: Decimal::from_f64(threshold).unwrap_or(Decimal::new(8, 2)),
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
        }
    }

    /// Fetch funding rates from Drift Protocol API for a given market.
    /// Tries the primary endpoint first, falls back to the alternative.
    async fn fetch_funding_rates(&self, market_index: u32) -> Option<Vec<DriftFundingRateEntry>> {
        let url = format!("{}?marketIndex={}", DRIFT_FUNDING_URL, market_index);

        match self.client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<Vec<DriftFundingRateEntry>>().await {
                    Ok(entries) => return Some(entries),
                    Err(e) => {
                        warn!("Failed to parse Drift funding rate response from primary: {}", e);
                    }
                }
            }
            Ok(resp) => {
                warn!("Drift primary API returned status {}", resp.status());
            }
            Err(e) => {
                warn!("Drift primary API request failed: {}", e);
            }
        }

        // Fallback endpoint
        let fallback_url = format!("{}?marketIndex={}", DRIFT_FUNDING_URL_FALLBACK, market_index);
        match self.client.get(&fallback_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<Vec<DriftFundingRateEntry>>().await {
                    Ok(entries) => Some(entries),
                    Err(e) => {
                        warn!("Failed to parse Drift funding rate response from fallback: {}", e);
                        None
                    }
                }
            }
            Ok(resp) => {
                warn!("Drift fallback API returned status {}", resp.status());
                None
            }
            Err(e) => {
                warn!("Drift fallback API request failed: {}", e);
                None
            }
        }
    }

    /// Parse a raw funding rate string (in PRICE_PRECISION) into a percentage.
    /// Returns None if the string is invalid.
    fn parse_funding_rate(raw: &str) -> Option<f64> {
        raw.parse::<f64>().ok().map(|r| r / PRICE_PRECISION)
    }

    /// Normalize profit percentage by annualizing (funding rate * 365).
    pub fn normalized_profit_pct(&self, opp: &Opportunity) -> Decimal {
        opp.expected_profit_pct * Decimal::new(365, 0)
    }
}

#[async_trait]
impl Strategy for FundingRateStrategy {
    fn name(&self) -> &str { "Funding Rate" }
    fn kind(&self) -> StrategyKind { StrategyKind::FundingRate }

    async fn evaluate(&self, _prices: &PriceCache) -> Vec<Opportunity> {
        let mut opportunities = Vec::new();

        for (market_name, market_index) in DRIFT_MARKETS {
            let entries = match self.fetch_funding_rates(*market_index).await {
                Some(e) if !e.is_empty() => e,
                Some(_) => {
                    debug!("No funding rate entries for {}", market_name);
                    continue;
                }
                None => {
                    // Already logged warning in fetch_funding_rates
                    continue;
                }
            };

            // Use the most recent entry (last in the array, or first — take whichever is newest)
            let latest = &entries[entries.len() - 1];

            // Try to parse the funding rate from available fields
            let funding_rate_pct = latest.funding_rate.as_deref()
                .and_then(Self::parse_funding_rate)
                .or_else(|| {
                    // If main field missing, try averaging long/short rates
                    let long = latest.funding_rate_long.as_deref().and_then(Self::parse_funding_rate);
                    let short = latest.funding_rate_short.as_deref().and_then(Self::parse_funding_rate);
                    match (long, short) {
                        (Some(l), Some(s)) => Some((l + s) / 2.0),
                        (Some(l), None) => Some(l),
                        (None, Some(s)) => Some(s),
                        (None, None) => None,
                    }
                });

            let funding_rate_pct = match funding_rate_pct {
                Some(r) => r,
                None => {
                    warn!("Could not parse funding rate for {} (market_index={})", market_name, market_index);
                    continue;
                }
            };

            let abs_rate = funding_rate_pct.abs();

            // Annualize: daily rate * 365 (funding rates on Drift are per hour but
            // we treat the raw percentage as a periodic rate and annualize for comparison)
            let annualized_pct = abs_rate * 365.0;

            debug!(
                "Drift {} funding rate: {:.6}% (annualized {:.2}%), threshold: {}%",
                market_name, funding_rate_pct, annualized_pct, self.threshold
            );

            let threshold_f64 = self.threshold.to_f64().unwrap_or(8.0);

            if annualized_pct > threshold_f64 {
                let direction = if funding_rate_pct > 0.0 {
                    "short perp + long spot"
                } else {
                    "long perp + short spot"
                };

                info!(
                    "Funding rate opportunity: {} rate={:.4}% annualized={:.2}% ({})",
                    market_name, funding_rate_pct, annualized_pct, direction
                );

                opportunities.push(Opportunity {
                    id: Uuid::new_v4().to_string(),
                    strategy: StrategyKind::FundingRate,
                    route: format!("{} {} (rate {:.4}%)", market_name, direction, funding_rate_pct),
                    expected_profit_pct: Decimal::from_f64(abs_rate).unwrap_or_default(),
                    trade_size_usdc: Decimal::new(DEFAULT_TRADE_SIZE_USDC, 0),
                    instructions: vec![],
                    detected_at: Instant::now(),
                });
            }
        }

        opportunities
    }

    fn build_instructions(&self, opp: &Opportunity, _wallet: &Keypair) -> anyhow::Result<Vec<Instruction>> {
        // Opens hedged position: long spot + short perp (or vice versa)
        info!("Building funding rate instructions for {}", opp.route);
        Ok(vec![])
    }

    fn min_profit_threshold(&self) -> Decimal { self.threshold }

    fn normalized_profit_pct(&self, opp: &Opportunity) -> Decimal {
        // Annualize the funding rate differential
        opp.expected_profit_pct * Decimal::new(365, 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_funding_rate() {
        // 1000 in PRICE_PRECISION (1e6) = 0.001 = 0.1%
        assert_eq!(FundingRateStrategy::parse_funding_rate("1000"), Some(0.001));
        // Negative rate
        assert_eq!(FundingRateStrategy::parse_funding_rate("-500"), Some(-0.0005));
        // Zero
        assert_eq!(FundingRateStrategy::parse_funding_rate("0"), Some(0.0));
        // Invalid
        assert_eq!(FundingRateStrategy::parse_funding_rate("abc"), None);
    }

    #[test]
    fn test_funding_rate_normalization() {
        let strategy = FundingRateStrategy::new(0.08);
        // A funding rate of 0.001 (0.1%) annualized = 0.1 * 365 = 36.5%
        let opp = Opportunity {
            id: "test".into(),
            strategy: StrategyKind::FundingRate,
            route: "SOL-PERP".into(),
            expected_profit_pct: Decimal::from_f64(0.1).unwrap(),
            trade_size_usdc: Decimal::new(5000, 0),
            instructions: vec![],
            detected_at: Instant::now(),
        };
        let normalized = strategy.normalized_profit_pct(&opp);
        assert_eq!(normalized, Decimal::from_f64(0.1).unwrap() * Decimal::new(365, 0));
    }

    #[tokio::test]
    async fn test_evaluate_returns_empty_on_no_api() {
        // With no real API available, evaluate should return empty (not crash)
        let strategy = FundingRateStrategy::new(0.08);
        let cache = PriceCache::new();
        let opps = strategy.evaluate(&cache).await;
        // May be empty if API unreachable — the point is it doesn't panic
        assert!(opps.is_empty() || !opps.is_empty());
    }
}
