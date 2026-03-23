use serde::Deserialize;
use std::collections::HashMap;
use std::fs;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineMode {
    Paper,
    Devnet,
    Mainnet,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StrategyConfig {
    pub auto_execute_threshold: f64,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EngineConfig {
    pub mode: EngineMode,
    pub jito_endpoint: String,
    pub auto_execute_threshold_default: f64,
    pub approval_timeout_secs: u64,
    pub max_loss_24h: f64,
    pub max_trade_size: f64,
    #[serde(default = "default_cex_exposure")]
    pub max_cex_exposure_secs: u64,
    #[serde(default)]
    pub rpc_fallback_urls: Vec<String>,
    #[serde(default)]
    pub strategy: HashMap<String, StrategyConfig>,
}

fn default_cex_exposure() -> u64 { 300 }

impl EngineConfig {
    pub fn load(path: &str) -> anyhow::Result<Self> {
        let content = fs::read_to_string(path)?;
        let config: EngineConfig = toml::from_str(&content)?;
        Ok(config)
    }

    pub fn rpc_url(&self) -> String {
        std::env::var("SOLANA_RPC_URL")
            .unwrap_or_else(|_| {
                self.rpc_fallback_urls.first()
                    .cloned()
                    .unwrap_or_else(|| "https://api.devnet.solana.com".to_string())
            })
    }

    pub fn strategy_enabled(&self, name: &str) -> bool {
        self.strategy.get(name).map(|s| s.enabled).unwrap_or(false)
    }

    pub fn get_strategy_threshold(&self, name: &str) -> f64 {
        self.strategy.get(name)
            .map(|s| s.auto_execute_threshold)
            .unwrap_or(self.auto_execute_threshold_default)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_config_from_toml_string() {
        let toml_str = r#"
            mode = "paper"
            jito_endpoint = "https://test.jito.wtf"
            auto_execute_threshold_default = 0.5
            approval_timeout_secs = 300
            max_loss_24h = 50.0
            max_trade_size = 10.0

            [strategy.triangular]
            auto_execute_threshold = 0.3
            enabled = true

            [strategy.funding_rate]
            auto_execute_threshold = 0.08
            enabled = false
        "#;
        let config: EngineConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.mode, EngineMode::Paper);
        assert_eq!(config.max_trade_size, 10.0);
        assert!(config.strategy_enabled("triangular"));
        assert!(!config.strategy_enabled("funding_rate"));
        assert_eq!(config.get_strategy_threshold("triangular"), 0.3);
        assert_eq!(config.get_strategy_threshold("unknown"), 0.5);
    }

    #[test]
    fn test_rpc_url_fallback() {
        let toml_str = r#"
            mode = "devnet"
            jito_endpoint = "https://test.jito.wtf"
            auto_execute_threshold_default = 0.5
            approval_timeout_secs = 300
            max_loss_24h = 50.0
            max_trade_size = 10.0
            rpc_fallback_urls = ["https://custom-rpc.com"]
        "#;
        let config: EngineConfig = toml::from_str(toml_str).unwrap();
        // Without SOLANA_RPC_URL env var set, should use first fallback
        std::env::remove_var("SOLANA_RPC_URL");
        assert_eq!(config.rpc_url(), "https://custom-rpc.com");
    }
}
