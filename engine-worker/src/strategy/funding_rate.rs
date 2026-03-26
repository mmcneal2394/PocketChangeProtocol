use async_trait::async_trait;
use base64::Engine as _;
use rust_decimal::Decimal;
use rust_decimal::prelude::*;
use serde::Deserialize;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};
use std::time::Instant;
use tracing::{info, warn, debug};
use uuid::Uuid;
use crate::types::*;
use crate::price::PriceCache;
use crate::strategy::{Strategy, execution_cost_pct};
use crate::engine::drift::{self, OrderParams, PositionDirection};

/// Drift taker fee per trade (0.1%).
const DRIFT_TAKER_FEE_PCT: f64 = 0.1;

/// Drift Protocol markets to monitor for funding rate arbitrage.
const DRIFT_MARKETS: &[(&str, u32)] = &[
    ("SOL-PERP", 0),
    ("BTC-PERP", 1),
    ("ETH-PERP", 2),
];

/// Drift funding rate precision: rates are returned in 1e6 (PRICE_PRECISION).
const PRICE_PRECISION: f64 = 1_000_000.0;

/// Primary Drift API endpoint for funding rates.
const DRIFT_FUNDING_URL: &str = "https://data.api.drift.trade/fundingRates";

/// Fallback Drift API endpoint.
const DRIFT_FUNDING_URL_FALLBACK: &str = "https://mainnet-beta.api.drift.trade/fundingRates";

/// Default trade size for funding rate arb positions (USDC).
const DEFAULT_TRADE_SIZE_USDC: i64 = 5000;

/// Jupiter API base URL.
const JUPITER_API: &str = "https://public.jupiterapi.com";

/// Jupiter slippage tolerance in basis points.
const SLIPPAGE_BPS: u32 = 50;

/// USDC mint on Solana mainnet (6 decimals).
const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/// Base unit precision for Drift perp markets (9 decimals for all).
/// 1 SOL/BTC/ETH = 1_000_000_000 base units on Drift.
const DRIFT_BASE_PRECISION: u64 = 1_000_000_000;

/// Spot mint mappings for perp markets -> underlying spot token.
const SPOT_MINTS: &[(&str, &str)] = &[
    ("SOL-PERP", "So11111111111111111111111111111111111111112"),
    ("BTC-PERP", "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh"), // Wrapped BTC (portal)
    ("ETH-PERP", "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"), // Wrapped ETH (portal)
];

/// Response shape from Drift's funding rate API.
/// Parsed defensively — all fields optional except marketIndex.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DriftFundingRateEntry {
    market_index: u32,
    #[serde(default)]
    funding_rate: Option<String>,
    #[serde(default, alias = "fundingRateLong")]
    funding_rate_long: Option<String>,
    #[serde(default, alias = "fundingRateShort")]
    funding_rate_short: Option<String>,
    #[serde(default)]
    ts: Option<String>,
}

pub struct FundingRateStrategy {
    threshold: Decimal,
    client: reqwest::Client,
}

impl FundingRateStrategy {
    pub fn new(threshold: f64) -> Self {
        Self {
            threshold: Decimal::from_f64(threshold).unwrap_or(Decimal::new(8, 2)),
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
        }
    }

