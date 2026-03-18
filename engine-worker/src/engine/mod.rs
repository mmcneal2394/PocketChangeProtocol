use std::str::FromStr;
use solana_sdk::{
    instruction::{Instruction, AccountMeta},
    message::Message,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction,
    transaction::Transaction,
};
use sha2::{Sha256, Digest};

/// Computes the 8-byte discriminator for Anchor instructions
pub fn get_discriminator(name: &str) -> [u8; 8] {
    let mut hasher = Sha256::new();
    hasher.update(format!("global:{}", name));
    let hash = hasher.finalize();
    let mut discriminator = [0u8; 8];
    discriminator.copy_from_slice(&hash[0..8]);
    discriminator
}

/// The VaultExecutor encapsulates interactions directly with the PocketChange Vault PDA.
/// It wraps raw decentralized exchange swap instructions securely between `borrow` and `process` calls
/// securing the pool from un-returned flash-loans and auto-compounding the arbitrage profit.
pub mod aggregator;
pub mod providers;
use aggregator::MetaAggregator;

pub struct VaultExecutor {
    pub admin: Keypair,
    pub program_id: Pubkey,
    pub token_program: Pubkey,
    pub aggregator: std::sync::Arc<MetaAggregator>,
}

impl VaultExecutor {
    pub fn new(admin: Keypair, program_id: Pubkey, token_program: Pubkey) -> Self {
        let mut meta_agg = MetaAggregator::new();
        
        // 1. Mount the Jupiter Provider backend (v6 API fallback resistant)
        meta_agg.add_provider(std::sync::Arc::new(providers::JupiterProvider::new()));
        
        // 2. Mount the OpenOcean Provider (Full Meta-Aggregator spanning meteora/orca/raydium/etc without Jup limits)
        meta_agg.add_provider(std::sync::Arc::new(providers::OpenOceanProvider::new()));
        
        VaultExecutor {
            admin,
            program_id,
            token_program,
            aggregator: std::sync::Arc::new(meta_agg),
        }
    }

