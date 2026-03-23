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

const ESTIMATED_FEE_PCT: f64 = 0.3;

pub struct FlashLoanStrategy {
    threshold: Decimal,
    vault_available: bool,
}

impl FlashLoanStrategy {
    pub fn new(threshold: f64, vault_available: bool) -> Self {
        Self {
            threshold: Decimal::from_f64(threshold).unwrap_or(Decimal::new(3, 1)),
            vault_available,
        }
    }
}

#[async_trait]
impl Strategy for FlashLoanStrategy {
    fn name(&self) -> &str { "Flash Loan" }
    fn kind(&self) -> StrategyKind { StrategyKind::FlashLoan }

    async fn evaluate(&self, prices: &PriceCache) -> Vec<Opportunity> {
        if !self.vault_available {
            return vec![];
        }

        let mut opportunities = Vec::new();

        // Check USDC -> token -> USDC routes via Jupiter
        let usdc_price = prices.get_price("USDC").unwrap_or(1.0);
        let sol_price = match prices.get_price("SOL") {
            Some(p) if p > 0.0 => p,
            _ => return vec![],
        };

        // Look for price discrepancies across available tokens
        let tokens = ["RAY", "BONK", "WIF", "mSOL", "JitoSOL"];
        for token in &tokens {
            let token_price = match prices.get_price(token) {
                Some(p) if p > 0.0 => p,
                _ => continue,
            };

            // Simulate: borrow USDC -> buy token -> sell token for USDC
            // If we can get more USDC back than we borrowed, it's profitable
            let round_trip = usdc_price / token_price * token_price / usdc_price;
            let profit_pct = (round_trip - 1.0) * 100.0;
            let net_profit = profit_pct - ESTIMATED_FEE_PCT;

            if net_profit > self.threshold.to_f64().unwrap_or(0.3) {
                debug!("Flash loan opportunity: USDC -> {} -> USDC: {:.4}%", token, net_profit);
                opportunities.push(Opportunity {
                    id: Uuid::new_v4().to_string(),
                    strategy: StrategyKind::FlashLoan,
                    route: format!("USDC -> {} -> USDC (flash loan)", token),
                    expected_profit_pct: Decimal::from_f64(net_profit).unwrap_or_default(),
                    trade_size_usdc: Decimal::new(10000, 0), // 10,000 USDC from vault
                    instructions: vec![],
                    detected_at: Instant::now(),
                });
            }
        }

        opportunities
    }

    fn build_instructions(&self, opp: &Opportunity, _wallet: &Keypair) -> anyhow::Result<Vec<Instruction>> {
        if !self.vault_available {
            return Err(anyhow::anyhow!("Vault program not available"));
        }
        // In production: use VaultExecutor::build_vault_ptb() to assemble
        // borrow_for_arbitrage -> Jupiter swaps -> process_arbitrage
        info!("Building flash loan instructions for {}", opp.route);
        Ok(vec![])
    }

    fn min_profit_threshold(&self) -> Decimal { self.threshold }

    fn normalized_profit_pct(&self, opp: &Opportunity) -> Decimal {
        opp.expected_profit_pct
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_disabled_when_vault_unavailable() {
        let cache = PriceCache::new();
        let strategy = FlashLoanStrategy::new(0.3, false);
        let opps = strategy.evaluate(&cache).await;
        assert!(opps.is_empty());
    }

    #[tokio::test]
    async fn test_no_opportunity_when_prices_balanced() {
        let mut cache = PriceCache::new();
        cache.update(&PriceSnapshot { mint: "SOL".into(), price_usdc: 150.0, source: "jupiter".into(), timestamp: Instant::now() });
        cache.update(&PriceSnapshot { mint: "USDC".into(), price_usdc: 1.0, source: "jupiter".into(), timestamp: Instant::now() });
        cache.update(&PriceSnapshot { mint: "RAY".into(), price_usdc: 2.0, source: "jupiter".into(), timestamp: Instant::now() });

        let strategy = FlashLoanStrategy::new(0.3, true);
        let opps = strategy.evaluate(&cache).await;
        assert!(opps.is_empty()); // Balanced = no profit
    }
}
