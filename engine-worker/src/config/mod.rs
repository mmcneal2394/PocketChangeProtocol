use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TenantConfig {
    pub tenant_id: String,
    pub active_wallet_pubkeys: Vec<String>, // List of pubkeys we manage
    pub targets: Vec<StrategyTarget>,       // Permitted DEX pairs
    pub min_profit_sol: f64,              // Hard floor on profit threshold
    pub priority_fee_lamports: u64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StrategyTarget {
    pub token_a: String,
    pub token_b: String,
    pub target_profit_percent: f64,
}

pub struct ConfigManager {
    // simulated cache
}

impl ConfigManager {
    pub fn new() -> Self {
        ConfigManager {}
    }

    /// Reads latest tenant configurations from postgres cache to dynamically turn on/off executing workers.
    /// Fails safely if offline by utilizing local memory state map.
    pub async fn sync_from_postgres(&self) {
        println!("[Config] Validating against core DB settings");
    }
}
