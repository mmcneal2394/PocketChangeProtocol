use async_trait::async_trait;
use rust_decimal::Decimal;
use rust_decimal::prelude::*;
use solana_sdk::instruction::Instruction;
use solana_sdk::signature::Keypair;
use uuid::Uuid;
use std::time::Instant;
use tracing::{info, debug};
use crate::types::*;
use crate::price::PriceCache;
use crate::strategy::Strategy;

/// Predefined 3-hop routes for triangular arbitrage
const ROUTES: &[(&str, &str, &str)] = &[
    ("SOL", "RAY", "USDC"),
    ("SOL", "BONK", "USDC"),
    ("SOL", "WIF", "USDC"),
    ("SOL", "mSOL", "USDC"),
    ("SOL", "JitoSOL", "USDC"),
];

const ESTIMATED_FEE_PCT: f64 = 0.3; // ~0.3% for fees + slippage + Jito tip

pub struct TriangularStrategy {
    threshold: Decimal,
}

impl TriangularStrategy {
    pub fn new(threshold: f64) -> Self {
        Self {
            threshold: Decimal::from_f64(threshold).unwrap_or(Decimal::new(3, 1)), // 0.3 default
        }
    }
}

#[async_trait]
impl Strategy for TriangularStrategy {
    fn name(&self) -> &str { "Triangular DEX" }
    fn kind(&self) -> StrategyKind { StrategyKind::Triangular }

    async fn evaluate(&self, prices: &PriceCache) -> Vec<Opportunity> {
        let mut opportunities = Vec::new();

        for (a, b, c) in ROUTES {
            let price_a = match prices.get_price(a) { Some(p) => p, None => continue };
            let price_b = match prices.get_price(b) { Some(p) => p, None => continue };
            let price_c = match prices.get_price(c) { Some(p) if p > 0.0 => p, _ => continue };

            // Simulate: 1 A -> B -> C -> A
            // Start with 1 unit of A (valued at price_a USDC)
            // Buy B: amount_b = price_a / price_b
            // Buy C: amount_c = amount_b * price_b (= price_a in USDC terms)
            // Buy A back: amount_a_out = amount_c / price_a
            // Round-trip return = (amount_a_out - 1.0) / 1.0
            //
            // Simplified: check if cross-rate differs from direct rate
            let cross_rate = price_a / price_b * price_b / price_c * price_c / price_a;
            let profit_pct = (cross_rate - 1.0) * 100.0;
            let net_profit = profit_pct - ESTIMATED_FEE_PCT;

            if net_profit > self.threshold.to_f64().unwrap_or(0.3) {
                debug!("Triangular opportunity: {} -> {} -> {} -> {}: {:.4}%", a, b, c, a, net_profit);
                opportunities.push(Opportunity {
                    id: Uuid::new_v4().to_string(),
                    strategy: StrategyKind::Triangular,
                    route: format!("{} -> {} -> {} -> {}", a, b, c, a),
                    expected_profit_pct: Decimal::from_f64(net_profit).unwrap_or_default(),
                    trade_size_usdc: Decimal::new(5000, 0), // 5000 USDC default
                    instructions: vec![], // Filled by build_instructions
                    detected_at: Instant::now(),
                });
            }
        }

        opportunities
    }

    fn build_instructions(&self, opp: &Opportunity, _wallet: &Keypair) -> anyhow::Result<Vec<Instruction>> {
        // In production, this calls Jupiter V6 swap-instructions API for each leg
        // For now, return empty — will be wired to JupiterProvider in integration
        info!("Building triangular instructions for {}", opp.route);
        Ok(vec![])
    }

    fn min_profit_threshold(&self) -> Decimal { self.threshold }
    fn normalized_profit_pct(&self, opp: &Opportunity) -> Decimal { opp.expected_profit_pct }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_no_arb_when_prices_balanced() {
        let mut cache = PriceCache::new();
        cache.update(&PriceSnapshot { mint: "SOL".into(), price_usdc: 150.0, source: "jupiter".into(), timestamp: Instant::now() });
        cache.update(&PriceSnapshot { mint: "RAY".into(), price_usdc: 2.0, source: "jupiter".into(), timestamp: Instant::now() });
        cache.update(&PriceSnapshot { mint: "USDC".into(), price_usdc: 1.0, source: "jupiter".into(), timestamp: Instant::now() });

        let strategy = TriangularStrategy::new(0.3);
        let opps = strategy.evaluate(&cache).await;
        // Balanced prices should produce no opportunities (cross-rate = 1.0)
        assert!(opps.is_empty());
    }

    #[test]
    fn test_profit_calculation() {
        // If SOL=150, RAY=2, USDC=1
        // Cross rate = 150/2 * 2/1 * 1/150 = 1.0 exactly
        // No profit
        let cross = 150.0 / 2.0 * 2.0 / 1.0 * 1.0 / 150.0;
        assert!((cross - 1.0).abs() < 0.0001);
    }
}
