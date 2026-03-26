use async_trait::async_trait;
use rust_decimal::Decimal;
use rust_decimal::prelude::*;
use solana_sdk::instruction::{Instruction, AccountMeta};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};
use uuid::Uuid;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;
use tracing::{info, warn, debug};
use crate::types::*;
use crate::price::PriceCache;
use crate::strategy::{Strategy, execution_cost_pct};
use crate::executor::cex_executor::CexDexPosition;
use crate::tokens::TokenRegistry;

/// CEX spot market order fee (MEXC/Gate/KuCoin taker fee).
const CEX_TAKER_FEE_PCT: f64 = 0.1;
/// CEX withdrawal fee to Solana (~0.01 SOL, varies by exchange).
const CEX_WITHDRAWAL_FEE_SOL: f64 = 0.01;
/// Combined CEX-CEX taker fees: buy side (0.1%) + sell side (0.1%).
const CEX_CEX_FEES_PCT: f64 = 0.2;

/// Map a CEX source id (e.g. "mexc") to a human-readable label for route strings.
fn cex_display_name(source: &str) -> &str {
    match source {
        "mexc" => "MEXC",
        "gate" => "Gate.io",
        "kucoin" => "KuCoin",
        _ => source,
    }
}

const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

pub struct CexDexStrategy {
    threshold: Decimal,
    open_position: Arc<Mutex<Option<CexDexPosition>>>,
    client: reqwest::Client,
    registry: Arc<TokenRegistry>,
}

impl CexDexStrategy {
    pub fn new(threshold: f64, registry: Arc<TokenRegistry>) -> Self {
        Self {
            threshold: Decimal::from_f64(threshold).unwrap_or(Decimal::new(1, 0)),
            open_position: Arc::new(Mutex::new(None)),
            client: reqwest::Client::new(),
            registry,
        }
    }

    /// Resolve a token symbol (e.g. "SOL") to its Solana mint address.
    fn resolve_mint(&self, symbol: &str) -> Option<String> {
        self.registry.resolve_mint(symbol).map(|s| s.to_string())
    }

    /// Extract the token symbol from an opportunity route string.
    /// Routes look like "SOL buy DEX, sell CEX (spread 1.50%)"
    fn parse_token_from_route(route: &str) -> Option<&str> {
        route.split_whitespace().next()
    }

    /// Determine the trade size in token base units from USDC amount and a rough price.
    /// For the DEX leg we convert USDC notional to lamports/base-units.
    fn usdc_to_base_units(&self, symbol: &str, usdc_amount: f64) -> u64 {
        // Rough prices for sizing — actual execution uses Jupiter quote output
        let price_est: f64 = match symbol {
            "SOL" => 150.0,
            "RAY" => 2.0,
            "WIF" => 1.5,
            "BONK" => 0.00002,
            "mSOL" => 160.0,
            "JitoSOL" => 165.0,
            _ => 1.0,
        };
        let decimals = self.registry.resolve_decimals(symbol);
        let token_amount = usdc_amount / price_est;
        (token_amount * 10_f64.powi(decimals as i32)) as u64
    }

    /// Fetch a Jupiter quote for the DEX leg (buy token with USDC or sell token for USDC).
    async fn fetch_jupiter_quote(
        &self,
        input_mint: &str,
        output_mint: &str,
        amount: u64,
    ) -> anyhow::Result<serde_json::Value> {
        let url = format!(
            "https://public.jupiterapi.com/quote?inputMint={}&outputMint={}&amount={}&slippageBps=50",
            input_mint, output_mint, amount
        );
        let resp = self.client.get(&url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(anyhow::anyhow!("Jupiter quote failed: HTTP {}", resp.status()));
        }
        let json: serde_json::Value = resp.json().await?;
        if json.get("error").is_some() {
            return Err(anyhow::anyhow!("Jupiter quote error: {}", json));
        }
        Ok(json)
    }

