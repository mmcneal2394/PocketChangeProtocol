use rust_decimal::Decimal;
use serde::Serialize;
use std::time::Instant;
use tracing::{info, warn};
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

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
    pub exchange: String,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum Exchange {
    Mexc,
    Gate,
    KuCoin,
}

impl std::fmt::Display for Exchange {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Exchange::Mexc => write!(f, "MEXC"),
            Exchange::Gate => write!(f, "Gate.io"),
            Exchange::KuCoin => write!(f, "KuCoin"),
        }
    }
}

impl Exchange {
    /// Lowercase identifier used as the PriceCache source key.
    pub fn source_id(&self) -> &'static str {
        match self {
            Exchange::Mexc => "mexc",
            Exchange::Gate => "gate",
            Exchange::KuCoin => "kucoin",
        }
    }
}

#[derive(Debug, Clone)]
pub struct CexConfig {
    pub exchange: Exchange,
    pub api_key: String,
    pub api_secret: String,
    pub passphrase: Option<String>, // KuCoin requires this
    pub base_url: String,
}

pub struct MultiCexExecutor {
    exchanges: Vec<CexConfig>,
    client: reqwest::Client,
    pub max_exposure_secs: u64,
}

impl MultiCexExecutor {
    pub fn from_env(max_exposure_secs: u64) -> Self {
        let mut exchanges = Vec::new();

        // MEXC
        if let (Ok(key), Ok(secret)) = (
            std::env::var("MEXC_API_KEY"),
            std::env::var("MEXC_API_SECRET"),
        ) {
            if !key.is_empty() && !secret.is_empty() {
                exchanges.push(CexConfig {
                    exchange: Exchange::Mexc,
                    api_key: key,
                    api_secret: secret,
                    passphrase: None,
                    base_url: "https://api.mexc.com".to_string(),
                });
                info!("MEXC exchange configured");
            }
        }

        // Gate.io
        if let (Ok(key), Ok(secret)) = (
            std::env::var("GATE_API_KEY"),
            std::env::var("GATE_API_SECRET"),
        ) {
            if !key.is_empty() && !secret.is_empty() {
                exchanges.push(CexConfig {
                    exchange: Exchange::Gate,
                    api_key: key,
                    api_secret: secret,
                    passphrase: None,
                    base_url: "https://api.gateio.ws".to_string(),
                });
                info!("Gate.io exchange configured");
            }
        }

        // KuCoin
        if let (Ok(key), Ok(secret)) = (
            std::env::var("KUCOIN_API_KEY"),
            std::env::var("KUCOIN_API_SECRET"),
        ) {
            if !key.is_empty() && !secret.is_empty() {
                let passphrase = std::env::var("KUCOIN_PASSPHRASE").ok();
                exchanges.push(CexConfig {
                    exchange: Exchange::KuCoin,
                    api_key: key,
                    api_secret: secret,
                    passphrase,
                    base_url: "https://api.kucoin.com".to_string(),
                });
                info!("KuCoin exchange configured");
            }
        }

        if exchanges.is_empty() {
            warn!("No CEX exchanges configured — set MEXC_API_KEY, GATE_API_KEY, or KUCOIN_API_KEY");
        }

        Self {
            exchanges,
            client: reqwest::Client::new(),
            max_exposure_secs,
        }
    }

    pub fn has_exchanges(&self) -> bool {
        !self.exchanges.is_empty()
    }

