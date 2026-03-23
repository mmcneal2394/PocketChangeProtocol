use async_trait::async_trait;
use rust_decimal::Decimal;
use rust_decimal::prelude::*;
use solana_sdk::instruction::Instruction;
use solana_sdk::signature::Keypair;
use uuid::Uuid;
use std::collections::VecDeque;
use std::time::Instant;
use tokio::sync::Mutex;
use tracing::debug;
use crate::types::*;
use crate::price::PriceCache;
use crate::strategy::Strategy;

const WINDOW_SIZE: usize = 100;
const HISTORICAL_PCT_PER_Z: f64 = 0.5; // Expected % return per z-score unit

/// Tracked pair for statistical arbitrage
struct PairState {
    token_a: String,
    token_b: String,
    ratios: VecDeque<f64>,
}

impl PairState {
    fn new(a: &str, b: &str) -> Self {
        Self {
            token_a: a.into(),
            token_b: b.into(),
            ratios: VecDeque::with_capacity(WINDOW_SIZE + 1),
        }
    }

    fn push_ratio(&mut self, ratio: f64) {
        self.ratios.push_back(ratio);
        if self.ratios.len() > WINDOW_SIZE {
            self.ratios.pop_front();
        }
    }

    fn z_score(&self) -> Option<f64> {
        if self.ratios.len() < 20 {
            return None; // Need minimum data
        }
        let n = self.ratios.len() as f64;
        let mean: f64 = self.ratios.iter().sum::<f64>() / n;
        let variance: f64 = self.ratios.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / n;
        let std_dev = variance.sqrt();
        if std_dev < 1e-10 {
            return None;
        }
        let current = *self.ratios.back()?;
        Some((current - mean) / std_dev)
    }
}

pub struct StatisticalStrategy {
    threshold: Decimal,
    pairs: Mutex<Vec<PairState>>,
}

impl StatisticalStrategy {
    pub fn new(threshold: f64) -> Self {
        Self {
            threshold: Decimal::from_f64(threshold).unwrap_or(Decimal::new(2, 0)),
            pairs: Mutex::new(vec![
                PairState::new("SOL", "JitoSOL"),
                PairState::new("SOL", "mSOL"),
            ]),
        }
    }
}

#[async_trait]
impl Strategy for StatisticalStrategy {
    fn name(&self) -> &str { "Statistical" }
    fn kind(&self) -> StrategyKind { StrategyKind::Statistical }

    async fn evaluate(&self, prices: &PriceCache) -> Vec<Opportunity> {
        let mut opportunities = Vec::new();
        let mut pairs = self.pairs.lock().await;

        for pair in pairs.iter_mut() {
            let price_a = match prices.get_price(&pair.token_a) {
                Some(p) if p > 0.0 => p,
                _ => continue,
            };
            let price_b = match prices.get_price(&pair.token_b) {
                Some(p) if p > 0.0 => p,
                _ => continue,
            };

            let ratio = price_a / price_b;
            pair.push_ratio(ratio);

            if let Some(z) = pair.z_score() {
                let z_abs = z.abs();
                let threshold = self.threshold.to_f64().unwrap_or(2.0);

                if z_abs > threshold {
                    let direction = if z > 0.0 {
                        format!("long {} / short {}", pair.token_b, pair.token_a)
                    } else {
                        format!("long {} / short {}", pair.token_a, pair.token_b)
                    };

                    debug!("Stat arb: {}/{} z={:.2} -> {}", pair.token_a, pair.token_b, z, direction);

                    opportunities.push(Opportunity {
                        id: Uuid::new_v4().to_string(),
                        strategy: StrategyKind::Statistical,
                        route: format!("{}/{} {} (z={:.2})", pair.token_a, pair.token_b, direction, z),
                        expected_profit_pct: Decimal::from_f64(z_abs * HISTORICAL_PCT_PER_Z)
                            .unwrap_or_default(),
                        trade_size_usdc: Decimal::new(1000, 0),
                        instructions: vec![],
                        detected_at: Instant::now(),
                    });
                }
            }
        }

        opportunities
    }

    fn build_instructions(&self, opp: &Opportunity, _wallet: &Keypair) -> anyhow::Result<Vec<Instruction>> {
        tracing::info!("Building stat arb instructions for {}", opp.route);
        Ok(vec![])
    }

    fn min_profit_threshold(&self) -> Decimal { self.threshold }

    fn normalized_profit_pct(&self, opp: &Opportunity) -> Decimal {
        opp.expected_profit_pct // Already converted from z-score * pct_per_z
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_z_score_calculation() {
        let mut pair = PairState::new("SOL", "JitoSOL");
        // Push 20 values with slight variance so std_dev > 0
        for i in 0..20 {
            pair.push_ratio(1.0 + (i as f64) * 0.0001);
        }
        // Push one more value near the mean
        pair.push_ratio(1.001);
        let z = pair.z_score().unwrap();
        assert!(z.abs() < 1.0, "Near-mean value should have small z: got {}", z);

        // Push an outlier well above the mean
        pair.push_ratio(1.1);
        let z = pair.z_score().unwrap();
        assert!(z > 1.0, "Outlier should produce positive z-score: got {}", z);
    }

    #[test]
    fn test_insufficient_data_returns_none() {
        let mut pair = PairState::new("SOL", "JitoSOL");
        for _ in 0..10 {
            pair.push_ratio(1.0);
        }
        assert!(pair.z_score().is_none()); // Need at least 20
    }
}