    /// Fetch swap instructions from Jupiter for a given quote.
    async fn fetch_swap_instructions(
        &self,
        quote_response: &serde_json::Value,
        user_pubkey: &str,
    ) -> anyhow::Result<Vec<Instruction>> {
        let payload = serde_json::json!({
            "quoteResponse": quote_response,
            "userPublicKey": user_pubkey,
            "wrapAndUnwrapSol": true,
        });

        let resp = self.client.post("https://public.jupiterapi.com/swap-instructions")
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .header("Content-Type", "application/json")
            .json(&payload)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await?;

        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() || body.contains("\"error\"") {
            return Err(anyhow::anyhow!("Jupiter swap-instructions failed ({}): {}", status, body));
        }

        let data: serde_json::Value = serde_json::from_str(&body)?;
        let mut instructions = Vec::new();

        let parse_ix = |ix: &serde_json::Value| -> anyhow::Result<Instruction> {
            let program_id = ix["programId"].as_str().unwrap_or_default()
                .parse::<Pubkey>().map_err(|e| anyhow::anyhow!("bad programId: {}", e))?;
            let data_b64 = ix["data"].as_str().unwrap_or_default();
            let ix_data = base64::Engine::decode(
                &base64::engine::general_purpose::STANDARD, data_b64
            ).unwrap_or_default();
            let accounts = ix["accounts"].as_array()
                .ok_or_else(|| anyhow::anyhow!("missing accounts array"))?
                .iter()
                .map(|acc| {
                    let pubkey = acc["pubkey"].as_str().unwrap_or_default()
                        .parse::<Pubkey>().unwrap_or_default();
                    let is_signer = acc["isSigner"].as_bool().unwrap_or(false);
                    let is_writable = acc["isWritable"].as_bool().unwrap_or(false);
                    if is_writable {
                        AccountMeta::new(pubkey, is_signer)
                    } else {
                        AccountMeta::new_readonly(pubkey, is_signer)
                    }
                })
                .collect();
            Ok(Instruction { program_id, accounts, data: ix_data })
        };

        // Setup instructions (ATA creation, etc.)
        if let Some(setup) = data["setupInstructions"].as_array() {
            for ix in setup {
                instructions.push(parse_ix(ix)?);
            }
        }

        // Core swap instruction
        if let Some(swap) = data["swapInstruction"].as_object() {
            instructions.push(parse_ix(&serde_json::Value::Object(swap.clone()))?);
        } else {
            return Err(anyhow::anyhow!("Missing swapInstruction in Jupiter response"));
        }

        Ok(instructions)
    }
}

#[async_trait]
impl Strategy for CexDexStrategy {
    fn name(&self) -> &str { "CEX-DEX" }
    fn kind(&self) -> StrategyKind { StrategyKind::CexDex }

    async fn evaluate(&self, prices: &PriceCache) -> Vec<Opportunity> {
        // One position at a time
        if self.open_position.lock().await.is_some() {
            return vec![];
        }

        let mut opportunities = Vec::new();
        let cex_tokens: Vec<String> = self.registry.for_strategy("cex_dex")
            .iter()
            .filter(|t| t.symbol != "USDC")
            .map(|t| t.symbol.clone())
            .collect();

        for token in &cex_tokens {
            let token = token.as_str();
            // DEX (Jupiter) price — stored under plain mint key
            let dex_price = match prices.get_price(token) {
                Some(p) => p,
                None => continue,
            };

            // Check all configured CEX sources for this token
            let cex_prices = prices.get_cex_prices(token);
            if cex_prices.is_empty() {
                continue;
            }

            // Get SOL price for USDC conversion of on-chain costs
            let sol_price = prices.get_price("SOL").unwrap_or(150.0);
            let trade_size = 100.0_f64; // USDC

            for (source, cex_price) in &cex_prices {
                let spread_pct = ((cex_price - dex_price) / dex_price * 100.0).abs();

                // --- Accurate fee calculation ---
                // DEX leg: Jito tip + priority fee (1 transaction)
                let dex_fixed_pct = execution_cost_pct(sol_price, trade_size, 1);
                // CEX withdrawal fee converted to pct of trade size
                let withdrawal_fee_pct = (CEX_WITHDRAWAL_FEE_SOL * sol_price / trade_size) * 100.0;
                // Total fees = CEX taker + DEX fixed + withdrawal
                let total_fees_pct = CEX_TAKER_FEE_PCT + dex_fixed_pct + withdrawal_fee_pct;
                let net_profit = spread_pct - total_fees_pct;

                // Only execute when spread > 2x fees
                if net_profit > self.threshold.to_f64().unwrap_or(1.0)
                    && spread_pct > total_fees_pct * 2.0
                {
                    let direction = if cex_price > &dex_price {
                        "buy DEX, sell CEX"
                    } else {
                        "buy CEX, sell DEX"
                    };
                    debug!(
                        "CEX-DEX opportunity: {} on {} spread {:.4}% fees={:.4}% net={:.4}% ({})",
                        token, source, spread_pct, total_fees_pct, net_profit, direction
                    );

                    opportunities.push(Opportunity {
                        id: Uuid::new_v4().to_string(),
                        strategy: StrategyKind::CexDex,
                        route: format!(
                            "{} {} via {} (spread {:.2}%)",
                            token, direction, source, spread_pct
                        ),
                        expected_profit_pct: Decimal::from_f64(net_profit).unwrap_or_default(),
                        estimated_fees_pct: Decimal::from_f64(total_fees_pct).unwrap_or_default(),
                        trade_size_usdc: Decimal::new(45, 0), // Lower size for non-atomic
                        instructions: vec![],
                        detected_at: Instant::now(),
                    });
                }
            }
        }

        // -----------------------------------------------------------------
        // CEX-CEX: compare prices across exchanges for the same token
        // -----------------------------------------------------------------
        for token in &cex_tokens {
            let token = token.as_str();
            let cex_prices = prices.get_cex_prices(token);
            if cex_prices.len() < 2 {
                continue;
            }

            // Find cheapest and most expensive CEX for this token
            let &(buy_exchange, buy_price) = cex_prices
                .iter()
                .min_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
                .unwrap();
            let &(sell_exchange, sell_price) = cex_prices
                .iter()
                .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap())
                .unwrap();

            // Same exchange means no arb
            if buy_exchange == sell_exchange {
                continue;
            }

            let spread_pct = ((sell_price - buy_price) / buy_price) * 100.0;

            // Get SOL price for converting withdrawal cost to percentage
            let sol_price = prices.get_price("SOL").unwrap_or(150.0);
            let trade_size = 100.0_f64; // USDC

            // CEX-CEX fees: buy taker (0.1%) + sell taker (0.1%) + withdrawal tx cost
            let withdrawal_cost_pct = execution_cost_pct(sol_price, trade_size, 1);
            let total_fees_pct = CEX_CEX_FEES_PCT + withdrawal_cost_pct;
            let net_profit = spread_pct - total_fees_pct;

            if net_profit > self.threshold.to_f64().unwrap_or(1.0) {
                debug!(
                    "CEX-CEX opportunity: {} buy {} @ ${:.4} → sell {} @ ${:.4} (spread {:.4}% fees={:.4}% net={:.4}%)",
                    token,
                    cex_display_name(buy_exchange),
                    buy_price,
                    cex_display_name(sell_exchange),
                    sell_price,
                    spread_pct,
                    total_fees_pct,
                    net_profit,
                );

                opportunities.push(Opportunity {
                    id: Uuid::new_v4().to_string(),
                    strategy: StrategyKind::CexDex,
                    route: format!(
                        "{} buy {} @ ${:.2} → sell {} @ ${:.2} (spread {:.2}%)",
                        token,
                        cex_display_name(buy_exchange),
                        buy_price,
                        cex_display_name(sell_exchange),
                        sell_price,
                        spread_pct,
                    ),
                    expected_profit_pct: Decimal::from_f64(net_profit).unwrap_or_default(),
                    estimated_fees_pct: Decimal::from_f64(total_fees_pct).unwrap_or_default(),
                    trade_size_usdc: Decimal::new(45, 0),
                    instructions: vec![], // CEX-CEX: no on-chain instructions
                    detected_at: Instant::now(),
                });
            }
        }