    /// Fetch ticker price from an exchange for a symbol (e.g., "SOLUSDT")
    pub async fn fetch_price(&self, config: &CexConfig, symbol: &str) -> anyhow::Result<f64> {
        match config.exchange {
            Exchange::Mexc => {
                let url = format!("{}/api/v3/ticker/price?symbol={}", config.base_url, symbol);
                let resp: serde_json::Value = self.client.get(&url)
                    .timeout(std::time::Duration::from_secs(5))
                    .send().await?.json().await?;
                resp["price"].as_str()
                    .and_then(|p| p.parse().ok())
                    .ok_or_else(|| anyhow::anyhow!("MEXC price parse failed"))
            }
            Exchange::Gate => {
                // Gate uses underscore: SOL_USDT
                let gate_symbol = symbol.replace("USDT", "_USDT");
                let url = format!("{}/api/v4/spot/tickers?currency_pair={}", config.base_url, gate_symbol);
                let resp: Vec<serde_json::Value> = self.client.get(&url)
                    .timeout(std::time::Duration::from_secs(5))
                    .send().await?.json().await?;
                resp.first()
                    .and_then(|t| t["last"].as_str())
                    .and_then(|p| p.parse().ok())
                    .ok_or_else(|| anyhow::anyhow!("Gate price parse failed"))
            }
            Exchange::KuCoin => {
                // KuCoin uses dash: SOL-USDT
                let kc_symbol = symbol.replace("USDT", "-USDT");
                let url = format!("{}/api/v1/market/orderbook/level1?symbol={}", config.base_url, kc_symbol);
                let resp: serde_json::Value = self.client.get(&url)
                    .timeout(std::time::Duration::from_secs(5))
                    .send().await?.json().await?;
                resp["data"]["price"].as_str()
                    .and_then(|p| p.parse().ok())
                    .ok_or_else(|| anyhow::anyhow!("KuCoin price parse failed"))
            }
        }
    }

    /// Get best price across all configured exchanges
    pub async fn get_best_prices(&self, symbol: &str) -> Vec<(Exchange, f64)> {
        let mut prices = Vec::new();
        for config in &self.exchanges {
            match self.fetch_price(config, symbol).await {
                Ok(price) => {
                    prices.push((config.exchange.clone(), price));
                }
                Err(e) => {
                    warn!("{} price fetch failed for {}: {}", config.exchange, symbol, e);
                }
            }
        }
        prices
    }

    /// Place a market order on a specific exchange
    pub async fn place_market_order(
        &self,
        exchange: &Exchange,
        symbol: &str,
        side: &str,
        quantity: &str,
    ) -> anyhow::Result<String> {
        let config = self.exchanges.iter()
            .find(|c| c.exchange == *exchange)
            .ok_or_else(|| anyhow::anyhow!("{} not configured", exchange))?;

        match config.exchange {
            Exchange::Mexc => self.mexc_place_order(config, symbol, side, quantity).await,
            Exchange::Gate => self.gate_place_order(config, symbol, side, quantity).await,
            Exchange::KuCoin => self.kucoin_place_order(config, symbol, side, quantity).await,
        }
    }

    async fn mexc_place_order(
        &self,
        config: &CexConfig,
        symbol: &str,
        side: &str,
        quantity: &str,
    ) -> anyhow::Result<String> {
        let timestamp = chrono::Utc::now().timestamp_millis().to_string();
        let params = format!(
            "symbol={}&side={}&type=MARKET&quantity={}&timestamp={}",
            symbol,
            side.to_uppercase(),
            quantity,
            timestamp
        );
        let signature = Self::hmac_sign(&params, &config.api_secret);
        let url = format!(
            "{}/api/v3/order?{}&signature={}",
            config.base_url, params, signature
        );

        let resp: serde_json::Value = self.client.post(&url)
            .header("X-MEXC-APIKEY", &config.api_key)
            .timeout(std::time::Duration::from_secs(10))
            .send().await?.json().await?;

        resp["orderId"].as_str()
            .map(|s| s.to_string())
            .or_else(|| resp["orderId"].as_i64().map(|id| id.to_string()))
            .ok_or_else(|| anyhow::anyhow!("MEXC order failed: {}", resp))
    }

