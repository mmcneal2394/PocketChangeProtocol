//! Integration test: verifies the engine pipeline from config loading
//! through strategy evaluation to telemetry output in paper mode.

use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

// We test the public modules of the engine crate
// Note: this file lives in tests/ so it can only access pub items

#[tokio::test]
async fn test_config_loads_from_toml() {
    let config = arbitrasaas_engine::config::EngineConfig::load("engine.toml");
    assert!(config.is_ok(), "engine.toml should parse: {:?}", config.err());
    let config = config.unwrap();
    assert_eq!(config.mode, arbitrasaas_engine::config::EngineMode::Paper);
    assert!(config.max_trade_size > 0.0);
}

#[tokio::test]
async fn test_price_cache_update_and_read() {
    let mut cache = arbitrasaas_engine::price::PriceCache::new();
    let snapshot = arbitrasaas_engine::types::PriceSnapshot {
        mint: "SOL".to_string(),
        price_usdc: 150.0,
        source: "test".to_string(),
        timestamp: Instant::now(),
    };
    cache.update(&snapshot);
    assert_eq!(cache.get_price("SOL"), Some(150.0));
    assert!(cache.is_fresh("SOL", Duration::from_secs(5)));
    assert_eq!(cache.get_price("BTC"), None);
}

#[tokio::test]
async fn test_circuit_breaker_allows_profitable_trades() {
    let mut cb = arbitrasaas_engine::executor::circuit_breaker::CircuitBreaker::new(
        rust_decimal::Decimal::new(100, 0),
        rust_decimal::Decimal::new(50, 0),
    );
    cb.record_trade(rust_decimal::Decimal::new(10, 0));
    cb.record_trade(rust_decimal::Decimal::new(20, 0));
    assert!(!cb.is_tripped());
}

#[tokio::test]
async fn test_telemetry_writes_jsonl() {
    let path = "test_integration_telemetry.jsonl";
    let writer = arbitrasaas_engine::db::TelemetryWriter::new(path);
    let event = arbitrasaas_engine::types::TelemetryEvent {
        timestamp: chrono::Utc::now().to_rfc3339(),
        event: "test_event".to_string(),
        strategy: "triangular".to_string(),
        route: "SOL -> RAY -> USDC -> SOL".to_string(),
        expected_profit_pct: 0.5,
        actual_profit_sol: Some(0.25),
        tx_hash: None,
        mode: "paper".to_string(),
        execution_time_ms: Some(42),
        status: "success".to_string(),
        error: None,
    };
    writer.write_event(&event);

    let contents = std::fs::read_to_string(path).unwrap();
    assert!(contents.contains("test_event"));
    assert!(contents.contains("triangular"));
    assert!(contents.contains("0.5"));
    std::fs::remove_file(path).ok();
}

#[tokio::test]
async fn test_kms_encrypt_decrypt_roundtrip() {
    let key = [99u8; 32];
    let kms = arbitrasaas_engine::kms::KMSClient::from_key(&key);
    let secret = b"integration_test_secret_key_data";
    let encrypted = kms.encrypt(secret).unwrap();
    let decrypted = kms.decrypt(&encrypted).unwrap();
    assert_eq!(decrypted, secret);
}

#[tokio::test]
async fn test_triangular_strategy_evaluates_without_panic() {
    let cache = arbitrasaas_engine::price::PriceCache::new();
    // Empty cache — should return no opportunities, not panic
    let strategy = arbitrasaas_engine::strategy::triangular::TriangularStrategy::new(0.3);
    use arbitrasaas_engine::strategy::Strategy;
    let opps = strategy.evaluate(&cache).await;
    assert!(opps.is_empty());
}

#[tokio::test]
async fn test_flash_loan_disabled_without_vault() {
    let cache = arbitrasaas_engine::price::PriceCache::new();
    let strategy = arbitrasaas_engine::strategy::flash_loan::FlashLoanStrategy::new(0.3, false);
    use arbitrasaas_engine::strategy::Strategy;
    let opps = strategy.evaluate(&cache).await;
    assert!(opps.is_empty());
}

#[tokio::test]
async fn test_approval_router_paper_mode_never_executes() {
    let config = Arc::new(arbitrasaas_engine::config::EngineConfig::load("engine.toml").unwrap());
    assert_eq!(config.mode, arbitrasaas_engine::config::EngineMode::Paper);

    let (exec_tx, mut exec_rx) = mpsc::channel(16);
    let router = arbitrasaas_engine::approval::ApprovalRouter::new(
        config,
        None, // No telegram
        exec_tx,
    );

    // Create a high-profit opportunity that would auto-execute in non-paper mode
    let opp = arbitrasaas_engine::types::Opportunity {
        id: "test-123".to_string(),
        strategy: arbitrasaas_engine::types::StrategyKind::Triangular,
        route: "SOL -> RAY -> USDC -> SOL".to_string(),
        expected_profit_pct: rust_decimal::Decimal::new(500, 0), // 500% — way above threshold
        trade_size_usdc: rust_decimal::Decimal::new(5000, 0),
        instructions: vec![],
        detected_at: Instant::now(),
    };

    router.route(opp).await;

    // In paper mode, nothing should be sent to the executor
    let result = tokio::time::timeout(Duration::from_millis(100), exec_rx.recv()).await;
    assert!(result.is_err(), "Paper mode should not send to executor");
}
