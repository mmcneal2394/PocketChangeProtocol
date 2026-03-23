use std::env;
use solana_sdk::signature::{Keypair, Signer};

// Core modules
mod config;
mod db;
mod kms;
mod engine;
mod types;
mod rpc;
mod price;
mod strategy;
mod approval;
mod executor;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    env_logger::init();
    println!("Starting ArbitraSaaS Engine Worker...");

    // 1. Initialize Log Telemetry
    let telemetry = db::TelemetryWriter::new("telemetry.jsonl");

    // Test injecting a startup telemetry event
    telemetry.write_event(&types::TelemetryEvent {
        timestamp: chrono::Utc::now().to_rfc3339(),
        event: "engine_start".to_string(),
        strategy: "system".to_string(),
        route: "N/A".to_string(),
        expected_profit_pct: 0.0,
        actual_profit_sol: None,
        tx_hash: None,
        mode: "paper".to_string(),
        execution_time_ms: None,
        status: "ok".to_string(),
        error: None,
    });

    // 2. Load wallet from KMS / env
    println!("Authenticating with KMS...");
    let _kms_client = kms::KMSClient::from_env().unwrap_or_else(|_| {
        println!("WARN: KMS_MASTER_KEY not set -- using dev placeholder key");
        kms::KMSClient::from_key(&[0u8; 32])
    });

    let secret = env::var("SOLANA_PRIVATE_KEY")
        .unwrap_or_else(|_| "11111111111111111111111111111111111111111111".to_string());
    let wallet = Keypair::from_base58_string(&secret);
    println!("Loaded wallet: {}", wallet.pubkey());

    // 3. Construct the Arbitrage Vault Executor (instruction builder)
    let _vault_exe = engine::VaultExecutor::new(
        wallet,
        solana_sdk::pubkey::Pubkey::default(), // Placeholder program ID
        solana_sdk::pubkey::Pubkey::default(),  // Placeholder token program
    );

    println!("Engine ready. VaultExecutor initialised with instruction builders.");
    // The orchestrator / strategy layer will call vault_exe.build_vault_ptb() and
    // vault_exe.fetch_jupiter_instructions() as needed.

    Ok(())
}
