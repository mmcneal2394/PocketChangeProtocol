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
mod tokens;

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
        "34sgN4q5CaaGCwqePU6d2y6xzBuY5ASA8E8LtXjfyN3c"
    ).ok();
    let vault_available = if let Some(pid) = vault_program_id {
        match rpc.get_account(&pid) {
            Ok(_) => { info!("Vault program found on-chain"); true }
            Err(_) => { warn!("Vault program not found — flash loan strategy disabled"); false }
        }
    } else {
        false
    };

    // 5b. Load token registry from API (falls back to hardcoded defaults)
    let api_base = std::env::var("NEXTJS_API_URL").unwrap_or_else(|_| "http://localhost:3000".to_string());
    let token_registry = Arc::new(tokens::TokenRegistry::load_from_api(&api_base).await);
    info!("Token registry: {} tokens loaded", token_registry.all().await.len());
    token_registry.spawn_refresh_task();

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

    // 8. Build approval router — single shared TelegramBot via Arc
    let telegram: Option<Arc<approval::telegram::TelegramBot>> =
        approval::telegram::TelegramBot::from_env().map(Arc::new);

    // Load persisted subscribers from DB on startup
    if let Some(ref tg) = telegram {
        for attempt in 1..=3 {
            tg.load_subscribers().await;
            let count = tg.subscriber_count().await;
            if count > 0 {
                info!("Loaded {} subscribers on attempt {}", count, attempt);
                break;
            }
            if attempt < 3 {
                warn!("No subscribers loaded (attempt {}), retrying in 5s...", attempt);
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        }
    }
    let (exec_tx, mut exec_rx) = mpsc::channel::<Opportunity>(64);

    let router = Arc::new(approval::ApprovalRouter::new(
        config.clone(),
        telegram.clone(),
        exec_tx,
    ));

    // 9. Spawn all tasks
    let mut tasks = JoinSet::new();

    // Price feed: Jupiter
    {
        let poller = price::jupiter::JupiterPoller::new(price_cache.clone(), price_tx.clone(), token_registry.clone());
        tasks.spawn(async move { poller.run(500).await; });
    }

    // Price feed: Multi-CEX (MEXC, Gate.io, KuCoin) — if CEX-DEX enabled
    if config.strategy_enabled("cex_dex") {
        let poller = price::cex::MultiCexPoller::new(price_cache.clone(), price_tx.clone());
        if poller.has_feeds() {
            tasks.spawn(async move { poller.run(2000).await; });
        } else {
            warn!("CEX-DEX enabled but all CEX price feeds disabled — skipping CEX feed");
        }
    }

    // Strategy detectors
    let (opp_tx, opp_rx) = mpsc::channel::<Opportunity>(128);

    let strategies: Vec<Arc<dyn Strategy>> = vec![
        Arc::new(strategy::triangular::TriangularStrategy::new(
            config.get_strategy_threshold("triangular"),
            token_registry.clone(),
        )),
        Arc::new(strategy::flash_loan::FlashLoanStrategy::new(
            config.get_strategy_threshold("flash_loan"),
            vault_available,
            token_registry.clone(),
        )),
        Arc::new(strategy::cex_dex::CexDexStrategy::new(
            config.get_strategy_threshold("cex_dex"),
            token_registry.clone(),
        )),
        Arc::new(strategy::funding_rate::FundingRateStrategy::new(
            config.get_strategy_threshold("funding_rate"),
        )),
        Arc::new(strategy::statistical::StatisticalStrategy::new(
            config.get_strategy_threshold("statistical"),
            token_registry.clone(),
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
        let telegram_for_executor = telegram.clone();
        tasks.spawn(async move {
            while let Some(opp) = exec_rx.recv().await {
                info!("Executing opportunity {} ({})", opp.id, opp.strategy);

                // In paper mode, send opportunity alert before simulation
                if let Some(ref tg) = telegram_for_executor {
                    let _ = tg.send_opportunity(&opp).await;
                }

                let result = e.execute(&opp, &w).await;
                if result.success {
                    info!("Trade succeeded: {} profit={:?}", opp.id, result.actual_profit_sol);
                } else {
                    warn!("Trade failed: {} error={:?}", opp.id, result.error);
                }

                // Send simulation/execution result to Telegram
                if let Some(ref tg) = telegram_for_executor {
                    let sim_msg = if result.success {
                        format!(
                            "<b>Simulation PASSED</b>\nStrategy: <code>{}</code>\nRoute: <code>{}</code>\nSimulated in {}ms",
                            opp.strategy, opp.route, result.execution_time_ms
                        )
                    } else {
                        format!(
                            "<b>Simulation FAILED</b>\nStrategy: <code>{}</code>\nError: <code>{}</code>",
                            opp.strategy, result.error.as_deref().unwrap_or("unknown")
                        )
                    };
                    let _ = tg.send_alert(&sim_msg).await;
                }
            }
        });
    }

    // Telegram poller — uses same shared Arc<TelegramBot> instance
    if let Some(ref bot) = telegram {
        let bot = bot.clone();
        let cb = circuit_breaker.clone();
        let cfg = config.clone();
        let start = std::time::Instant::now();
        tasks.spawn(async move {
            let mut last_update_id: i64 = 0;
            loop {
                let commands = bot.poll_updates(&mut last_update_id).await;
                for (_chat_id, cmd) in commands {
                    match cmd {
                        approval::telegram::TelegramCommand::Start |
                        approval::telegram::TelegramCommand::Stop => {
                            // Handled in poll_updates
                        }
                        approval::telegram::TelegramCommand::Status => {
                            let cb_state = cb.read().await;
                            let uptime = start.elapsed().as_secs();
                            let hours = uptime / 3600;
                            let mins = (uptime % 3600) / 60;
                            let mode = format!("{:?}", cfg.mode);
                            let msg = format!(
                                "<b>Engine Status</b>\n\nMode: {}\nUptime: {}h {}m\nCircuit Breaker: {}",
                                mode, hours, mins,
                                if cb_state.is_tripped() { "🔴 TRIPPED" } else { "🟢 OK" }
                            );
                            drop(cb_state);
                            let _ = bot.send_alert(&msg).await;
                        }
                    }
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        });
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
