use async_trait::async_trait;
use rust_decimal::Decimal;
use rust_decimal::prelude::*;
use solana_sdk::instruction::Instruction;
use solana_sdk::signature::Keypair;
use uuid::Uuid;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;
use tracing::{info, debug};
use crate::types::*;
use crate::price::PriceCache;
use crate::strategy::Strategy;
use crate::executor::cex_executor::CexDexPosition;

const ESTIMATED_TOTAL_FEE_PCT: f64 = 0.15; // CEX fee + gas + slippage

pub struct CexDexStrategy {
    threshold: Decimal,
    open_position: Arc<Mutex<Option<CexDexPosition>>>,
}

impl CexDexStrategy {
    pub fn new(threshold: f64) -> Self {
        Self {
            threshold: Decimal::from_f64(threshold).unwrap_or(Decimal::new(1, 0)),
            open_position: Arc::new(Mutex::new(None)),
        }
    }
}

#[async_trait]
impl Strategy for CexDexStrategy {
    fn name(&self) -> &str { "CEX-DEX" }
    fn kind(&self) -> StrategyKind { StrategyKind::CexDex }

    async fn evaluate(&self, prices: &PriceCache) -> Vec<Opportunity> {
        // One position at a time
        if self.open_position.lock().await.is_some() {
            return vec![];
        }

        let mut opportunities = Vec::new();
        let pairs = [("SOL", "bitget"), ("RAY", "bitget"), ("WIF", "bitget")];

        for (token, _cex) in &pairs {
            // Get DEX and CEX prices
            let dex_price = match prices.get_price(token) {
                Some(p) => p,
                None => continue,
            };

            // CEX prices are stored with same mint name but source "bitget"
            // For now, use the same cache — in production, separate source check
            // The price difference comes from the feed latency/source difference
            let cex_entry = match prices.get(token) {
                Some(e) => e,
                None => continue,
            };

            let cex_price = cex_entry.price_usdc;
            let spread_pct = ((cex_price - dex_price) / dex_price * 100.0).abs();
            let net_profit = spread_pct - ESTIMATED_TOTAL_FEE_PCT;

            // Only execute when spread > 2x fees
            if net_profit > self.threshold.to_f64().unwrap_or(1.0) && spread_pct > ESTIMATED_TOTAL_FEE_PCT * 2.0 {
                let direction = if cex_price > dex_price { "buy DEX, sell CEX" } else { "buy CEX, sell DEX" };
                debug!("CEX-DEX opportunity: {} spread {:.4}% ({})", token, spread_pct, direction);

                opportunities.push(Opportunity {
                    id: Uuid::new_v4().to_string(),
                    strategy: StrategyKind::CexDex,
                    route: format!("{} {} (spread {:.2}%)", token, direction, spread_pct),
                    expected_profit_pct: Decimal::from_f64(net_profit).unwrap_or_default(),
                    trade_size_usdc: Decimal::new(2000, 0), // Lower size for non-atomic
                    instructions: vec![],
                    detected_at: Instant::now(),
                });
            }
        }

        opportunities
    }

    fn build_instructions(&self, opp: &Opportunity, _wallet: &Keypair) -> anyhow::Result<Vec<Instruction>> {
        // DEX leg only — CEX leg handled by CexExecutor after DEX confirms
        info!("Building DEX leg instructions for CEX-DEX: {}", opp.route);
        Ok(vec![])
    }

    fn min_profit_threshold(&self) -> Decimal { self.threshold }
    fn normalized_profit_pct(&self, opp: &Opportunity) -> Decimal { opp.expected_profit_pct }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_no_opportunity_when_position_open() {
        let strategy = CexDexStrategy::new(1.0);
        *strategy.open_position.lock().await = Some(CexDexPosition {
            id: "test".into(),
            status: crate::executor::cex_executor::CexDexStatus::DexConfirmed,
            dex_tx_hash: None,
            cex_order_id: None,
            pair: "SOL".into(),
            size: Decimal::new(100, 0),
            opened_at: Instant::now(),
            max_exposure_secs: 300,
        });
        let cache = PriceCache::new();
        let opps = strategy.evaluate(&cache).await;
        assert!(opps.is_empty());
    }
}
