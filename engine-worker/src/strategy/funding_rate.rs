use async_trait::async_trait;
use rust_decimal::Decimal;
use rust_decimal::prelude::*;
use solana_sdk::instruction::Instruction;
use solana_sdk::signature::Keypair;
use tracing::info;
use crate::types::*;
use crate::price::PriceCache;
use crate::strategy::Strategy;

pub struct FundingRateStrategy {
    threshold: Decimal,
}

impl FundingRateStrategy {
    pub fn new(threshold: f64) -> Self {
        Self {
            threshold: Decimal::from_f64(threshold).unwrap_or(Decimal::new(8, 2)),
        }
    }
}

#[async_trait]
impl Strategy for FundingRateStrategy {
    fn name(&self) -> &str { "Funding Rate" }
    fn kind(&self) -> StrategyKind { StrategyKind::FundingRate }

    async fn evaluate(&self, _prices: &PriceCache) -> Vec<Opportunity> {
        // TODO: Fetch Drift Protocol funding rates via REST API
        // Compare perp funding rate vs spot yield
        // Flag when differential exceeds threshold
        // For now, return empty — requires Drift API integration
        vec![]
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