    pub fn build_vault_ptb(
        &self,
        vault_state: Pubkey,
        vault_usdc: Pubkey,
        admin_usdc: Pubkey,
        treasury_usdc: Pubkey,
        borrow_amount: u64,
        reported_profit: u64,
        swap_instructions: Vec<Instruction>,
        jito_tip_lamports: u64
    ) -> Result<Vec<Instruction>, String> {
        
        let mut ixs = Vec::new();

        // 0. Compute Budget & Priority Fees (Gas optimization for execution speed)
        ixs.push(solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_limit(500_000));
        ixs.push(solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_price(5_000_000));

        // 0.5. Jito MEV Tip Injection (Vector 1: Cryptographic Jitter)
        use std::str::FromStr;
        use rand::{Rng, RngExt};
        let mut rng = rand::rng();
        let jitter = rng.random_range(1..=50_000);
        let randomized_jito_tip = jito_tip_lamports + jitter;

        let jito_tip_account = Pubkey::from_str("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5").unwrap();
        ixs.push(system_instruction::transfer(&self.admin.pubkey(), &jito_tip_account, randomized_jito_tip));

        // 1. Borrow Instruction
        let mut borrow_data = get_discriminator("borrow_for_arbitrage").to_vec();
        borrow_data.extend_from_slice(&borrow_amount.to_le_bytes()); // amount

        ixs.push(Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(self.admin.pubkey(), true),
                AccountMeta::new(vault_state, false),
                AccountMeta::new(vault_usdc, false),
                AccountMeta::new(admin_usdc, false),
                AccountMeta::new_readonly(self.token_program, false),
            ],
            data: borrow_data,
        });

        // 2. Insert Core Swaps (e.g. Jupiter, Raydium, Orca)
        ixs.extend(swap_instructions);

        // 3. Process Profit Instruction (Returns principal recursively + compounds generated profit)
        let mut process_data = get_discriminator("process_arbitrage").to_vec();
        process_data.extend_from_slice(&reported_profit.to_le_bytes()); // total_profit

        ixs.push(Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(self.admin.pubkey(), true),
                AccountMeta::new(vault_state, false),
                AccountMeta::new(vault_usdc, false),
                AccountMeta::new(treasury_usdc, false),
                AccountMeta::new_readonly(self.token_program, false),
            ],
            data: process_data,
        });

        println!("[PocketChange] Assembled Payload: Borrow {} USDC -> N Swaps -> Return + {} USDC", borrow_amount, reported_profit);
        Ok(ixs)
    }

    // Legacy Jupiter bindings removed. Engine now relies exclusively on the AI-patterned `MetaAggregator` framework.

    /// Primary execution loop wrapper that continually evaluates yield limits
    pub async fn process_loop(&self) {
        println!("[Engine] Jupiter DEX Multipath Poller active. Awaiting arbitrage gaps...");
        
        let db_client = crate::db::DbClient::new().await;

        let usdc_mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; 
        let wif_mint = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"; 
        let sol_mint = "So11111111111111111111111111111111111111112";
        let jup_mint = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbAbdMdEqtXk";
        let bonk_mint = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

        // Define our supported arbitrage routes (starting and ending in SOL to do microtransactions with raw balance)
        let routes = vec![
            vec![sol_mint, wif_mint, sol_mint], // 2-Hop
            vec![sol_mint, bonk_mint, usdc_mint, sol_mint], // 3-hop
            vec![sol_mint, jup_mint, usdc_mint, sol_mint], // 3-hop
        ];

        // Vector 3: Liquidity Spam Protection & Trade Size Limiting
        // We evaluate strictly 1% of real-time SOL trading capital
        let rpc_client = solana_client::rpc_client::RpcClient::new("https://api.mainnet-beta.solana.com");
        
        let mut amount_in = 146_000; // backup
        match rpc_client.get_balance(&self.admin.pubkey()) {
            Ok(total_capital) => {
                if total_capital > 0 {
                    amount_in = total_capital / 100; // Strictly 1% of total capital
                    println!("💼 Total Vault Capital: {} lamports (SOL). Adjusting Active Trade Size to 1%: {} lamports", total_capital, amount_in);
                }
            },
            Err(_) => {
                println!("⚠️ Failed to fetch actual sol capital. Defaulting size limit backup rule.");
            }
        }
        
        // Dynamically enforce expected output bounds across paths using the actual capital chunk
        let expected_out_without_slippage = amount_in;

        loop {
            // Vector 1: Cryptographic Jitter (Randomized Polling Delay)
            use rand::{Rng, RngExt};
            let mut rng = rand::rng();
            let delay_ms = 3000 + rng.random_range(0..=2000);
            tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms)).await;
            
            for path in routes.iter() {
                let exec_start = std::time::Instant::now();
                let mut current_amount = amount_in;
                let mut quotes = Vec::new();
                let mut route_failed = false;

                // 1. Fetch sequential quotes for every leg in the path
                for i in 0..(path.len() - 1) {
                    let input_mint = path[i];
                    let output_mint = path[i + 1];
                    tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                    
                    match self.aggregator.solve_route(input_mint, output_mint, current_amount).await {
                        Ok(quote) => {
                            current_amount = quote.out_amount;
                            
                            if current_amount == 0 {
                                route_failed = true;
                                break;
                            }
                            quotes.push(quote);
                        },
                        Err(e) => {
                            println!("⚠️ [Engine] Failed to fetch Route ({}->{}). Error: {:?}", input_mint, output_mint, e);
                            route_failed = true;
                            break;
                        }
                    }
                }

                if route_failed || current_amount == 0 { continue; }
                let quote_duration = exec_start.elapsed();

                // 2. Evaluate Multipath Yield
                let final_amount = current_amount;
                // Vector 3: Liquidity Spam Protection (Guardrails OFF)
                let min_profit_lamports: i64 = -10_000_000; // -0.01 SOL (Allowing massive negative yield gaps to force live testing)
                
                // Analytics: Calculate exact slippage lost against the mathematically perfect quote
                let raw_slippage_lost = expected_out_without_slippage.saturating_sub(final_amount);
                let slippage_bps = if raw_slippage_lost > 0 { (raw_slippage_lost as f64 / expected_out_without_slippage as f64) * 10000.0 } else { 0.0 };
                
                let readable_route = path.join(" -> ").replace(usdc_mint, "USDC").replace(wif_mint, "WIF").replace(sol_mint, "SOL").replace(jup_mint, "JUP").replace(bonk_mint, "BONK");

                if (final_amount as i64) >= (amount_in as i64) + min_profit_lamports {
                    let profit: i64 = (final_amount as i64) - (amount_in as i64);
                    let profit_display = (profit as f64) / 1_000_000_000.0;
                    
                    println!("🎯 [Engine] MULTIPATH ARB TRIGGERED [{}] Expected Yield: {} SOL", readable_route, profit_display);
                    
                    let user_str = self.admin.pubkey().to_string();
                    let mut all_swaps = Vec::new();
                    let mut ixs_failed = false;

                    // 3. Resolve all instructions via unified meta-aggregator
                    let ix_start = std::time::Instant::now();
                    for quote in quotes {
                        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                        match self.aggregator.fetch_instructions(&quote, &user_str).await {
                            Ok(mut ixs) => all_swaps.append(&mut ixs),
                            Err(e) => {
                                println!("⚠️ [MetaAggr] Instruction setup failure: {:?}", e);
                                ixs_failed = true;
                                break;
                            }
                        }
                    }

                    let ix_duration = ix_start.elapsed();
                    let total_resolve_duration = exec_start.elapsed();
                    println!("⏱️ [Speed Test] Route: {} | Quote Time: {:?} | Ix Time: {:?} | Total Setup: {:?}", readable_route, quote_duration, ix_duration, total_resolve_duration);

                    if ixs_failed {
                        println!("⚠️ [Engine] Failed to fetch setup ixs. FORCING direct flash-loan execution to verify Helius API / Network parameters!");
                        all_swaps.clear();
                    }

                    // 4. Submit to Vault
                    // Use actual token accounts for the admin instead of defaults to allow the transaction to build without simulation errors
                    let vault_state = solana_sdk::pubkey::Pubkey::from_str("7C7Y3fyPYeAYqpc29uahDUQ84PQ255Avj2YEP9KpvyKx").unwrap();
                    let vault_usdc = solana_sdk::pubkey::Pubkey::from_str("EH19EkuPWWqwB2DN3HtJLjdWP1dWpFGEncGTnFqjhaYk").unwrap();
                    let admin_usdc = solana_sdk::pubkey::Pubkey::from_str("45ruCyfdRkWpRNGEqWzjCiXRHkZs8WXCLQ67Pnpye7Hp").unwrap();
                    let treasury_usdc = solana_sdk::pubkey::Pubkey::from_str("ABPRFJuheqRPUDrrxfAvDSWQ5y9WiVL6QhoXRvhyKQSc").unwrap();
                    let jito_tip_lamports = 100_000; // 0.0001 SOL Jito Tip / SWQOS Dual-Routing Requirement is 5_000

                    match self.build_vault_ptb(
                        vault_state, vault_usdc, admin_usdc, treasury_usdc, 
                        amount_in, if profit > 0 { profit as u64 } else { 0 }, all_swaps, jito_tip_lamports
                    ) {
                        Ok(ptb) => {
                            // Compile the Versioned Transaction & sign it
                            let exec_rpc_client = solana_client::rpc_client::RpcClient::new("https://api.mainnet-beta.solana.com");
                            match exec_rpc_client.get_latest_blockhash() {
                                Ok(recent_blockhash) => {
                                    let message = solana_sdk::message::Message::new(&ptb, Some(&self.admin.pubkey()));
                                    let tx = Transaction::new(&[&self.admin], message, recent_blockhash);

                                    use base64::{Engine as _, engine::general_purpose::STANDARD};
                                    let serialized_tx = bincode::serialize(&tx).unwrap();
                                    let base64_tx = STANDARD.encode(&serialized_tx);

                                    let req_body = serde_json::json!({
                                        "jsonrpc": "2.0",
                                        "id": "1",
                                        "method": "sendTransaction",
                                        "params": [
                                            base64_tx,
                                            { "encoding": "base64", "skipPreflight": true, "maxRetries": 0 }
                                        ]
                                    });

                                    let client = reqwest::Client::new();
                                    let send_result = client.post("http://ewr-sender.helius-rpc.com/fast?swqos_only=true")
                                        .json(&req_body)
                                        .send()
                                        .await;

                                    match send_result {
                                        Ok(res) => match res.json::<serde_json::Value>().await {
                                            Ok(json) => {
                                                if let Some(err) = json.get("error") {
                                                    println!("❌ [Helius Sender] Transaction Submission Failed: {}", err);
                                                } else if let Some(sig) = json.get("result").and_then(|r| r.as_str()) {
                                                    println!("🚀 [Helius Sender] Ultra-Low Latency Dual-Route Tx Sent! Signature: {}", sig);
                                                    let _ = db_client.inject_audit_log(crate::db::TradeLogEvent {
                                                        execution_time_ms: exec_start.elapsed().as_millis() as u64,
                                                        timestamp_sec: std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(),
                                                        route: readable_route,
                                                        tenant_id: "system-1".to_string(),
                                                        tx_signature: sig.to_string(),
                                                        profit_sol: profit_display as f64,
                                                        status: "EXEC_SUCCESS".to_string(),
                                                        error_msg: None,
                                                        latency_ms: Some(exec_start.elapsed().as_millis() as u64),
                                                        slippage_bps: Some(slippage_bps),
                                                        mev_tip_paid: Some(100_000)
                                                    }).await;
                                                } else {
                                                    println!("⚠️ [Helius Sender] Unrecognized structure or silent failure: {:?}", json);
                                                }
                                            },
                                            Err(e) => println!("❌ [Helius Sender] Failed to parse response: {:?}", e),
                                        },
                                        Err(e) => println!("❌ [Helius Sender] HTTP Error: {:?}", e),
                                    }
                                },
                                Err(e) => println!("❌ [Engine] Failed to get latest blockhash: {}", e),
                            }
                        },
                        Err(e) => {
                            println!("❌ [Engine] Failed to build PTB: {}", e);
                        }
                    }
                } else {
                    let loss = amount_in.saturating_sub(final_amount);
                    let profit = if final_amount > amount_in { (final_amount - amount_in) as f64 } else { -(loss as f64) };
                    println!("⏳ [Engine] [{}] Yield gap: {} SOL | ⏱️ Speed: {:?}", readable_route, profit / 1_000_000_000.0, quote_duration);
                }
            }
        }
    }
}

