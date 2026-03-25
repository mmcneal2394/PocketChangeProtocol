use async_trait::async_trait;
use base64::Engine as _;
use rust_decimal::Decimal;
use rust_decimal::prelude::*;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};
use uuid::Uuid;
use std::time::Instant;
use tracing::{debug, info};
use crate::types::*;
use crate::price::PriceCache;
use crate::strategy::{Strategy, estimate_execution_cost_usdc};

const JUPITER_API: &str = "https://public.jupiterapi.com";

const TOKEN_MINTS: &[(&str, &str)] = &[
    ("SOL", "So11111111111111111111111111111111111111112"),
    ("JitoSOL", "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"),
    ("mSOL", "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"),
];

/// Round-trip pairs for atomic LSD arbitrage.
/// Each entry is (base_token, derivative_token).
/// We swap base -> derivative -> base and check if we end up with more than we started.
const ROUND_TRIP_PAIRS: &[(&str, &str)] = &[
    ("SOL", "JitoSOL"),
    ("SOL", "mSOL"),
];

pub struct StatisticalStrategy {
    /// Minimum net profit percentage to emit an opportunity.
    threshold: Decimal,
    client: reqwest::Client,
}

impl StatisticalStrategy {
    pub fn new(threshold: f64) -> Self {
        Self {
            threshold: Decimal::from_f64(threshold).unwrap_or(Decimal::new(5, 2)), // default 0.05%
            client: reqwest::Client::new(),
        }
    }

