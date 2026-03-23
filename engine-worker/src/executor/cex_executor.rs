use rust_decimal::Decimal;
use serde::Serialize;
use std::time::Instant;
use tracing::warn;

#[derive(Debug, Clone, Serialize)]
pub enum CexDexStatus {
    DexPending,
    DexConfirmed,
    CexPending,
    CexConfirmed,
    Stuck,
    Unwinding,
    Settled,
}

#[derive(Debug, Clone, Serialize)]
pub struct CexDexPosition {
    pub id: String,
    pub status: CexDexStatus,
    pub dex_tx_hash: Option<String>,
    pub cex_order_id: Option<String>,
    pub pair: String,
    pub size: Decimal,
    #[serde(skip)]
    pub opened_at: Instant,
    pub max_exposure_secs: u64,
}

impl CexDexPosition {
    pub fn is_expired(&self) -> bool {
        self.opened_at.elapsed().as_secs() > self.max_exposure_secs
    }
}

// ---------------------------------------------------------------------------
// CexExecutor — Bitget spot order execution for CEX-DEX arbitrage
// ---------------------------------------------------------------------------

pub struct CexExecutor {
    api_key: String,
    api_secret: String,
    passphrase: String,
    client: reqwest::Client,
    pub max_exposure_secs: u64,
}

impl CexExecutor {
    pub fn new(api_key: String, api_secret: String, passphrase: String, max_exposure_secs: u64) -> Self {
        Self {
            api_key,
            api_secret,
            passphrase,
            client: reqwest::Client::new(),
            max_exposure_secs,
        }
    }

    pub fn from_env(max_exposure_secs: u64) -> Option<Self> {
        let api_key = std::env::var("BITGET_API_KEY").ok()?;
        let api_secret = std::env::var("BITGET_API_SECRET").ok()?;
        let passphrase = std::env::var("BITGET_PASSPHRASE").ok()?;
        Some(Self::new(api_key, api_secret, passphrase, max_exposure_secs))
    }

    /// Produce HMAC-SHA256 signature for Bitget API v2 authentication.
    fn sign(timestamp: &str, method: &str, path: &str, body: &str, secret: &str) -> String {
        use hmac::{Hmac, Mac};
        use sha2::Sha256;
        type HmacSha256 = Hmac<Sha256>;
        let message = format!("{}{}{}{}", timestamp, method, path, body);
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC key");
        mac.update(message.as_bytes());
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
    }

    /// Place a market order on Bitget spot.
    pub async fn place_market_order(
        &self,
        symbol: &str,
        side: &str,
        size: &str,
    ) -> anyhow::Result<String> {
        let path = "/api/v2/spot/trade/place-order";
        let body = serde_json::json!({
            "symbol": symbol,
            "side": side,
            "orderType": "market",
            "size": size,
            "force": "gtc"
        });
        let body_str = serde_json::to_string(&body)?;
        let timestamp = chrono::Utc::now().timestamp_millis().to_string();
        let signature = Self::sign(&timestamp, "POST", path, &body_str, &self.api_secret);

        let resp = self
            .client
            .post(format!("https://api.bitget.com{}", path))
            .header("ACCESS-KEY", &self.api_key)
            .header("ACCESS-SIGN", &signature)
            .header("ACCESS-TIMESTAMP", &timestamp)
            .header("ACCESS-PASSPHRASE", &self.passphrase)
            .header("Content-Type", "application/json")
            .body(body_str)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await?;

        let result: serde_json::Value = resp.json().await?;
        if result["code"].as_str() != Some("00000") {
            return Err(anyhow::anyhow!("Bitget order failed: {}", result));
        }

        let order_id = result["data"]["orderId"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();
        Ok(order_id)
    }

    /// Check order fill status on Bitget.
    pub async fn get_order_status(
        &self,
        order_id: &str,
        symbol: &str,
    ) -> anyhow::Result<String> {
        let path = format!(
            "/api/v2/spot/trade/orderInfo?orderId={}&symbol={}",
            order_id, symbol
        );
        let timestamp = chrono::Utc::now().timestamp_millis().to_string();
        let signature = Self::sign(&timestamp, "GET", &path, "", &self.api_secret);

        let resp = self
            .client
            .get(format!("https://api.bitget.com{}", path))
            .header("ACCESS-KEY", &self.api_key)
            .header("ACCESS-SIGN", &signature)
            .header("ACCESS-TIMESTAMP", &timestamp)
            .header("ACCESS-PASSPHRASE", &self.passphrase)
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await?;

        let result: serde_json::Value = resp.json().await?;
        let status = result["data"]["status"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();
        Ok(status) // "filled", "partially_filled", "cancelled", etc.
    }

    /// Execute the CEX leg with retry logic (3 attempts, exponential backoff).
    pub async fn execute_cex_leg(
        &self,
        position: &mut CexDexPosition,
    ) -> anyhow::Result<()> {
        let symbol = format!("{}USDT", position.pair);
        let side = "buy"; // Simplified — in production, determined by spread direction
        let size = position.size.to_string();

        for attempt in 1..=3u32 {
            match self.place_market_order(&symbol, side, &size).await {
                Ok(order_id) => {
                    position.cex_order_id = Some(order_id);
                    position.status = CexDexStatus::CexConfirmed;
                    return Ok(());
                }
                Err(e) => {
                    warn!("CEX order attempt {}/3 failed: {}", attempt, e);
                    if attempt < 3 {
                        tokio::time::sleep(std::time::Duration::from_secs(
                            2u64.pow(attempt),
                        ))
                        .await;
                    }
                }
            }
        }

        position.status = CexDexStatus::Stuck;
        Err(anyhow::anyhow!("CEX order failed after 3 attempts"))
    }
}
