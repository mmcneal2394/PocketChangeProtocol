pub mod jito;
pub mod simulator;
pub mod circuit_breaker;
pub mod cex_executor;

use std::sync::Arc;
use tokio::sync::RwLock;
use solana_sdk::signature::Keypair;
use solana_client::rpc_client::RpcClient;
use tracing::{info, warn, error};
use crate::types::*;
use crate::config::EngineMode;
use crate::db::TelemetryWriter;

pub struct Executor {
    mode: EngineMode,
    jito: jito::JitoClient,
    simulator: simulator::Simulator,
    circuit_breaker: Arc<RwLock<circuit_breaker::CircuitBreaker>>,
    telemetry: Arc<TelemetryWriter>,
    rpc: Arc<RpcClient>,
}

impl Executor {
    pub fn new(
        mode: EngineMode,
        jito: jito::JitoClient,
        simulator: simulator::Simulator,
        circuit_breaker: Arc<RwLock<circuit_breaker::CircuitBreaker>>,
        telemetry: Arc<TelemetryWriter>,
        rpc: Arc<RpcClient>,
    ) -> Self {
        Self { mode, jito, simulator, circuit_breaker, telemetry, rpc }
    }

    pub async fn execute(&self, opp: &Opportunity, wallet: &Keypair) -> TradeResult {
        // Check circuit breaker
        {
            let cb = self.circuit_breaker.read().await;
            if cb.is_tripped() {
                let reason = cb.trip_reason().unwrap_or("unknown").to_string();
                error!("Circuit breaker tripped: {}", reason);
                return TradeResult {
                    opportunity_id: opp.id.clone(),
                    success: false,
                    tx_hash: None,
                    actual_profit_sol: None,
                    execution_time_ms: 0,
                    error: Some(format!("Circuit breaker: {}", reason)),
                };
            }
        }

        let result = match self.mode {
            EngineMode::Paper => {
                self.simulator.simulate(
                    &opp.instructions,
                    wallet,
                    &opp.id,
                    opp.expected_profit_pct, // Use as proxy for profit in paper mode
                )
            }
            EngineMode::Devnet | EngineMode::Mainnet => {
                self.execute_live(opp, wallet).await
            }
        };

        // Record in circuit breaker
        {
            let mut cb = self.circuit_breaker.write().await;
            if result.success {
                if let Some(profit) = result.actual_profit_sol {
                    cb.record_trade(profit);
                }
                cb.record_success();
            } else {
                cb.record_failure();
            }
        }

        // Write telemetry
        let event = TelemetryEvent {
            timestamp: chrono::Utc::now().to_rfc3339(),
            event: if result.success { "trade_executed".to_string() } else { "trade_failed".to_string() },
            strategy: opp.strategy.to_string(),
            route: opp.route.clone(),
            expected_profit_pct: opp.expected_profit_pct.try_into().unwrap_or(0.0),
            actual_profit_sol: result.actual_profit_sol.map(|d| d.try_into().unwrap_or(0.0)),
            tx_hash: result.tx_hash.clone(),
            mode: format!("{:?}", self.mode).to_lowercase(),
            execution_time_ms: Some(result.execution_time_ms),
            status: if result.success { "success".to_string() } else { "failed".to_string() },
            error: result.error.clone(),
        };
        self.telemetry.write_event(&event);

        result
    }

    async fn execute_live(&self, opp: &Opportunity, wallet: &Keypair) -> TradeResult {
        let start = std::time::Instant::now();

        // Get recent blockhash
        let blockhash = match self.rpc.get_latest_blockhash() {
            Ok(bh) => bh,
            Err(e) => {
                return TradeResult {
                    opportunity_id: opp.id.clone(),
                    success: false,
                    tx_hash: None,
                    actual_profit_sol: None,
                    execution_time_ms: start.elapsed().as_millis() as u64,
                    error: Some(format!("Failed to get blockhash: {}", e)),
                };
            }
        };

        // Build Jito bundle with tip
        let bundle = self.jito.build_bundle(
            opp.instructions.clone(),
            10_000, // 0.00001 SOL tip
            wallet,
            blockhash,
        );

        // Submit bundle
        match self.jito.submit_bundle(&bundle).await {
            Ok(bundle_id) => {
                info!("Bundle {} submitted for opportunity {}", bundle_id, opp.id);
                TradeResult {
                    opportunity_id: opp.id.clone(),
                    success: true,
                    tx_hash: Some(bundle_id),
                    actual_profit_sol: Some(opp.expected_profit_pct), // Estimated until confirmed
                    execution_time_ms: start.elapsed().as_millis() as u64,
                    error: None,
                }
            }
            Err(e) => {
                error!("Bundle submission failed for {}: {}", opp.id, e);
                TradeResult {
                    opportunity_id: opp.id.clone(),
                    success: false,
                    tx_hash: None,
                    actual_profit_sol: None,
                    execution_time_ms: start.elapsed().as_millis() as u64,
                    error: Some(format!("Bundle failed: {}", e)),
                }
            }
        }
    }
}