    /// Resolve a token symbol to its Solana mint address.
    fn resolve_mint(symbol: &str) -> Option<&'static str> {
        TOKEN_MINTS.iter().find(|(s, _)| *s == symbol).map(|(_, m)| *m)
    }

    /// Convert a USDC notional amount to base units (lamports) for a given token.
    fn usdc_to_base_units(symbol: &str, usdc_amount: f64) -> u64 {
        let (price_est, decimals): (f64, u32) = match symbol {
            "SOL" => (150.0, 9),
            "JitoSOL" => (165.0, 9),
            "mSOL" => (160.0, 9),
            _ => (1.0, 6),
        };
        let token_amount = usdc_amount / price_est;
        (token_amount * 10_f64.powi(decimals as i32)) as u64
    }

    /// Fetch a Jupiter V6 quote for a single swap leg.
    async fn fetch_jupiter_quote(
        &self,
        input_mint: &str,
        output_mint: &str,
        amount: u64,
    ) -> anyhow::Result<serde_json::Value> {
        let url = format!(
            "{}/quote?inputMint={}&outputMint={}&amount={}&slippageBps=50",
            JUPITER_API, input_mint, output_mint, amount
        );

        let mut req = self.client.get(&url)
            .header("User-Agent", "ArbitraSaaS-Engine/0.1")
            .timeout(std::time::Duration::from_secs(10));
        if let Ok(key) = std::env::var("JUPITER_API_KEY") {
            req = req.header("x-api-key", key);
        }
        let resp = req.send().await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Jupiter quote failed ({}): {}", status, body);
        }

        let json: serde_json::Value = resp.json().await?;
        if json.get("error").is_some() {
            anyhow::bail!("Jupiter quote error: {}", json);
        }

        Ok(json)
    }

    /// Fetch swap instructions from Jupiter V6 for a given quote response.
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

        let mut req = self.client.post(&format!("{}/swap-instructions", JUPITER_API))
            .header("User-Agent", "ArbitraSaaS-Engine/0.1")
            .header("Content-Type", "application/json");
        if let Ok(key) = std::env::var("JUPITER_API_KEY") {
            req = req.header("x-api-key", key);
        }
        let resp = req
            .json(&payload)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            anyhow::bail!("Jupiter swap-instructions failed ({}): {}", status, body);
        }

        let data: serde_json::Value = resp.json().await?;

        if let Some(err) = data.get("error") {
            anyhow::bail!("Jupiter swap-instructions error: {}", err);
        }

        let mut instructions = Vec::new();

        // Setup instructions (ATAs, etc.)
        if let Some(setup) = data["setupInstructions"].as_array() {
            for ix in setup {
                instructions.push(Self::parse_jupiter_instruction(ix)?);
            }
        }

        // Main swap instruction
        if let Some(swap) = data.get("swapInstruction") {
            instructions.push(Self::parse_jupiter_instruction(swap)?);
        } else {
            anyhow::bail!("Missing swapInstruction in Jupiter response");
        }

        // Cleanup instruction (optional)
        if let Some(cleanup) = data.get("cleanupInstruction") {
            if !cleanup.is_null() {
                instructions.push(Self::parse_jupiter_instruction(cleanup)?);
            }
        }

        Ok(instructions)
    }

    /// Parse a Jupiter JSON instruction into a Solana SDK Instruction.
    fn parse_jupiter_instruction(ix: &serde_json::Value) -> anyhow::Result<Instruction> {
        let program_id_str = ix["programId"].as_str()
            .ok_or_else(|| anyhow::anyhow!("Missing programId"))?;
        let program_id: Pubkey = program_id_str.parse()
            .map_err(|_| anyhow::anyhow!("Invalid programId: {}", program_id_str))?;

        let data_b64 = ix["data"].as_str().unwrap_or_default();
        let data = base64::engine::general_purpose::STANDARD.decode(data_b64)
            .unwrap_or_default();

        let accounts_json = ix["accounts"].as_array()
            .ok_or_else(|| anyhow::anyhow!("Missing accounts array"))?;

        let mut accounts = Vec::with_capacity(accounts_json.len());
        for acc in accounts_json {
            let pubkey_str = acc["pubkey"].as_str().unwrap_or_default();
            let pubkey: Pubkey = pubkey_str.parse()
                .map_err(|_| anyhow::anyhow!("Invalid account pubkey: {}", pubkey_str))?;
            let is_signer = acc["isSigner"].as_bool().unwrap_or(false);
            let is_writable = acc["isWritable"].as_bool().unwrap_or(false);

            if is_writable {
                accounts.push(AccountMeta::new(pubkey, is_signer));
            } else {
                accounts.push(AccountMeta::new_readonly(pubkey, is_signer));
            }
        }

        Ok(Instruction { program_id, accounts, data })
    }

    /// Parse the round-trip route to extract (token_a, token_b).
    ///
    /// Route format: "SOL -> JitoSOL -> SOL (round-trip arb, net 0.15%)"
    /// Returns ("SOL", "JitoSOL").
    fn parse_round_trip_route(route: &str) -> anyhow::Result<(String, String)> {
        // Extract the part before the parenthetical
        let core = route.split('(').next().unwrap_or(route).trim();
        let tokens: Vec<&str> = core.split("->").map(|s| s.trim()).collect();
        if tokens.len() < 3 {
            anyhow::bail!("Cannot parse round-trip route (expected A -> B -> A): {}", route);
        }
        Ok((tokens[0].to_string(), tokens[1].to_string()))
    }

    /// Build Jupiter swap instructions for both legs of the round-trip arb.
    ///
    /// Leg 1: token_a -> token_b (via Jupiter)
    /// Leg 2: token_b -> token_a (via Jupiter, using output of leg 1)
    async fn build_round_trip_ixs(
        &self,
        opp: &Opportunity,
        wallet: &Keypair,
    ) -> anyhow::Result<Vec<Instruction>> {
        let (token_a, token_b) = Self::parse_round_trip_route(&opp.route)?;
        let user_pubkey = wallet.pubkey().to_string();

        let mint_a = Self::resolve_mint(&token_a)
            .ok_or_else(|| anyhow::anyhow!("Unknown mint for {}", token_a))?;
        let mint_b = Self::resolve_mint(&token_b)
            .ok_or_else(|| anyhow::anyhow!("Unknown mint for {}", token_b))?;

        // Leg 1: token_a -> token_b
        let trade_usdc = opp.trade_size_usdc.to_f64().unwrap_or(100.0);
        let amount_a = Self::usdc_to_base_units(&token_a, trade_usdc);

        info!(
            "Round-trip leg 1: {} ({}) -> {} ({}), amount={}",
            token_a, mint_a, token_b, mint_b, amount_a
        );

        let quote_1 = self.fetch_jupiter_quote(mint_a, mint_b, amount_a).await
            .map_err(|e| anyhow::anyhow!("Leg 1 quote failed: {}", e))?;

        let out_b: u64 = quote_1["outAmount"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        info!("Leg 1 output: {} base units of {}", out_b, token_b);

        let ixs_1 = self.fetch_swap_instructions(&quote_1, &user_pubkey).await
            .map_err(|e| anyhow::anyhow!("Leg 1 swap instructions failed: {}", e))?;

        // Leg 2: token_b -> token_a (using the output from leg 1)
        info!(
            "Round-trip leg 2: {} ({}) -> {} ({}), amount={}",
            token_b, mint_b, token_a, mint_a, out_b
        );

        let quote_2 = self.fetch_jupiter_quote(mint_b, mint_a, out_b).await
            .map_err(|e| anyhow::anyhow!("Leg 2 quote failed: {}", e))?;

        info!(
            "Leg 2 output: {} base units of {}",
            quote_2["outAmount"].as_str().unwrap_or("?"),
            token_a
        );

        let ixs_2 = self.fetch_swap_instructions(&quote_2, &user_pubkey).await
            .map_err(|e| anyhow::anyhow!("Leg 2 swap instructions failed: {}", e))?;

        let mut all_ixs = Vec::with_capacity(ixs_1.len() + ixs_2.len());
        all_ixs.extend(ixs_1);
        all_ixs.extend(ixs_2);

        info!(
            "Built {} total instructions for round-trip arb: {}",
            all_ixs.len(), opp.route
        );

        Ok(all_ixs)
    }
}

