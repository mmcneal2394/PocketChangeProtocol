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

// ---------------------------------------------------------------------------
// Shared fee-estimation helpers
// ---------------------------------------------------------------------------

/// Jito tip per bundle (~5000 lamports).
const JITO_TIP_SOL: f64 = 0.000005;
/// Priority fee per transaction (~10000 lamports).
const PRIORITY_FEE_SOL: f64 = 0.00001;

/// Calculate real execution costs in USDC for `num_transactions` on-chain txs.
pub fn estimate_execution_cost_usdc(sol_price: f64, num_transactions: u32) -> f64 {
    let per_tx_cost_sol = JITO_TIP_SOL + PRIORITY_FEE_SOL;
    let total_sol = per_tx_cost_sol * num_transactions as f64;
    total_sol * sol_price
}

/// Calculate execution cost as a percentage of `trade_size_usdc`.
pub fn execution_cost_pct(sol_price: f64, trade_size_usdc: f64, num_transactions: u32) -> f64 {
    if trade_size_usdc <= 0.0 {
        return 0.0;
    }
    let cost_usdc = estimate_execution_cost_usdc(sol_price, num_transactions);
    (cost_usdc / trade_size_usdc) * 100.0
}

/// Extract `priceImpactPct` from a Jupiter quote JSON response (returns 0.0 on missing/invalid).
pub fn extract_price_impact_pct(quote: &serde_json::Value) -> f64 {
    quote["priceImpactPct"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0)
        .abs()
}

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
