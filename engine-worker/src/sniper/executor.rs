//! Jupiter execution helpers + Telegram notifications
//!
//! Swap flow:
//!   1. get_jupiter_quote() → GET /quote → { outAmount, ... }
//!   2. execute_swap()      → POST /swap  → base64 VersionedTransaction
//!                          → decode, sign, send via RPC (+ optional Jito tip)
//!   3. send_telegram()     → Telegram alert

use anyhow::{anyhow, Result};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use solana_sdk::{
    signature::Keypair,
    signer::Signer,
    transaction::VersionedTransaction,
};
use tracing::{info, warn};
use super::SniperConfig;

/// Load wallet keypair from env var (tries SNIPER_WALLET_KEY, then SOLANA_PRIVATE_KEY)
fn load_wallet() -> Result<Keypair> {
    let key_str = std::env::var("SNIPER_WALLET_KEY")
        .or_else(|_| std::env::var("SOLANA_PRIVATE_KEY"))
        .map_err(|_| anyhow!("Neither SNIPER_WALLET_KEY nor SOLANA_PRIVATE_KEY set"))?;

    // Support both raw Base58 secret key and JSON byte array formats
    if key_str.starts_with('[') {
        let bytes: Vec<u8> = serde_json::from_str(&key_str)
            .map_err(|e| anyhow!("Failed to parse SOLANA_PRIVATE_KEY as JSON array: {}", e))?;
        Keypair::try_from(bytes.as_slice())
            .map_err(|e| anyhow!("Invalid keypair bytes: {}", e))
    } else {
        let bytes = bs58::decode(&key_str).into_vec()
            .map_err(|e| anyhow!("Failed to decode SOLANA_PRIVATE_KEY as Base58: {}", e))?;
        Keypair::try_from(bytes.as_slice())
            .map_err(|e| anyhow!("Invalid keypair from Base58: {}", e))
    }
}

/// Fetch a Jupiter quote
pub async fn get_jupiter_quote(
    http: &reqwest::Client,
    api_key: &str,
    input_mint: &str,
    output_mint: &str,
    amount: u64,
) -> Result<serde_json::Value> {
    let url = format!(
        "https://public.jupiterapi.com/quote?inputMint={}&outputMint={}&amount={}&slippageBps=1000",
        input_mint, output_mint, amount
    );

    let mut req = http.get(&url)
        .header("Content-Type", "application/json");
    if !api_key.is_empty() {
        req = req.header("x-api-key", api_key);
    }

    let resp = req.send().await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Jupiter HTTP {}: {}", status, &body[..body.len().min(200)]));
    }

    let json: serde_json::Value = resp.json().await?;
    if json.get("error").is_some() {
        return Err(anyhow!("Jupiter error: {}", json["error"]));
    }
    if json.get("outAmount").is_none() {
        return Err(anyhow!("No outAmount in Jupiter response"));
    }

    Ok(json)
}