#[async_trait]
impl Strategy for StatisticalStrategy {
    fn name(&self) -> &str { "Statistical" }
    fn kind(&self) -> StrategyKind { StrategyKind::Statistical }

    async fn evaluate(&self, prices: &PriceCache) -> Vec<Opportunity> {
        let mut opportunities = Vec::new();
        let sol_price = prices.get_price("SOL").unwrap_or(150.0);
        let trade_size_usdc = 100.0_f64;

        for &(token_a, token_b) in ROUND_TRIP_PAIRS {
            let mint_a = match Self::resolve_mint(token_a) {
                Some(m) => m,
                None => continue,
            };
            let mint_b = match Self::resolve_mint(token_b) {
                Some(m) => m,
                None => continue,
            };

            // Leg 1: token_a -> token_b (1 SOL = 10^9 lamports as the probe amount)
            let amount_a = Self::usdc_to_base_units(token_a, trade_size_usdc);

            let quote_1 = match self.fetch_jupiter_quote(mint_a, mint_b, amount_a).await {
                Ok(q) => q,
                Err(e) => {
                    debug!("Round-trip {}->{}: leg 1 quote failed: {}", token_a, token_b, e);
                    continue;
                }
            };

            let out_b: u64 = match quote_1["outAmount"]
                .as_str()
                .and_then(|s| s.parse().ok())
            {
                Some(v) if v > 0 => v,
                _ => {
                    debug!("Round-trip {}->{}: leg 1 returned 0 output", token_a, token_b);
                    continue;
                }
            };

            // Leg 2: token_b -> token_a (feed leg 1 output)
            let quote_2 = match self.fetch_jupiter_quote(mint_b, mint_a, out_b).await {
                Ok(q) => q,
                Err(e) => {
                    debug!("Round-trip {}->{}->{}: leg 2 quote failed: {}", token_a, token_b, token_a, e);
                    continue;
                }
            };

            let out_a_final: u64 = match quote_2["outAmount"]
                .as_str()
                .and_then(|s| s.parse().ok())
            {
                Some(v) if v > 0 => v,
                _ => {
                    debug!("Round-trip {}->{}->{}: leg 2 returned 0 output", token_a, token_b, token_a);
                    continue;
                }
            };

            // Calculate round-trip gross profit percentage
            let gross_profit_pct = ((out_a_final as f64 - amount_a as f64) / amount_a as f64) * 100.0;

            // Deduct execution fees: 2 transactions (leg 1 + leg 2)
            let fees_usdc = estimate_execution_cost_usdc(sol_price, 2);
            let fees_pct = (fees_usdc / trade_size_usdc) * 100.0;
            let net_profit_pct = gross_profit_pct - fees_pct;

            debug!(
                "Round-trip {} -> {} -> {}: in={} out={} gross={:.4}% fees={:.4}% net={:.4}%",
                token_a, token_b, token_a, amount_a, out_a_final, gross_profit_pct, fees_pct, net_profit_pct
            );

            let threshold = self.threshold.to_f64().unwrap_or(0.05);
            if net_profit_pct <= threshold {
                debug!(
                    "Round-trip {} -> {} -> {}: net {:.4}% below threshold {:.4}%, skipping",
                    token_a, token_b, token_a, net_profit_pct, threshold
                );
                continue;
            }

            let route = format!(
                "{} -> {} -> {} (round-trip arb, net {:.2}%)",
                token_a, token_b, token_a, net_profit_pct
            );

            info!("Atomic arb detected: {}", route);

            opportunities.push(Opportunity {
                id: Uuid::new_v4().to_string(),
                strategy: StrategyKind::Statistical,
                route,
                expected_profit_pct: Decimal::from_f64(net_profit_pct).unwrap_or_default(),
                estimated_fees_pct: Decimal::from_f64(fees_pct).unwrap_or_default(),
                trade_size_usdc: Decimal::new(100, 0),
                instructions: vec![],
                detected_at: Instant::now(),
            });
        }

        opportunities
    }

