pub mod triangular;
pub mod flash_loan;
pub mod cex_dex;
pub mod funding_rate;
pub mod statistical;

use async_trait::async_trait;
use rust_decimal::Decimal;
use solana_sdk::instruction::Instruction;
use solana_sdk::signature::Keypair;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, RwLock};
use crate::types::*;
use crate::price::PriceCache;

#[async_trait]
pub trait Strategy: Send + Sync {
    fn name(&self) -> &str;
    fn kind(&self) -> StrategyKind;
    async fn evaluate(&self, prices: &PriceCache) -> Vec<Opportunity>;
    fn build_instructions(&self, opp: &Opportunity, wallet: &Keypair) -> anyhow::Result<Vec<Instruction>>;
    fn min_profit_threshold(&self) -> Decimal;
    fn normalized_profit_pct(&self, opp: &Opportunity) -> Decimal;
}

pub async fn run_detector(
    strategy: Arc<dyn Strategy>,
    mut price_rx: broadcast::Receiver<PriceSnapshot>,
    opportunity_tx: mpsc::Sender<Opportunity>,
    price_cache: Arc<RwLock<PriceCache>>,
) {
    loop {
        if price_rx.recv().await.is_err() {
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            continue;
        }
        let cache = price_cache.read().await;
        let opps = strategy.evaluate(&cache).await;
        drop(cache);
        for opp in opps {
            if opportunity_tx.send(opp).await.is_err() {
                tracing::warn!("Opportunity channel closed");
                return;
            }
        }
    }
}