/// Execute a Jupiter swap — paper mode returns fake sig, live mode signs and sends
pub async fn execute_swap(
    http: &reqwest::Client,
    config: &SniperConfig,
    quote: &serde_json::Value,
) -> Result<String> {
    if config.paper_mode {
        return Ok(format!("PAPER_{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()));
    }

    // 1. Load wallet
    let wallet = load_wallet()?;
    let pubkey = wallet.pubkey();
    info!("[EXEC] Live swap with wallet {}", pubkey);

    // 2. Request serialized swap transaction from Jupiter
    let swap_body = serde_json::json!({
        "quoteResponse": quote,
        "userPublicKey": pubkey.to_string(),
        "dynamicComputeUnitLimit": true,
        "prioritizationFeeLamports": {
            "jitoTipLamports": 50_000  // 0.00005 SOL Jito tip
        },
        "dynamicSlippage": { "maxBps": 800 },
    });

    let mut req = http.post("https://public.jupiterapi.com/swap")
        .json(&swap_body);
    if !config.jupiter_api_key.is_empty() {
        req = req.header("x-api-key", &config.jupiter_api_key);
    }

    let resp = req.send().await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Jupiter /swap HTTP {}: {}", status, &body[..body.len().min(300)]));
    }

    let swap_data: serde_json::Value = resp.json().await?;
    let tx_base64 = swap_data["swapTransaction"]
        .as_str()
        .ok_or_else(|| anyhow!("No swapTransaction in Jupiter response: {}", swap_data))?;

    // 3. Decode the VersionedTransaction
    let tx_bytes = BASE64.decode(tx_base64)
        .map_err(|e| anyhow!("Failed to decode swap transaction base64: {}", e))?;
    let mut tx: VersionedTransaction = bincode::deserialize(&tx_bytes)
        .map_err(|e| anyhow!("Failed to deserialize VersionedTransaction: {}", e))?;

    // 4. Sign the transaction
    //    Jupiter returns a partially-signed tx (unsigned at index 0 for the user).
    //    We sign the serialized message and place our signature at index 0.
    let msg_bytes = tx.message.serialize();
    let signature = wallet.sign_message(&msg_bytes);
    if tx.signatures.is_empty() {
        return Err(anyhow!("VersionedTransaction has no signature slots"));
    }
    tx.signatures[0] = signature;

    // 5. Serialize and send
    let signed_bytes = bincode::serialize(&tx)
        .map_err(|e| anyhow!("Failed to serialize signed tx: {}", e))?;
    let signed_b64 = BASE64.encode(&signed_bytes);

    // Try Jito first for MEV protection, fall back to standard RPC
    let sig_str = match send_via_jito(http, &signed_b64).await {
        Ok(sig) => {
            info!("[EXEC] Jito submission accepted: {}", sig);
            sig
        }
        Err(jito_err) => {
            warn!("[EXEC] Jito failed ({}), falling back to RPC", jito_err);
            send_via_rpc(http, &config.rpc_url, &signed_b64).await?
        }
    };

    info!("[EXEC] Swap confirmed: {}", sig_str);
    Ok(sig_str)
}

/// Send transaction via Jito block engine for MEV protection
async fn send_via_jito(http: &reqwest::Client, tx_base64: &str) -> Result<String> {
    let jito_url = std::env::var("JITO_ENDPOINT")
        .unwrap_or_else(|_| "https://mainnet.block-engine.jito.wtf".to_string());

    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "sendTransaction",
        "params": [tx_base64, { "encoding": "base64" }]
    });

    let resp = http.post(&format!("{}/api/v1/transactions", jito_url))
        .json(&body)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await?;

    let result: serde_json::Value = resp.json().await?;
    if let Some(err) = result.get("error") {
        return Err(anyhow!("Jito error: {}", err));
    }
    result["result"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow!("No result in Jito response"))
}

/// Send transaction via standard Solana RPC
async fn send_via_rpc(http: &reqwest::Client, rpc_url: &str, tx_base64: &str) -> Result<String> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "sendTransaction",
        "params": [
            tx_base64,
            {
                "encoding": "base64",
                "skipPreflight": true,
                "maxRetries": 3,
                "preflightCommitment": "processed"
            }
        ]
    });

    let resp = http.post(rpc_url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await?;

    let result: serde_json::Value = resp.json().await?;
    if let Some(err) = result.get("error") {
        return Err(anyhow!("RPC error: {}", err));
    }
    result["result"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow!("No signature in RPC response"))
}

/// Send a Telegram notification
pub async fn send_telegram(config: &SniperConfig, message: &str) {
    if config.telegram_token.is_empty() || config.telegram_chat_id.is_empty()
        || config.telegram_chat_id == "disabled" {
        return;
    }

    let url = format!("https://api.telegram.org/bot{}/sendMessage", config.telegram_token);
    let body = serde_json::json!({
        "chat_id": config.telegram_chat_id,
        "text": message,
        "parse_mode": "HTML",
    });

    let client = reqwest::Client::new();
    match client.post(&url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(_) => {}
        Err(e) => warn!("[TG] Send failed: {}", e),
    }
}