        // Sort by profit — best opportunity first
        opportunities.sort_by(|a, b| b.expected_profit_pct.cmp(&a.expected_profit_pct));
        opportunities
    }

    fn build_instructions(&self, opp: &Opportunity, wallet: &Keypair) -> anyhow::Result<Vec<Instruction>> {
        // DEX leg only — CEX leg handled by MultiCexExecutor after DEX confirms
        info!("Building DEX leg instructions for CEX-DEX: {}", opp.route);

        let token = Self::parse_token_from_route(&opp.route)
            .ok_or_else(|| anyhow::anyhow!("Cannot parse token from route: {}", opp.route))?;
        let token_mint = self.resolve_mint(token)
            .ok_or_else(|| anyhow::anyhow!("Unknown token mint for: {}", token))?;

        // Determine direction: "buy DEX" means USDC -> token on-chain
        let buying_on_dex = opp.route.contains("buy DEX");
        let (input_mint, output_mint, amount) = if buying_on_dex {
            // Buy token on DEX with USDC
            let usdc_amount = opp.trade_size_usdc.to_f64().unwrap_or(2000.0);
            let base_units = (usdc_amount * 1_000_000.0) as u64; // USDC has 6 decimals
            (USDC_MINT.to_string(), token_mint, base_units)
        } else {
            // Sell token on DEX for USDC
            let usdc_amount = opp.trade_size_usdc.to_f64().unwrap_or(2000.0);
            let base_units = self.usdc_to_base_units(token, usdc_amount);
            (token_mint, USDC_MINT.to_string(), base_units)
        };

        let user_pubkey = wallet.pubkey().to_string();

        // Block on async Jupiter calls from sync context (we're inside a tokio runtime)
        let handle = tokio::runtime::Handle::current();
        let client = self.client.clone();

        let instructions = tokio::task::block_in_place(|| {
            handle.block_on(async {
                // Step 1: Get Jupiter quote
                let quote_url = format!(
                    "https://public.jupiterapi.com/quote?inputMint={}&outputMint={}&amount={}&slippageBps=50",
                    input_mint, output_mint, amount
                );
                let resp = client.get(&quote_url)
                    .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
                    .timeout(std::time::Duration::from_secs(10))
                    .send()
                    .await
                    .map_err(|e| anyhow::anyhow!("Jupiter quote request failed: {}", e))?;

                if !resp.status().is_success() {
                    return Err(anyhow::anyhow!("Jupiter quote HTTP {}", resp.status()));
                }
                let quote: serde_json::Value = resp.json().await
                    .map_err(|e| anyhow::anyhow!("Jupiter quote parse failed: {}", e))?;
                if quote.get("error").is_some() {
                    return Err(anyhow::anyhow!("Jupiter quote error: {}", quote));
                }

                info!("Jupiter quote: {} {} -> {} outAmount={}",
                    token, input_mint, output_mint,
                    quote["outAmount"].as_str().unwrap_or("?"));

                // Step 2: Get swap instructions
                let payload = serde_json::json!({
                    "quoteResponse": quote,
                    "userPublicKey": user_pubkey,
                    "wrapAndUnwrapSol": true,
                });
                let resp = client.post("https://public.jupiterapi.com/swap-instructions")
                    .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
                    .header("Content-Type", "application/json")
                    .json(&payload)
                    .timeout(std::time::Duration::from_secs(10))
                    .send()
                    .await
                    .map_err(|e| anyhow::anyhow!("Jupiter swap-instructions request failed: {}", e))?;

                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                if !status.is_success() || body.contains("\"error\"") {
                    return Err(anyhow::anyhow!("Jupiter swap-instructions failed ({}): {}", status, body));
                }

                let data: serde_json::Value = serde_json::from_str(&body)
                    .map_err(|e| anyhow::anyhow!("swap-instructions JSON parse: {}", e))?;

                let mut ixs = Vec::new();

                let parse_ix = |ix: &serde_json::Value| -> anyhow::Result<Instruction> {
                    let program_id = ix["programId"].as_str().unwrap_or_default()
                        .parse::<Pubkey>().map_err(|e| anyhow::anyhow!("bad programId: {}", e))?;
                    let data_b64 = ix["data"].as_str().unwrap_or_default();
                    let ix_data = base64::Engine::decode(
                        &base64::engine::general_purpose::STANDARD, data_b64
                    ).unwrap_or_default();
                    let accounts: Vec<AccountMeta> = ix["accounts"].as_array()
                        .ok_or_else(|| anyhow::anyhow!("missing accounts"))?
                        .iter()
                        .map(|acc| {
                            let pubkey = acc["pubkey"].as_str().unwrap_or_default()
                                .parse::<Pubkey>().unwrap_or_default();
                            let is_signer = acc["isSigner"].as_bool().unwrap_or(false);
                            let is_writable = acc["isWritable"].as_bool().unwrap_or(false);
                            if is_writable {
                                AccountMeta::new(pubkey, is_signer)
                            } else {
                                AccountMeta::new_readonly(pubkey, is_signer)
                            }
                        })
                        .collect();
                    Ok(Instruction { program_id, accounts, data: ix_data })
                };

                if let Some(setup) = data["setupInstructions"].as_array() {
                    for ix in setup {
                        ixs.push(parse_ix(ix)?);
                    }
                }
                if let Some(swap) = data["swapInstruction"].as_object() {
                    ixs.push(parse_ix(&serde_json::Value::Object(swap.clone()))?);
                } else {
                    return Err(anyhow::anyhow!("Missing swapInstruction in Jupiter response"));
                }

                info!("Built {} DEX leg instructions for CEX-DEX {}", ixs.len(), token);
                Ok(ixs)
            })
        })?;

        Ok(instructions)
    }

    fn min_profit_threshold(&self) -> Decimal { self.threshold }
    fn normalized_profit_pct(&self, opp: &Opportunity) -> Decimal { opp.expected_profit_pct }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tokens::TokenRegistry;

    fn test_registry() -> Arc<TokenRegistry> {
        Arc::new(TokenRegistry::new_with_defaults())
    }

    #[tokio::test]
    async fn test_no_opportunity_when_position_open() {
        let strategy = CexDexStrategy::new(1.0, test_registry());
        *strategy.open_position.lock().await = Some(CexDexPosition {
            id: "test".into(),
            status: crate::executor::cex_executor::CexDexStatus::DexConfirmed,
            exchange: "mexc".into(),
            dex_tx_hash: None,
            cex_order_id: None,
            pair: "SOL".into(),
            size: Decimal::new(45, 0),
            opened_at: Instant::now(),
            max_exposure_secs: 300,
        });
        let cache = PriceCache::new();
        let opps = strategy.evaluate(&cache).await;
        assert!(opps.is_empty());
    }
}
