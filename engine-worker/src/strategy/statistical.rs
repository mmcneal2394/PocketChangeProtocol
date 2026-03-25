use async_trait::async_trait;
use base64::Engine as _;
use rust_decimal::Decimal;
use rust_decimal::prelude::*;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};
use uuid::Uuid;
use std::collections::VecDeque;
use std::time::Instant;
use tokio::sync::Mutex;
use tracing::{debug, info, warn};
use crate::types::*;
use crate::price::PriceCache;
use crate::strategy::Strategy;

const WINDOW_SIZE: usize = 100;
const HISTORICAL_PCT_PER_Z: f64 = 0.5; // Expected % return per z-score unit

const JUPITER_API: &str = "https://public.jupiterapi.com";
const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const TOKEN_MINTS: &[(&str, &str)] = &[
    ("SOL", "So11111111111111111111111111111111111111112"),
    ("JitoSOL", "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"),
    ("mSOL", "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"),
];

/// Tracked pair for statistical arbitrage
struct PairState {
    token_a: String,
    token_b: String,
    ratios: VecDeque<f64>,
}

impl PairState {
    fn new(a: &str, b: &str) -> Self {
        Self {
            token_a: a.into(),
            token_b: b.into(),
            ratios: VecDeque::with_capacity(WINDOW_SIZE + 1),
        }
    }

    fn push_ratio(&mut self, ratio: f64) {
        self.ratios.push_back(ratio);
        if self.ratios.len() > WINDOW_SIZE {
            self.ratios.pop_front();
        }
    }

    fn z_score(&self) -> Option<f64> {
        if self.ratios.len() < 20 {
            return None; // Need minimum data
        }
        let n = self.ratios.len() as f64;
        let mean: f64 = self.ratios.iter().sum::<f64>() / n;
        let variance: f64 = self.ratios.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / n;
        let std_dev = variance.sqrt();
        if std_dev < 1e-10 {
            return None;
        }
        let current = *self.ratios.back()?;
        Some((current - mean) / std_dev)
    }
}

pub struct StatisticalStrategy {
    threshold: Decimal,
    pairs: Mutex<Vec<PairState>>,
    client: reqwest::Client,
}

impl StatisticalStrategy {
    pub fn new(threshold: f64) -> Self {
        Self {
            threshold: Decimal::from_f64(threshold).unwrap_or(Decimal::new(2, 0)),
            pairs: Mutex::new(vec![
                PairState::new("SOL", "JitoSOL"),
                PairState::new("SOL", "mSOL"),
            ]),
            client: reqwest::Client::new(),
        }
    }