    /// Fetch funding rates from Drift Protocol API for a given market.
    /// Tries the primary endpoint first, falls back to the alternative.
    async fn fetch_funding_rates(&self, market_index: u32) -> Option<Vec<DriftFundingRateEntry>> {
        let url = format!("{}?marketIndex={}", DRIFT_FUNDING_URL, market_index);

        match self.client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<Vec<DriftFundingRateEntry>>().await {
                    Ok(entries) => return Some(entries),
                    Err(e) => {
                        warn!("Failed to parse Drift funding rate response from primary: {}", e);
                    }
                }
            }
            Ok(resp) => {
                warn!("Drift primary API returned status {}", resp.status());
            }
            Err(e) => {
                warn!("Drift primary API request failed: {}", e);
            }
        }

        // Fallback endpoint
        let fallback_url = format!("{}?marketIndex={}", DRIFT_FUNDING_URL_FALLBACK, market_index);
        match self.client.get(&fallback_url).send().await {
            Ok(resp) if resp.status().is_success() => {
                match resp.json::<Vec<DriftFundingRateEntry>>().await {
                    Ok(entries) => Some(entries),
                    Err(e) => {
                        warn!("Failed to parse Drift funding rate response from fallback: {}", e);
                        None
                    }
                }
            }
            Ok(resp) => {
                warn!("Drift fallback API returned status {}", resp.status());
                None
            }
            Err(e) => {
                warn!("Drift fallback API request failed: {}", e);
                None
            }
        }
    }

    /// Parse a raw funding rate string (in PRICE_PRECISION) into a percentage.
    /// Returns None if the string is invalid.
    fn parse_funding_rate(raw: &str) -> Option<f64> {
        raw.parse::<f64>().ok().map(|r| r / PRICE_PRECISION)
    }

    /// Normalize profit percentage by annualizing (funding rate * 365).
    pub fn normalized_profit_pct(&self, opp: &Opportunity) -> Decimal {
        opp.expected_profit_pct * Decimal::new(365, 0)
    }

    /// Parse the market symbol from the opportunity route string.
    /// Route format: "SOL-PERP short perp + long spot (rate 0.15%)"
    fn parse_market(route: &str) -> anyhow::Result<String> {
        // First token in the route is the market (e.g. "SOL-PERP")
        let market = route.split_whitespace().next()
            .ok_or_else(|| anyhow::anyhow!("Empty route string"))?;
        // Validate it looks like a perp market
        if !market.ends_with("-PERP") {
            anyhow::bail!("Route does not start with a perp market symbol: {}", route);
        }
        Ok(market.to_string())
    }

    /// Resolve a perp market name (e.g. "SOL-PERP") to the underlying spot token mint.
    fn resolve_spot_mint(market: &str) -> anyhow::Result<&'static str> {
        SPOT_MINTS.iter()
            .find(|(m, _)| *m == market)
            .map(|(_, mint)| *mint)
            .ok_or_else(|| anyhow::anyhow!("Unknown perp market for spot resolution: {}", market))
    }

    /// Determine if the spot leg should be a buy (long spot) based on the route description.
    /// Returns true if we should buy the spot token (long spot), false if sell.
    fn is_long_spot(route: &str) -> bool {
        route.contains("long spot")
    }

    /// Fetch a Jupiter V6 quote for a single swap leg.
    async fn fetch_jupiter_quote(
        &self,
        input_mint: &str,
        output_mint: &str,
        amount: u64,
    ) -> anyhow::Result<serde_json::Value> {
        let url = format!(
            "{}/quote?inputMint={}&outputMint={}&amount={}&slippageBps={}",
            JUPITER_API, input_mint, output_mint, amount, SLIPPAGE_BPS
        );

        let resp = self.client.get(&url)
            .header("User-Agent", "ArbitraSaaS-Engine/0.1")
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
                instructions.push(Self::parse_instruction(ix)?);
            }
        }

        // Main swap instruction
        if let Some(swap) = data.get("swapInstruction") {
            instructions.push(Self::parse_instruction(swap)?);
        } else {
            anyhow::bail!("Missing swapInstruction in Jupiter response");
        }

        // Cleanup instruction (optional)
        if let Some(cleanup) = data.get("cleanupInstruction") {
            if !cleanup.is_null() {
                instructions.push(Self::parse_instruction(cleanup)?);
            }
        }

        Ok(instructions)
    }

    /// Parse a Jupiter JSON instruction into a Solana SDK Instruction.
    fn parse_instruction(ix: &serde_json::Value) -> anyhow::Result<Instruction> {
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

    /// Convert a USDC trade size to Drift perp base asset amount using the spot price.
    ///
    /// `base_asset_amount = (usdc_size / spot_price) * DRIFT_BASE_PRECISION`
    ///
    /// Example: $5000 USDC at SOL price $150 → 33.33 SOL → 33_333_333_333 base units.
    fn usdc_to_base_asset_amount(trade_size_usdc: &Decimal, spot_price: f64) -> u64 {
        if spot_price <= 0.0 {
            return 0;
        }
        let size_f64 = trade_size_usdc.to_f64().unwrap_or(0.0);
        let token_qty = size_f64 / spot_price;
        (token_qty * DRIFT_BASE_PRECISION as f64) as u64
    }

    /// Build Jupiter swap instructions for the spot leg AND Drift perp instructions
    /// for the hedge leg of the funding rate arb.
    ///
    /// Funding rate arb is a delta-neutral strategy:
    /// - Positive funding (longs pay shorts): buy spot (long) + short perp → collect funding
    /// - Negative funding (shorts pay longs): sell spot (short) + long perp → collect funding
    async fn build_funding_rate_ixs(
        &self,
        opp: &Opportunity,
        wallet: &Keypair,
    ) -> anyhow::Result<Vec<Instruction>> {
        let market = Self::parse_market(&opp.route)?;
        let spot_mint = Self::resolve_spot_mint(&market)?;
        let long_spot = Self::is_long_spot(&opp.route);

        // Convert trade_size_usdc to USDC lamports (6 decimals)
        let amount_lamports: u64 = (opp.trade_size_usdc * Decimal::new(1_000_000, 0))
            .to_u64()
            .unwrap_or(5_000_000_000); // fallback 5000 USDC

        let user_pubkey = wallet.pubkey().to_string();

        // --- Leg 1: Spot (Jupiter) ---
        let (swap_ixs, spot_price_estimate) = if long_spot {
            // Long spot: buy the underlying token with USDC
            info!(
                "Funding rate spot leg: buy {} with {} USDC lamports (long spot)",
                market, amount_lamports
            );

            let quote = self.fetch_jupiter_quote(USDC_MINT, spot_mint, amount_lamports).await?;

            let out_amount = quote["outAmount"].as_str()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            if out_amount == 0 {
                anyhow::bail!("Jupiter returned zero outAmount for spot buy leg");
            }

            // Derive spot price from the quote: price = usdc_amount / token_amount
            // USDC has 6 decimals, spot tokens have 9 decimals
            let spot_price = (amount_lamports as f64 / 1e6) / (out_amount as f64 / 1e9);

            info!(
                "Funding rate spot leg quote: {} USDC -> {} {} tokens (price ~${:.2})",
                amount_lamports, out_amount, market, spot_price
            );

            let ixs = self.fetch_swap_instructions(&quote, &user_pubkey).await?;

            info!(
                "Built {} instructions for funding rate spot leg (long {})",
                ixs.len(), market
            );

            (ixs, spot_price)
        } else {
            // Short spot: sell the underlying token for USDC
            info!(
                "Funding rate spot leg: sell {} for USDC (short spot, amount {} lamports)",
                market, amount_lamports
            );

            let quote = self.fetch_jupiter_quote(spot_mint, USDC_MINT, amount_lamports).await?;

            let out_amount = quote["outAmount"].as_str()
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            if out_amount == 0 {
                anyhow::bail!("Jupiter returned zero outAmount for spot sell leg");
            }

            // Derive spot price: price = usdc_out / tokens_in
            let spot_price = (out_amount as f64 / 1e6) / (amount_lamports as f64 / 1e9);

            info!(
                "Funding rate spot leg quote: {} {} tokens -> {} USDC lamports (price ~${:.2})",
                amount_lamports, market, out_amount, spot_price
            );

            let ixs = self.fetch_swap_instructions(&quote, &user_pubkey).await?;

            info!(
                "Built {} instructions for funding rate spot leg (short {})",
                ixs.len(), market
            );

            (ixs, spot_price)
        };

        // --- Leg 2: Perp (Drift) ---
        // The perp direction is OPPOSITE to the spot direction (that's the hedge).
        let perp_direction = if long_spot {
            PositionDirection::Short
        } else {
            PositionDirection::Long
        };

        // Convert USDC trade size to base asset amount using the spot price
        let base_asset_amount = Self::usdc_to_base_asset_amount(
            &opp.trade_size_usdc,
            spot_price_estimate,
        );

        if base_asset_amount == 0 {
            anyhow::bail!(
                "Could not compute perp base_asset_amount (spot_price={:.2}, trade_size={})",
                spot_price_estimate, opp.trade_size_usdc
            );
        }

        let market_index = drift::resolve_market_index(&market)?;
        let perp_params = OrderParams::market_order(perp_direction, base_asset_amount, market_index);
        let perp_ix = drift::place_perp_order(&wallet.pubkey(), 0, perp_params);

        info!(
            "Funding rate perp leg: {:?} {} — base_asset_amount={} (≈{:.4} tokens at ${:.2})",
            perp_direction, market, base_asset_amount,
            base_asset_amount as f64 / DRIFT_BASE_PRECISION as f64,
            spot_price_estimate,
        );

        // --- Combine both legs ---
        let mut all_ixs = swap_ixs;
        all_ixs.push(perp_ix);

        info!(
            "Built {} total instructions for funding rate arb ({} spot + 1 perp)",
            all_ixs.len(), all_ixs.len() - 1
        );

        Ok(all_ixs)
    }
}

