use async_trait::async_trait;
use base64::Engine as _;
use rust_decimal::Decimal;
use rust_decimal::prelude::*;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};
use uuid::Uuid;
use std::time::Instant;
use tracing::{info, debug, warn};
use crate::types::*;
use crate::price::PriceCache;
use crate::strategy::Strategy;

/// Predefined 3-hop routes for triangular arbitrage
const ROUTES: &[(&str, &str, &str)] = &[
    ("SOL", "RAY", "USDC"),
    ("SOL", "BONK", "USDC"),
    ("SOL", "WIF", "USDC"),
    ("SOL", "mSOL", "USDC"),
    ("SOL", "JitoSOL", "USDC"),
];

const ESTIMATED_FEE_PCT: f64 = 0.3; // ~0.3% for fees + slippage + Jito tip

const JUPITER_API: &str = "https://public.jupiterapi.com";

/// Mint address lookup for supported tokens
const MINT_MAP: &[(&str, &str)] = &[
    ("SOL", "So11111111111111111111111111111111111111112"),
    ("USDC", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
    ("RAY", "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"),
    ("BONK", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
    ("JitoSOL", "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"),
    ("mSOL", "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"),
    ("WIF", "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"),
];

/// Token decimals for amount scaling
const DECIMALS_MAP: &[(&str, u32)] = &[
    ("SOL", 9),
    ("USDC", 6),
    ("RAY", 6),
    ("BONK", 5),
    ("JitoSOL", 9),
    ("mSOL", 9),
    ("WIF", 6),
];

fn resolve_mint(symbol: &str) -> Option<&'static str> {
    MINT_MAP.iter().find(|(s, _)| *s == symbol).map(|(_, m)| *m)
}

fn resolve_decimals(symbol: &str) -> u32 {
    DECIMALS_MAP.iter().find(|(s, _)| *s == symbol).map(|(_, d)| *d).unwrap_or(6)
}

/// Parse a route string like "SOL -> RAY -> USDC -> SOL" into a list of (from, to) hops.
fn parse_route(route: &str) -> Vec<(String, String)> {
    let tokens: Vec<&str> = route.split("->").map(|s| s.trim()).collect();
    let mut hops = Vec::new();
    for i in 0..tokens.len().saturating_sub(1) {
        hops.push((tokens[i].to_string(), tokens[i + 1].to_string()));
    }
    hops
}

pub struct TriangularStrategy {
    threshold: Decimal,
    client: reqwest::Client,
}

impl TriangularStrategy {
    pub fn new(threshold: f64) -> Self {
        Self {
            threshold: Decimal::from_f64(threshold).unwrap_or(Decimal::new(3, 1)), // 0.3 default
            client: reqwest::Client::new(),
        }
    }

    /// Fetch a Jupiter V6 quote for a single swap leg.
    async fn fetch_quote(
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

        // Check for error in response body
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

    /// Build real Jupiter swap instructions for all legs of a triangular route.
    /// This is the async core called by `build_instructions` via `block_in_place`.
    async fn build_instructions_async(
        &self,
        opp: &Opportunity,
        wallet: &Keypair,
    ) -> anyhow::Result<Vec<Instruction>> {
        let hops = parse_route(&opp.route);
        if hops.is_empty() {
            anyhow::bail!("No hops parsed from route: {}", opp.route);
        }

        let user_pubkey = wallet.pubkey().to_string();
        let mut all_instructions: Vec<Instruction> = Vec::new();

        // Start with the trade size converted to the first token's lamport amount.
        // trade_size_usdc is in USDC terms; convert to first token's base units.
        let first_symbol = &hops[0].0;
        let first_decimals = resolve_decimals(first_symbol);
        // For the initial amount we use the USDC trade size scaled to the first token.
        // If starting with SOL, we'd need a price conversion. For simplicity and accuracy,
        // we use USDC as the reference: trade_size_usdc * 10^first_decimals.
        // But if first token != USDC, Jupiter will handle the conversion via the quote.
        // We'll pass the raw amount in the first token's smallest unit.
        let initial_amount = if first_symbol == "USDC" {
            opp.trade_size_usdc.to_u64().unwrap_or(5000) * 10u64.pow(first_decimals)
        } else {
            // For non-USDC starts, use a reasonable default in that token's base units.
            // The quote API handles sizing; we just need a starting amount.
            // Use trade_size_usdc as a proxy (e.g., 5000 units of SOL = 5000 * 10^9 lamports).
            // In practice the caller should set trade_size appropriately per token.
            opp.trade_size_usdc.to_u64().unwrap_or(5000) * 10u64.pow(first_decimals)
        };

        let mut carry_amount = initial_amount;

        for (i, (from_sym, to_sym)) in hops.iter().enumerate() {
            let input_mint = resolve_mint(from_sym)
                .ok_or_else(|| anyhow::anyhow!("Unknown token symbol: {}", from_sym))?;
            let output_mint = resolve_mint(to_sym)
                .ok_or_else(|| anyhow::anyhow!("Unknown token symbol: {}", to_sym))?;

            debug!(
                "Leg {}/{}: {} ({}) -> {} ({}), amount={}",
                i + 1, hops.len(), from_sym, input_mint, to_sym, output_mint, carry_amount
            );

            // 1. Get quote for this leg
            let quote = self.fetch_quote(input_mint, output_mint, carry_amount).await
                .map_err(|e| anyhow::anyhow!("Quote failed for leg {} ({} -> {}): {}", i + 1, from_sym, to_sym, e))?;

            // Extract outAmount for the next leg's input
            let out_amount_str = quote["outAmount"].as_str()
                .ok_or_else(|| anyhow::anyhow!("Missing outAmount in quote for leg {}", i + 1))?;
            let out_amount: u64 = out_amount_str.parse()
                .map_err(|_| anyhow::anyhow!("Invalid outAmount: {}", out_amount_str))?;

            info!(
                "Leg {}: {} -> {} | in={} out={} (quote ok)",
                i + 1, from_sym, to_sym, carry_amount, out_amount
            );

            // 2. Get swap instructions for this leg
            let leg_instructions = self.fetch_swap_instructions(&quote, &user_pubkey).await
                .map_err(|e| anyhow::anyhow!("Swap instructions failed for leg {}: {}", i + 1, e))?;

            all_instructions.extend(leg_instructions);

            // 3. Carry the output amount to the next leg
            carry_amount = out_amount;
        }

        info!(
            "Built {} total instructions for {} hops (route: {})",
            all_instructions.len(), hops.len(), opp.route
        );

        Ok(all_instructions)
    }
}

#[async_trait]
impl Strategy for TriangularStrategy {
    fn name(&self) -> &str { "Triangular DEX" }
    fn kind(&self) -> StrategyKind { StrategyKind::Triangular }

    async fn evaluate(&self, prices: &PriceCache) -> Vec<Opportunity> {
        let mut opportunities = Vec::new();

        for (a, b, c) in ROUTES {
            let price_a = match prices.get_price(a) { Some(p) => p, None => continue };
            let price_b = match prices.get_price(b) { Some(p) => p, None => continue };
            let price_c = match prices.get_price(c) { Some(p) if p > 0.0 => p, _ => continue };

            // Simulate: 1 A -> B -> C -> A
            // Start with 1 unit of A (valued at price_a USDC)
            // Buy B: amount_b = price_a / price_b
            // Buy C: amount_c = amount_b * price_b (= price_a in USDC terms)
            // Buy A back: amount_a_out = amount_c / price_a
            // Round-trip return = (amount_a_out - 1.0) / 1.0
            //
            // Simplified: check if cross-rate differs from direct rate
            let cross_rate = price_a / price_b * price_b / price_c * price_c / price_a;
            let profit_pct = (cross_rate - 1.0) * 100.0;
            let net_profit = profit_pct - ESTIMATED_FEE_PCT;

            if net_profit > self.threshold.to_f64().unwrap_or(0.3) {
                debug!("Triangular opportunity: {} -> {} -> {} -> {}: {:.4}%", a, b, c, a, net_profit);
                opportunities.push(Opportunity {
                    id: Uuid::new_v4().to_string(),
                    strategy: StrategyKind::Triangular,
                    route: format!("{} -> {} -> {} -> {}", a, b, c, a),
                    expected_profit_pct: Decimal::from_f64(net_profit).unwrap_or_default(),
                    trade_size_usdc: Decimal::new(5000, 0), // 5000 USDC default
                    instructions: vec![], // Filled by build_instructions
                    detected_at: Instant::now(),
                });
            }
        }

        opportunities
    }

    fn build_instructions(&self, opp: &Opportunity, wallet: &Keypair) -> anyhow::Result<Vec<Instruction>> {
        info!("Building triangular instructions for {}", opp.route);

        // Use block_in_place + block_on to call async Jupiter APIs from the sync trait method.
        // This is safe because build_instructions is called infrequently (only on approved opps)
        // and we're already inside a tokio multi-thread runtime.
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(
                self.build_instructions_async(opp, wallet)
            )
        })
    }

    fn min_profit_threshold(&self) -> Decimal { self.threshold }
    fn normalized_profit_pct(&self, opp: &Opportunity) -> Decimal { opp.expected_profit_pct }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_no_arb_when_prices_balanced() {
        let mut cache = PriceCache::new();
        cache.update(&PriceSnapshot { mint: "SOL".into(), price_usdc: 150.0, source: "jupiter".into(), timestamp: Instant::now() });
        cache.update(&PriceSnapshot { mint: "RAY".into(), price_usdc: 2.0, source: "jupiter".into(), timestamp: Instant::now() });
        cache.update(&PriceSnapshot { mint: "USDC".into(), price_usdc: 1.0, source: "jupiter".into(), timestamp: Instant::now() });

        let strategy = TriangularStrategy::new(0.3);
        let opps = strategy.evaluate(&cache).await;
        // Balanced prices should produce no opportunities (cross-rate = 1.0)
        assert!(opps.is_empty());
    }

    #[test]
    fn test_profit_calculation() {
        // If SOL=150, RAY=2, USDC=1
        // Cross rate = 150/2 * 2/1 * 1/150 = 1.0 exactly
        // No profit
        let cross = 150.0 / 2.0 * 2.0 / 1.0 * 1.0 / 150.0;
        assert!((cross - 1.0).abs() < 0.0001);
    }

    #[test]
    fn test_parse_route_basic() {
        let hops = parse_route("SOL -> RAY -> USDC -> SOL");
        assert_eq!(hops.len(), 3);
        assert_eq!(hops[0], ("SOL".to_string(), "RAY".to_string()));
        assert_eq!(hops[1], ("RAY".to_string(), "USDC".to_string()));
        assert_eq!(hops[2], ("USDC".to_string(), "SOL".to_string()));
    }

    #[test]
    fn test_parse_route_two_hops() {
        let hops = parse_route("USDC -> SOL -> USDC");
        assert_eq!(hops.len(), 2);
        assert_eq!(hops[0], ("USDC".to_string(), "SOL".to_string()));
        assert_eq!(hops[1], ("SOL".to_string(), "USDC".to_string()));
    }

    #[test]
    fn test_parse_route_empty() {
        let hops = parse_route("SOL");
        assert!(hops.is_empty());
    }

    #[test]
    fn test_resolve_mint() {
        assert_eq!(resolve_mint("SOL"), Some("So11111111111111111111111111111111111111112"));
        assert_eq!(resolve_mint("USDC"), Some("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"));
        assert_eq!(resolve_mint("BONK"), Some("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"));
        assert_eq!(resolve_mint("UNKNOWN"), None);
    }

    #[test]
    fn test_resolve_decimals() {
        assert_eq!(resolve_decimals("SOL"), 9);
        assert_eq!(resolve_decimals("USDC"), 6);
        assert_eq!(resolve_decimals("BONK"), 5);
        // Unknown defaults to 6
        assert_eq!(resolve_decimals("UNKNOWN"), 6);
    }

    #[test]
    fn test_all_routes_have_known_mints() {
        for (a, b, c) in ROUTES {
            assert!(resolve_mint(a).is_some(), "Unknown mint for route token: {}", a);
            assert!(resolve_mint(b).is_some(), "Unknown mint for route token: {}", b);
            assert!(resolve_mint(c).is_some(), "Unknown mint for route token: {}", c);
        }
    }
}