    fn build_instructions(&self, opp: &Opportunity, wallet: &Keypair) -> anyhow::Result<Vec<Instruction>> {
        info!("Building round-trip arb instructions for {}", opp.route);
        use tokio::runtime::Handle;
        let instructions = tokio::task::block_in_place(|| {
            Handle::current().block_on(self.build_round_trip_ixs(opp, wallet))
        })?;
        Ok(instructions)
    }

    fn min_profit_threshold(&self) -> Decimal { self.threshold }

    fn normalized_profit_pct(&self, opp: &Opportunity) -> Decimal {
        opp.expected_profit_pct
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_mint() {
        assert_eq!(
            StatisticalStrategy::resolve_mint("SOL"),
            Some("So11111111111111111111111111111111111111112")
        );
        assert_eq!(
            StatisticalStrategy::resolve_mint("JitoSOL"),
            Some("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn")
        );
        assert_eq!(
            StatisticalStrategy::resolve_mint("mSOL"),
            Some("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So")
        );
        assert_eq!(StatisticalStrategy::resolve_mint("UNKNOWN"), None);
    }

    #[test]
    fn test_usdc_to_base_units() {
        // 500 USDC worth of SOL at ~150 USD/SOL = ~3.33 SOL = ~3_333_333_333 lamports
        let units = StatisticalStrategy::usdc_to_base_units("SOL", 500.0);
        assert!(units > 3_000_000_000 && units < 4_000_000_000, "SOL base units: {}", units);

        // 500 USDC worth of JitoSOL at ~165 = ~3.03 JitoSOL
        let units = StatisticalStrategy::usdc_to_base_units("JitoSOL", 500.0);
        assert!(units > 2_500_000_000 && units < 4_000_000_000, "JitoSOL base units: {}", units);
    }

    #[test]
    fn test_parse_round_trip_route() {
        let route = "SOL -> JitoSOL -> SOL (round-trip arb, net 0.15%)";
        let (a, b) = StatisticalStrategy::parse_round_trip_route(route).unwrap();
        assert_eq!(a, "SOL");
        assert_eq!(b, "JitoSOL");

        let route2 = "SOL -> mSOL -> SOL (round-trip arb, net 0.42%)";
        let (a2, b2) = StatisticalStrategy::parse_round_trip_route(route2).unwrap();
        assert_eq!(a2, "SOL");
        assert_eq!(b2, "mSOL");
    }

    #[test]
    fn test_parse_round_trip_route_invalid() {
        let route = "SOL -> JitoSOL";
        assert!(StatisticalStrategy::parse_round_trip_route(route).is_err());
    }

    #[test]
    fn test_default_threshold() {
        let strat = StatisticalStrategy::new(0.05);
        assert_eq!(strat.threshold, Decimal::from_f64(0.05).unwrap());
    }
}