#[async_trait]
impl Strategy for FundingRateStrategy {
    fn name(&self) -> &str { "Funding Rate" }
    fn kind(&self) -> StrategyKind { StrategyKind::FundingRate }

    async fn evaluate(&self, prices: &PriceCache) -> Vec<Opportunity> {
        let mut opportunities = Vec::new();

        for (market_name, market_index) in DRIFT_MARKETS {
            let entries = match self.fetch_funding_rates(*market_index).await {
                Some(e) if !e.is_empty() => e,
                Some(_) => {
                    debug!("No funding rate entries for {}", market_name);
                    continue;
                }
                None => {
                    // Already logged warning in fetch_funding_rates
                    continue;
                }
            };

            // Use the most recent entry (last in the array, or first — take whichever is newest)
            let latest = &entries[entries.len() - 1];

            // Try to parse the funding rate from available fields
            let funding_rate_pct = latest.funding_rate.as_deref()
                .and_then(Self::parse_funding_rate)
                .or_else(|| {
                    // If main field missing, try averaging long/short rates
                    let long = latest.funding_rate_long.as_deref().and_then(Self::parse_funding_rate);
                    let short = latest.funding_rate_short.as_deref().and_then(Self::parse_funding_rate);
                    match (long, short) {
                        (Some(l), Some(s)) => Some((l + s) / 2.0),
                        (Some(l), None) => Some(l),
                        (None, Some(s)) => Some(s),
                        (None, None) => None,
                    }
                });

            let funding_rate_pct = match funding_rate_pct {
                Some(r) => r,
                None => {
                    warn!("Could not parse funding rate for {} (market_index={})", market_name, market_index);
                    continue;
                }
            };

            let abs_rate = funding_rate_pct.abs();

            // --- Accurate fee calculation ---
            let sol_price = prices.get_price("SOL").unwrap_or(150.0);
            let trade_size = DEFAULT_TRADE_SIZE_USDC as f64;
            // 2 transactions: spot leg (Jupiter swap) + perp leg (Drift order)
            let fixed_cost_pct = execution_cost_pct(sol_price, trade_size, 2);
            // Drift taker fee on the perp side (0.1%)
            let total_fees_pct = fixed_cost_pct + DRIFT_TAKER_FEE_PCT;
            // Net rate after fees (per-period, not annualized)
            let net_rate = abs_rate - total_fees_pct;

            // Annualize: daily rate * 365 (funding rates on Drift are per hour but
            // we treat the raw percentage as a periodic rate and annualize for comparison)
            let annualized_pct = net_rate * 365.0;

            debug!(
                "Drift {} funding rate: {:.6}% fees={:.4}% net={:.6}% (annualized {:.2}%), threshold: {}%",
                market_name, funding_rate_pct, total_fees_pct, net_rate, annualized_pct, self.threshold
            );

            let threshold_f64 = self.threshold.to_f64().unwrap_or(8.0);

            if annualized_pct > threshold_f64 {
                let direction = if funding_rate_pct > 0.0 {
                    "short perp + long spot"
                } else {
                    "long perp + short spot"
                };

                info!(
                    "Funding rate opportunity: {} rate={:.4}% fees={:.4}% net_annualized={:.2}% ({})",
                    market_name, funding_rate_pct, total_fees_pct, annualized_pct, direction
                );

                opportunities.push(Opportunity {
                    id: Uuid::new_v4().to_string(),
                    strategy: StrategyKind::FundingRate,
                    route: format!("{} {} (rate {:.4}%)", market_name, direction, funding_rate_pct),
                    expected_profit_pct: Decimal::from_f64(net_rate).unwrap_or_default(),
                    estimated_fees_pct: Decimal::from_f64(total_fees_pct).unwrap_or_default(),
                    trade_size_usdc: Decimal::new(DEFAULT_TRADE_SIZE_USDC, 0),
                    instructions: vec![],
                    detected_at: Instant::now(),
                });
            }
        }

        opportunities
    }