    async fn gate_place_order(
        &self,
        config: &CexConfig,
        symbol: &str,
        side: &str,
        quantity: &str,
    ) -> anyhow::Result<String> {
        let gate_symbol = symbol.replace("USDT", "_USDT");
        let body = serde_json::json!({
            "currency_pair": gate_symbol,
            "side": side,
            "type": "market",
            "amount": quantity,
        });
        let body_str = serde_json::to_string(&body)?;
        let timestamp = chrono::Utc::now().timestamp().to_string();
        let path = "/api/v4/spot/orders";

        // Gate.io v4 signature: HMAC-SHA512(method\npath\nquery\nhash(body)\ntimestamp)
        let body_hash = Self::sha512_hex(&body_str);
        let sign_str = format!("POST\n{}\n\n{}\n{}", path, body_hash, timestamp);
        let signature = Self::hmac_sha512_hex(&sign_str, &config.api_secret);

        let resp: serde_json::Value = self.client.post(&format!("{}{}", config.base_url, path))
            .header("KEY", &config.api_key)
            .header("SIGN", &signature)
            .header("Timestamp", &timestamp)
            .header("Content-Type", "application/json")
            .body(body_str)
            .timeout(std::time::Duration::from_secs(10))
            .send().await?.json().await?;

        resp["id"].as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| anyhow::anyhow!("Gate order failed: {}", resp))
    }

    async fn kucoin_place_order(
        &self,
        config: &CexConfig,
        symbol: &str,
        side: &str,
        quantity: &str,
    ) -> anyhow::Result<String> {
        let kc_symbol = symbol.replace("USDT", "-USDT");
        let body = serde_json::json!({
            "clientOid": uuid::Uuid::new_v4().to_string(),
            "side": side,
            "symbol": kc_symbol,
            "type": "market",
            "size": quantity,
        });
        let body_str = serde_json::to_string(&body)?;
        let timestamp = chrono::Utc::now().timestamp_millis().to_string();
        let path = "/api/v1/orders";
        let sign_str = format!("{}{}{}{}", timestamp, "POST", path, body_str);
        let signature = Self::hmac_sign_b64(&sign_str, &config.api_secret);
        let passphrase_sig = config.passphrase.as_ref()
            .map(|p| Self::hmac_sign_b64(p, &config.api_secret))
            .unwrap_or_default();

        let resp: serde_json::Value = self.client.post(&format!("{}{}", config.base_url, path))
            .header("KC-API-KEY", &config.api_key)
            .header("KC-API-SIGN", &signature)
            .header("KC-API-TIMESTAMP", &timestamp)
            .header("KC-API-PASSPHRASE", &passphrase_sig)
            .header("KC-API-KEY-VERSION", "2")
            .header("Content-Type", "application/json")
            .body(body_str)
            .timeout(std::time::Duration::from_secs(10))
            .send().await?.json().await?;

        resp["data"]["orderId"].as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| anyhow::anyhow!("KuCoin order failed: {}", resp))
    }

    /// Execute CEX leg with retry (3 attempts, exponential backoff).
    pub async fn execute_cex_leg(
        &self,
        position: &mut CexDexPosition,
        exchange: &Exchange,
        symbol: &str,
        side: &str,
        quantity: &str,
    ) -> anyhow::Result<()> {
        for attempt in 1..=3u32 {
            match self.place_market_order(exchange, symbol, side, quantity).await {
                Ok(order_id) => {
                    position.cex_order_id = Some(order_id);
                    position.exchange = exchange.to_string();
                    position.status = CexDexStatus::CexConfirmed;
                    return Ok(());
                }
                Err(e) => {
                    warn!("{} order attempt {}/3 failed: {}", exchange, attempt, e);
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
        Err(anyhow::anyhow!("CEX order failed after 3 attempts on {}", exchange))
    }

    // -----------------------------------------------------------------------
    // Signing helpers
    // -----------------------------------------------------------------------

    fn hmac_sign(message: &str, secret: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("key");
        mac.update(message.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }

    fn hmac_sign_b64(message: &str, secret: &str) -> String {
        let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("key");
        mac.update(message.as_bytes());
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
    }

    fn sha512_hex(data: &str) -> String {
        use sha2::{Sha512, Digest};
        let mut hasher = Sha512::new();
        hasher.update(data.as_bytes());
        hex::encode(hasher.finalize())
    }

    fn hmac_sha512_hex(message: &str, secret: &str) -> String {
        use hmac::Mac;
        type HmacSha512 = Hmac<sha2::Sha512>;
        let mut mac = HmacSha512::new_from_slice(secret.as_bytes()).expect("key");
        mac.update(message.as_bytes());
        hex::encode(mac.finalize().into_bytes())
    }
}
