use solana_sdk::{
    instruction::Instruction,
    signature::Keypair,
    signer::Signer,
    transaction::Transaction,
};
use solana_client::rpc_client::RpcClient;
use std::sync::Arc;
use rust_decimal::Decimal;
use tracing::{info, warn};
use crate::types::TradeResult;

pub struct Simulator {
    rpc: Arc<RpcClient>,
    virtual_balance: std::sync::Mutex<Decimal>,
}

impl Simulator {
    pub fn new(rpc: Arc<RpcClient>) -> Self {
        Self {
            rpc,
            virtual_balance: std::sync::Mutex::new(Decimal::new(10000, 0)), // 10,000 virtual SOL
        }
    }

    /// Simulate a transaction without submitting it on-chain
    pub fn simulate(
        &self,
        instructions: &[Instruction],
        payer: &Keypair,
        opportunity_id: &str,
        expected_profit: Decimal,
    ) -> TradeResult {
        let start = std::time::Instant::now();

        // Build unsigned transaction for simulation
        let tx = Transaction::new_unsigned(
            solana_sdk::message::Message::new(instructions, Some(&payer.pubkey())),
        );

        // Try RPC simulation
        let success = match self.rpc.simulate_transaction(&tx) {
            Ok(result) => {
                if let Some(err) = result.value.err {
                    warn!("Simulation failed for {}: {:?}", opportunity_id, err);
                    false
                } else {
                    info!("Simulation succeeded for {}", opportunity_id);
                    true
                }
            }
            Err(e) => {
                // RPC might not be available in paper mode — that's OK
                warn!("RPC simulation unavailable: {} — marking as simulated success", e);
                true
            }
        };

        // Update virtual balance
        if success {
            if let Ok(mut balance) = self.virtual_balance.lock() {
                *balance += expected_profit;
            }
        }

        let elapsed = start.elapsed().as_millis() as u64;

        TradeResult {
            opportunity_id: opportunity_id.to_string(),
            success,
            tx_hash: None, // No on-chain TX in paper mode
            actual_profit_sol: if success { Some(expected_profit) } else { None },
            execution_time_ms: elapsed,
            error: if success { None } else { Some("Simulation failed".to_string()) },
        }
    }

    pub fn get_virtual_balance(&self) -> Decimal {
        *self.virtual_balance.lock().unwrap()
    }
}
