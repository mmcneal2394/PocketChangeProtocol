use serde_json;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use crate::types::TelemetryEvent;
use tracing::{info, error};

pub struct TelemetryWriter {
    file_path: PathBuf,
}

impl TelemetryWriter {
    pub fn new(file_path: &str) -> Self {
        Self {
            file_path: PathBuf::from(file_path),
        }
    }

    pub fn write_event(&self, event: &TelemetryEvent) {
        match serde_json::to_string(event) {
            Ok(json) => {
                match OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.file_path)
                {
                    Ok(mut file) => {
                        if let Err(e) = writeln!(file, "{}", json) {
                            error!("Failed to write telemetry: {}", e);
                        }
                    }
                    Err(e) => error!("Failed to open telemetry file: {}", e),
                }
            }
            Err(e) => error!("Failed to serialize telemetry event: {}", e),
        }
    }
}

/// HTTP client for communicating with Next.js API
pub struct ApiClient {
    base_url: String,
    auth_token: String,
    client: reqwest::Client,
}

impl ApiClient {
    pub fn new(base_url: &str, auth_token: &str) -> Self {
        Self {
            base_url: base_url.to_string(),
            auth_token: auth_token.to_string(),
            client: reqwest::Client::new(),
        }
    }

    pub fn from_env() -> Self {
        let base_url = std::env::var("NEXTJS_API_URL")
            .unwrap_or_else(|_| "http://localhost:3000".to_string());
        let auth_token = std::env::var("ENGINE_API_SECRET")
            .unwrap_or_default();
        Self::new(&base_url, &auth_token)
    }

    pub async fn post_opportunity(&self, opp: &crate::types::Opportunity) -> anyhow::Result<()> {
        let url = format!("{}/api/opportunities", self.base_url);
        let resp = self.client.post(&url)
            .header("Authorization", format!("Bearer {}", self.auth_token))
            .json(opp)
            .send()
            .await?;
        if !resp.status().is_success() {
            tracing::warn!("Failed to post opportunity: {}", resp.status());
        }
        Ok(())
    }

    pub async fn patch_opportunity(&self, id: &str, status: &str, tx_hash: Option<&str>, profit: Option<f64>) -> anyhow::Result<()> {
        let url = format!("{}/api/opportunities/{}", self.base_url, id);
        let body = serde_json::json!({
            "status": status,
            "executionTxHash": tx_hash,
            "executionProfit": profit,
        });
        let resp = self.client.patch(&url)
            .header("Authorization", format!("Bearer {}", self.auth_token))
            .json(&body)
            .send()
            .await?;
        if !resp.status().is_success() {
            tracing::warn!("Failed to patch opportunity {}: {}", id, resp.status());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::TelemetryEvent;
    use std::fs;

    #[test]
    fn test_telemetry_event_write() {
        let path = "test_telemetry.jsonl";
        let writer = TelemetryWriter::new(path);
        let event = TelemetryEvent {
            timestamp: "2026-03-22T14:30:00Z".to_string(),
            event: "trade_executed".to_string(),
            strategy: "triangular".to_string(),
            route: "SOL -> RAY -> USDC -> SOL".to_string(),
            expected_profit_pct: 0.34,
            actual_profit_sol: Some(0.17),
            tx_hash: Some("abc123".to_string()),
            mode: "paper".to_string(),
            execution_time_ms: Some(142),
            status: "success".to_string(),
            error: None,
        };
        writer.write_event(&event);

        let contents = fs::read_to_string(path).unwrap();
        assert!(contents.contains("trade_executed"));
        assert!(contents.contains("triangular"));
        fs::remove_file(path).ok();
    }
}
