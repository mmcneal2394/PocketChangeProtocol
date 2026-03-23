mod config;
mod db;
mod kms;
mod types;
mod rpc;
mod price;
mod strategy;
mod approval;
mod executor;
mod engine;

use std::sync::Arc;
use std::str::FromStr;
use tokio::sync::{broadcast, mpsc, RwLock};
use tokio::task::JoinSet;
use tracing::{info, warn, error};

use config::EngineConfig;
use db::TelemetryWriter;
use price::PriceCache;
use executor::circuit_breaker::CircuitBreaker;
use strategy::Strategy;
use types::*;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. Load config
    let config = Arc::new(EngineConfig::load("engine.toml").unwrap_or_else(|e| {
        eprintln!("Failed to load engine.toml: {}. Using defaults.", e);
        toml::from_str(r#"
            mode = "paper"
            jito_endpoint = "https://mainnet.block-engine.jito.wtf"
            auto_execute_threshold_default = 0.5
            approval_timeout_secs = 300
            max_loss_24h = 50.0
            max_trade_size = 10.0
        "#).unwrap()
    }));

    // 2. Init structured logger
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("arbitrasaas_engine=info".parse().unwrap())
        )
        .init();

    info!(mode = ?config.mode, "Starting ArbitraSaaS Engine");

    // 3. KMS — try env, fall back to dev key for paper mode
    let wallet = match kms::KMSClient::from_env() {
        Ok(_kms) => {
            info!("KMS initialized from environment");
            // In production, decrypt wallet here
            solana_sdk::signature::Keypair::new() // Placeholder until wallet is encrypted
        }
        Err(e) => {
            warn!("KMS not configured: {}. Using ephemeral keypair.", e);
            solana_sdk::signature::Keypair::new()
        }
    };
    let wallet = Arc::new(wallet);

    // 4. Connect to Solana RPC
    let rpc_url = config.rpc_url();
    info!(rpc = %rpc_url, "Connecting to Solana RPC");
    let rpc = Arc::new(solana_client::rpc_client::RpcClient::new(rpc_url));

    // 5. Check vault program
    let vault_program_id = solana_sdk::pubkey::Pubkey::from_str(
        "FSRUKKMxfWNDiVKKVyxiaaweZR8HZEMnsyHmb8caPjAy"
    ).ok();
    let vault_available = if let Some(pid) = vault_program_id {
        match rpc.get_account(&pid) {
            Ok(_) => { info!("Vault program found on-chain"); true }
            Err(_) => { warn!("Vault program not found — flash loan strategy disabled"); false }
        }
    } else {
        false
    };

    // 6. Init shared state
    let price_cache = Arc::new(RwLock::new(PriceCache::new()));
    let (price_tx, _) = broadcast::channel::<PriceSnapshot>(256);
    let cb = CircuitBreaker::new(
        rust_decimal::Decimal::from_f64_retain(config.max_loss_24h).unwrap_or_default(),
        rust_decimal::Decimal::from_f64_retain(config.max_trade_size * 2.0).unwrap_or_default(),
    );
    let circuit_breaker = Arc::new(RwLock::new(cb));
    let telemetry = Arc::new(TelemetryWriter::new("telemetry.jsonl"));

    // 7. Build executor
    let jito = executor::jito::JitoClient::new(config.jito_endpoint.clone());
    let simulator = executor::simulator::Simulator::new(rpc.clone());
    let exec = Arc::new(executor::Executor::new(
        config.mode,
        jito,
        simulator,
        circuit_breaker.clone(),
        telemetry.clone(),
        rpc.clone(),
    ));

    // 8. Build approval router
    let telegram = approval::telegram::TelegramBot::from_env();
    let has_telegram = telegram.is_some();
    let (exec_tx, mut exec_rx) = mpsc::channel::<Opportunity>(64);

    // We need to share telegram with multiple tasks — wrap in Arc
    // ApprovalRouter takes Option<TelegramBot> by value, so build it first
    // then we'll create a second TelegramBot instance for polling if needed
    let router = Arc::new(approval::ApprovalRouter::new(
        config.clone(),
        telegram,
        exec_tx,
    ));

    // 9. Spawn all tasks
    let mut tasks = JoinSet::new();

    // Price feed: Jupiter
    {
        let poller = price::jupiter::JupiterPoller::new(price_cache.clone(), price_tx.clone());
        tasks.spawn(async move { poller.run(500).await; });
    }

    // Price feed: Bitget (if CEX-DEX enabled)
    if config.strategy_enabled("cex_dex") {
        if let Some(poller) = price::cex::BitgetPoller::from_env(price_cache.clone(), price_tx.clone()) {
            tasks.spawn(async move { poller.run(2000).await; });
        } else {
            warn!("CEX-DEX enabled but BITGET_API_KEY not set — skipping CEX feed");
        }
    }

    // Strategy detectors
    let (opp_tx, opp_rx) = mpsc::channel::<Opportunity>(128);

    let strategies: Vec<Arc<dyn Strategy>> = vec![
        Arc::new(strategy::triangular::TriangularStrategy::new(
            config.get_strategy_threshold("triangular"),
        )),
        Arc::new(strategy::flash_loan::FlashLoanStrategy::new(
            config.get_strategy_threshold("flash_loan"),
            vault_available,
        )),
        Arc::new(strategy::cex_dex::CexDexStrategy::new(
            config.get_strategy_threshold("cex_dex"),
        )),
        Arc::new(strategy::funding_rate::FundingRateStrategy::new(
            config.get_strategy_threshold("funding_rate"),
        )),
        Arc::new(strategy::statistical::StatisticalStrategy::new(
            config.get_strategy_threshold("statistical"),
        )),
    ];

    for strat in strategies {
        if !config.strategy_enabled(&strat.kind().to_string()) {
            info!("Strategy {} is disabled", strat.name());
            continue;
        }
        let rx = price_tx.subscribe();
        let tx = opp_tx.clone();
        let cache = price_cache.clone();
        info!("Starting strategy detector: {}", strat.name());
        tasks.spawn(async move {
            strategy::run_detector(strat, rx, tx, cache).await;
        });
    }
    drop(opp_tx); // Drop sender so receiver closes when all detectors stop

    // Approval router: forward opportunities
    {
        let r = router.clone();
        tasks.spawn(async move {
            let mut rx = opp_rx;
            while let Some(opp) = rx.recv().await {
                r.route(opp).await;
            }
        });
    }

    // Approval router: expire stale opportunities
    {
        let r = router.clone();
        tasks.spawn(async move { r.run_expiry_loop().await; });
    }

    // Executor consumer: process approved opportunities
    {
        let e = exec.clone();
        let w = wallet.clone();
        tasks.spawn(async move {
            while let Some(opp) = exec_rx.recv().await {
                info!("Executing opportunity {} ({})", opp.id, opp.strategy);
                let result = e.execute(&opp, &w).await;
                if result.success {
                    info!("Trade succeeded: {} profit={:?}", opp.id, result.actual_profit_sol);
                } else {
                    warn!("Trade failed: {} error={:?}", opp.id, result.error);
                }
            }
        });
    }

    // Telegram poller (create a second instance from env since TelegramBot is not Clone)
    if has_telegram {
        if let Some(bot) = approval::telegram::TelegramBot::from_env() {
            let r = router.clone();
            let cb = circuit_breaker.clone();
            tasks.spawn(async move {
                let mut last_update_id: i64 = 0;
                loop {
                    let commands = bot.poll_updates(&mut last_update_id).await;
                    for cmd in commands {
                        match cmd {
                            approval::telegram::TelegramCommand::Approve(id) => {
                                match r.approve(&id).await {
                                    Ok(_) => { let _ = bot.send_alert("Approved").await; }
                                    Err(e) => { let _ = bot.send_alert(&format!("Approve failed: {}", e)).await; }
                                }
                            }
                            approval::telegram::TelegramCommand::Reject(id) => {
                                let _ = r.reject(&id).await;
                                let _ = bot.send_alert("Rejected").await;
                            }
                            approval::telegram::TelegramCommand::Resume => {
                                cb.write().await.resume();
                                let _ = bot.send_alert("Circuit breaker resumed").await;
                            }
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            });
        }
    }

    // HTTP API server
    {
        let state = Arc::new(approval::http_server::AppState {
            router: router.clone(),
            circuit_breaker: circuit_breaker.clone(),
            config: config.clone(),
            start_time: std::time::Instant::now(),
            price_cache: price_cache.clone(),
        });
        tasks.spawn(async move {
            approval::http_server::start_server(state, 3002).await;
        });
    }

    info!("Engine started in {:?} mode — all systems go", config.mode);

    // 10. Await shutdown
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {
            info!("Received Ctrl+C, shutting down...");
        }
        res = async { tasks.join_next().await } => {
            if let Some(Err(e)) = res {
                error!("Task panicked: {}", e);
            }
        }
    }

    info!("Engine shut down.");
    Ok(())
}