    /// Resolve a token symbol to its Solana mint address.
    fn resolve_mint(symbol: &str) -> Option<&'static str> {
        TOKEN_MINTS.iter().find(|(s, _)| *s == symbol).map(|(_, m)| *m)
    }

    /// Estimate base units from a USDC amount and token symbol.
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

    /// Parse the statistical arb route to extract the long and short token symbols.
    ///
    /// Route format: "SOL/JitoSOL long JitoSOL / short SOL (z=-2.45)"
    /// Returns (long_token, short_token).
    fn parse_pair_direction(route: &str) -> anyhow::Result<(String, String)> {
        // Find "long <TOKEN>" and "short <TOKEN>" in the route string
        let long_token = route
            .find("long ")
            .and_then(|idx| {
                let after = &route[idx + 5..];
                // Take up to the next whitespace or '/'
                let end = after.find(|c: char| c == '/' || c == ' ' || c == '(')
                    .unwrap_or(after.len());
                let token = after[..end].trim();
                if token.is_empty() { None } else { Some(token.to_string()) }
            })
            .ok_or_else(|| anyhow::anyhow!("Cannot parse long token from route: {}", route))?;

        let short_token = route
            .find("short ")
            .and_then(|idx| {
                let after = &route[idx + 6..];
                let end = after.find(|c: char| c == '/' || c == ' ' || c == '(')
                    .unwrap_or(after.len());
                let token = after[..end].trim();
                if token.is_empty() { None } else { Some(token.to_string()) }
            })
            .ok_or_else(|| anyhow::anyhow!("Cannot parse short token from route: {}", route))?;

        Ok((long_token, short_token))
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

        let resp = self.client.get(&url)
            .header("User-Agent", "ArbitraSaaS-Engine/0.1")
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await?;

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

        let resp = self.client.post(&format!("{}/swap-instructions", JUPITER_API))
            .header("User-Agent", "ArbitraSaaS-Engine/0.1")
            .header("Content-Type", "application/json")
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

    /// Build Jupiter swap instructions for both legs of the pair trade.
    ///
    /// Long leg: buy underperformer (USDC -> token) via Jupiter
    /// Short leg: sell outperformer (token -> USDC) via Jupiter
    async fn build_pair_trade_ixs(
        &self,
        opp: &Opportunity,
        wallet: &Keypair,
    ) -> anyhow::Result<Vec<Instruction>> {
        let (long_token, short_token) = Self::parse_pair_direction(&opp.route)?;
        let user_pubkey = wallet.pubkey().to_string();

        let long_mint = Self::resolve_mint(&long_token)
            .ok_or_else(|| anyhow::anyhow!("Unknown token mint for long leg: {}", long_token))?;
        let short_mint = Self::resolve_mint(&short_token)
            .ok_or_else(|| anyhow::anyhow!("Unknown token mint for short leg: {}", short_token))?;

        // Split trade size evenly between the two legs
        let half_usdc = opp.trade_size_usdc.to_f64().unwrap_or(1000.0) / 2.0;

        // --- Long leg: buy underperformer (USDC -> long_token) ---
        let long_amount_usdc = (half_usdc * 1_000_000.0) as u64; // USDC has 6 decimals
        info!(
            "Stat arb long leg: USDC ({}) -> {} ({}), amount={}",
            USDC_MINT, long_token, long_mint, long_amount_usdc
        );

        let long_quote = self.fetch_jupiter_quote(USDC_MINT, long_mint, long_amount_usdc).await
            .map_err(|e| anyhow::anyhow!("Long leg quote failed: {}", e))?;

        info!(
            "Long leg quote: outAmount={}",
            long_quote["outAmount"].as_str().unwrap_or("?")
        );

        let long_ixs = self.fetch_swap_instructions(&long_quote, &user_pubkey).await
            .map_err(|e| anyhow::anyhow!("Long leg swap instructions failed: {}", e))?;

        // --- Short leg: sell outperformer (short_token -> USDC) ---
        let short_amount = Self::usdc_to_base_units(&short_token, half_usdc);
        info!(
            "Stat arb short leg: {} ({}) -> USDC ({}), amount={}",
            short_token, short_mint, USDC_MINT, short_amount
        );

        let short_quote = self.fetch_jupiter_quote(short_mint, USDC_MINT, short_amount).await
            .map_err(|e| anyhow::anyhow!("Short leg quote failed: {}", e))?;

        info!(
            "Short leg quote: outAmount={}",
            short_quote["outAmount"].as_str().unwrap_or("?")
        );

        let short_ixs = self.fetch_swap_instructions(&short_quote, &user_pubkey).await
            .map_err(|e| anyhow::anyhow!("Short leg swap instructions failed: {}", e))?;

        // Combine: buy first, then sell
        let mut all_ixs = Vec::with_capacity(long_ixs.len() + short_ixs.len());
        all_ixs.extend(long_ixs);
        all_ixs.extend(short_ixs);

        info!(
            "Built {} total instructions for stat arb pair trade ({} long {} / short {})",
            all_ixs.len(), opp.route, long_token, short_token
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
        let mut pairs = self.pairs.lock().await;

        for pair in pairs.iter_mut() {
            let price_a = match prices.get_price(&pair.token_a) {
                Some(p) if p > 0.0 => p,
                _ => continue,
            };
            let price_b = match prices.get_price(&pair.token_b) {
                Some(p) if p > 0.0 => p,
                _ => continue,
            };

            let ratio = price_a / price_b;
            pair.push_ratio(ratio);

            if let Some(z) = pair.z_score() {
                let z_abs = z.abs();
                let threshold = self.threshold.to_f64().unwrap_or(2.0);

                if z_abs > threshold {
                    let direction = if z > 0.0 {
                        format!("long {} / short {}", pair.token_b, pair.token_a)
                    } else {
                        format!("long {} / short {}", pair.token_a, pair.token_b)
                    };

                    debug!("Stat arb: {}/{} z={:.2} -> {}", pair.token_a, pair.token_b, z, direction);

                    opportunities.push(Opportunity {
                        id: Uuid::new_v4().to_string(),
                        strategy: StrategyKind::Statistical,
                        route: format!("{}/{} {} (z={:.2})", pair.token_a, pair.token_b, direction, z),
                        expected_profit_pct: Decimal::from_f64(z_abs * HISTORICAL_PCT_PER_Z)
                            .unwrap_or_default(),
                        trade_size_usdc: Decimal::new(100, 0),
                        instructions: vec![],
                        detected_at: Instant::now(),
                    });
                }
            }
        }

        opportunities
    }

    fn build_instructions(&self, opp: &Opportunity, wallet: &Keypair) -> anyhow::Result<Vec<Instruction>> {
        info!("Building stat arb instructions for {}", opp.route);
        use tokio::runtime::Handle;
        let instructions = tokio::task::block_in_place(|| {
            Handle::current().block_on(self.build_pair_trade_ixs(opp, wallet))
        })?;
        Ok(instructions)
    }

    fn min_profit_threshold(&self) -> Decimal { self.threshold }

    fn normalized_profit_pct(&self, opp: &Opportunity) -> Decimal {
        opp.expected_profit_pct // Already converted from z-score * pct_per_z
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_z_score_calculation() {
        let mut pair = PairState::new("SOL", "JitoSOL");
        // Push 20 values with slight variance so std_dev > 0
        for i in 0..20 {
            pair.push_ratio(1.0 + (i as f64) * 0.0001);
        }
        // Push one more value near the mean
        pair.push_ratio(1.001);
        let z = pair.z_score().unwrap();
        assert!(z.abs() < 1.0, "Near-mean value should have small z: got {}", z);

        // Push an outlier well above the mean
        pair.push_ratio(1.1);
        let z = pair.z_score().unwrap();
        assert!(z > 1.0, "Outlier should produce positive z-score: got {}", z);
    }

    #[test]
    fn test_insufficient_data_returns_none() {
        let mut pair = PairState::new("SOL", "JitoSOL");
        for _ in 0..10 {
            pair.push_ratio(1.0);
        }
        assert!(pair.z_score().is_none()); // Need at least 20
    }

    #[test]
    fn test_parse_pair_direction() {
        // Standard route format from evaluate()
        let route = "SOL/JitoSOL long JitoSOL / short SOL (z=-2.45)";
        let (long_tok, short_tok) = StatisticalStrategy::parse_pair_direction(route).unwrap();
        assert_eq!(long_tok, "JitoSOL");
        assert_eq!(short_tok, "SOL");

        // Reverse direction
        let route2 = "SOL/mSOL long SOL / short mSOL (z=2.80)";
        let (long_tok2, short_tok2) = StatisticalStrategy::parse_pair_direction(route2).unwrap();
        assert_eq!(long_tok2, "SOL");
        assert_eq!(short_tok2, "mSOL");
    }

    #[test]
    fn test_parse_pair_direction_missing_long() {
        let route = "SOL/JitoSOL short SOL (z=-2.45)";
        assert!(StatisticalStrategy::parse_pair_direction(route).is_err());
    }

    #[test]
    fn test_parse_pair_direction_missing_short() {
        let route = "SOL/JitoSOL long JitoSOL (z=-2.45)";
        assert!(StatisticalStrategy::parse_pair_direction(route).is_err());
    }

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
}
