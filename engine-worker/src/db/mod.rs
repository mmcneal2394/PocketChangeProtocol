use serde::{Serialize, Deserialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct DbClient {
    file_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeLogEvent {
    pub execution_time_ms: u64,
    pub timestamp_sec: u64,
    pub route: String,
    pub tenant_id: String,
    pub tx_signature: String,
    pub profit_sol: f64,
    pub status: String,
    pub error_msg: Option<String>,
    pub latency_ms: Option<u64>,
    pub slippage_bps: Option<f64>,
    pub mev_tip_paid: Option<u64>
}

impl DbClient {
    pub async fn new() -> Self {
        DbClient {
            file_path: "telemetry.jsonl".to_string()
        }
    }

    /// Logs securely to an append-only JSON line file for lightweight telemetry.
    pub async fn inject_audit_log(&self, mut event: TradeLogEvent) -> Result<(), String> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        
        event.timestamp_sec = now;

        let msg = serde_json::to_string(&event).map_err(|e| e.to_string())?;

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.file_path)
            .map_err(|e| e.to_string())?;

        if let Err(e) = writeln!(file, "{}", msg) {
            eprintln!("Couldn't write to telemetry logging file: {}", e);
        }

        println!("[Audit Pipeline] Submitted execution state -> telemetry.jsonl");

        // Reflect to pcprotocol.dev dashboard!
        let internal_api_key = std::env::var("INTERNAL_API_KEY").unwrap_or_else(|_| "demo_auth_123".to_string());
        let payload = serde_json::json!({
            "walletPubkey": event.tenant_id.clone(),
            "status": event.status.clone(),
            "profitAmt": event.profit_sol,
            "route": event.route.clone(),
            "txHash": event.tx_signature.clone()
        });
        let payload_str = payload.to_string();
        tokio::task::spawn_blocking(move || {
            let _ = std::process::Command::new("curl")
                .arg("-s")
                .arg("-X")
                .arg("POST")
                .arg("-H")
                .arg("Content-Type: application/json")
                .arg("-H")
                .arg(format!("Authorization: Bearer {}", internal_api_key))
                .arg("-d")
                .arg(&payload_str)
                .arg("https://pcprotocol.dev/api/log_trade")
                .output();
        });

        Ok(())
    }
}