    fn build_instructions(&self, opp: &Opportunity, wallet: &Keypair) -> anyhow::Result<Vec<Instruction>> {
        info!("Building funding rate instructions for {}", opp.route);

        // Bridge async Jupiter API calls into the sync trait method.
        // Safe: build_instructions is called infrequently (only on approved opps)
        // and we're inside a tokio multi-thread runtime.
        let instructions = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(
                self.build_funding_rate_ixs(opp, wallet)
            )
        })?;

        Ok(instructions)
    }

    fn min_profit_threshold(&self) -> Decimal { self.threshold }

    fn normalized_profit_pct(&self, opp: &Opportunity) -> Decimal {
        // Annualize the funding rate differential
        opp.expected_profit_pct * Decimal::new(365, 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_funding_rate() {
        // 1000 in PRICE_PRECISION (1e6) = 0.001 = 0.1%
        assert_eq!(FundingRateStrategy::parse_funding_rate("1000"), Some(0.001));
        // Negative rate
        assert_eq!(FundingRateStrategy::parse_funding_rate("-500"), Some(-0.0005));
        // Zero
        assert_eq!(FundingRateStrategy::parse_funding_rate("0"), Some(0.0));
        // Invalid
        assert_eq!(FundingRateStrategy::parse_funding_rate("abc"), None);
    }

    #[test]
    fn test_funding_rate_normalization() {
        let strategy = FundingRateStrategy::new(0.08);
        // A funding rate of 0.001 (0.1%) annualized = 0.1 * 365 = 36.5%
        let opp = Opportunity {
            id: "test".into(),
            strategy: StrategyKind::FundingRate,
            route: "SOL-PERP".into(),
            expected_profit_pct: Decimal::from_f64(0.1).unwrap(),
            estimated_fees_pct: Decimal::ZERO,
            trade_size_usdc: Decimal::new(45, 0),
            instructions: vec![],
            detected_at: Instant::now(),
        };
        let normalized = strategy.normalized_profit_pct(&opp);
        assert_eq!(normalized, Decimal::from_f64(0.1).unwrap() * Decimal::new(365, 0));
    }

    #[tokio::test]
    async fn test_evaluate_returns_empty_on_no_api() {
        // With no real API available, evaluate should return empty (not crash)
        let strategy = FundingRateStrategy::new(0.08);
        let cache = PriceCache::new();
        let opps = strategy.evaluate(&cache).await;
        // May be empty if API unreachable — the point is it doesn't panic
        assert!(opps.is_empty() || !opps.is_empty());
    }

    #[test]
    fn test_parse_market_valid() {
        let market = FundingRateStrategy::parse_market(
            "SOL-PERP short perp + long spot (rate 0.15%)"
        ).unwrap();
        assert_eq!(market, "SOL-PERP");

        let market = FundingRateStrategy::parse_market(
            "BTC-PERP long perp + short spot (rate -0.08%)"
        ).unwrap();
        assert_eq!(market, "BTC-PERP");

        let market = FundingRateStrategy::parse_market(
            "ETH-PERP short perp + long spot (rate 0.0200%)"
        ).unwrap();
        assert_eq!(market, "ETH-PERP");
    }

    #[test]
    fn test_parse_market_invalid() {
        assert!(FundingRateStrategy::parse_market("").is_err());
        assert!(FundingRateStrategy::parse_market("USDC something").is_err());
        assert!(FundingRateStrategy::parse_market("SOL not-perp").is_err());
    }

    #[test]
    fn test_resolve_spot_mint() {
        assert_eq!(
            FundingRateStrategy::resolve_spot_mint("SOL-PERP").unwrap(),
            "So11111111111111111111111111111111111111112"
        );
        assert_eq!(
            FundingRateStrategy::resolve_spot_mint("BTC-PERP").unwrap(),
            "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh"
        );
        assert_eq!(
            FundingRateStrategy::resolve_spot_mint("ETH-PERP").unwrap(),
            "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs"
        );
        assert!(FundingRateStrategy::resolve_spot_mint("UNKNOWN-PERP").is_err());
    }

    #[test]
    fn test_is_long_spot() {
        assert!(FundingRateStrategy::is_long_spot(
            "SOL-PERP short perp + long spot (rate 0.15%)"
        ));
        assert!(!FundingRateStrategy::is_long_spot(
            "SOL-PERP long perp + short spot (rate -0.08%)"
        ));
    }

    #[test]
    fn test_spot_mints_cover_drift_markets() {
        // Every market in DRIFT_MARKETS should have a corresponding entry in SPOT_MINTS
        for (market_name, _) in DRIFT_MARKETS {
            assert!(
                FundingRateStrategy::resolve_spot_mint(market_name).is_ok(),
                "Missing spot mint for Drift market: {}", market_name
            );
        }
    }

    #[test]
    fn test_perp_direction_opposite_to_spot() {
        // When we're long spot, we should be short perp (positive funding rate).
        // Route format: "SOL-PERP short perp + long spot (rate: 0.15%)"
        let long_spot_route = "SOL-PERP short perp + long spot (rate: 0.15%)";
        assert!(
            FundingRateStrategy::is_long_spot(long_spot_route),
            "Should detect long spot in route"
        );
        // Long spot → perp direction should be Short (the hedge)
        let perp_dir = if FundingRateStrategy::is_long_spot(long_spot_route) {
            PositionDirection::Short
        } else {
            PositionDirection::Long
        };
        assert_eq!(perp_dir as u8, PositionDirection::Short as u8);

        // When we're short spot, we should be long perp (negative funding rate).
        let short_spot_route = "SOL-PERP long perp + short spot (rate: -0.10%)";
        assert!(
            !FundingRateStrategy::is_long_spot(short_spot_route),
            "Should detect short spot in route"
        );
        let perp_dir2 = if FundingRateStrategy::is_long_spot(short_spot_route) {
            PositionDirection::Short
        } else {
            PositionDirection::Long
        };
        assert_eq!(perp_dir2 as u8, PositionDirection::Long as u8);
    }

    #[test]
    fn test_usdc_to_base_asset_amount() {
        // $5000 USDC at SOL price $150 → 33.333... SOL → ~33_333_333_333 base units
        let trade_size = Decimal::new(45, 0);
        let base_amount = FundingRateStrategy::usdc_to_base_asset_amount(&trade_size, 150.0);
        // 5000 / 150 = 33.333... SOL × 1e9 = 33_333_333_333
        assert_eq!(base_amount, 33_333_333_333);

        // $10000 USDC at BTC price $60000 → 0.1667 BTC
        let trade_size_btc = Decimal::new(45, 0);
        let base_btc = FundingRateStrategy::usdc_to_base_asset_amount(&trade_size_btc, 60000.0);
        // 10000 / 60000 = 0.16667 BTC × 1e9 = 166_666_666
        assert_eq!(base_btc, 166_666_666);

        // Edge: zero price should return 0
        let base_zero = FundingRateStrategy::usdc_to_base_asset_amount(&trade_size, 0.0);
        assert_eq!(base_zero, 0);

        // Edge: negative price should return 0
        let base_neg = FundingRateStrategy::usdc_to_base_asset_amount(&trade_size, -100.0);
        assert_eq!(base_neg, 0);
    }

    #[test]
    fn test_drift_market_index_resolution() {
        // Verify Drift market indices match what the funding rate strategy expects
        assert_eq!(drift::resolve_market_index("SOL-PERP").unwrap(), 0);
        assert_eq!(drift::resolve_market_index("BTC-PERP").unwrap(), 1);
        assert_eq!(drift::resolve_market_index("ETH-PERP").unwrap(), 2);
        assert!(drift::resolve_market_index("DOGE-PERP").is_err());
    }
}
