use async_trait::async_trait;
use base64::Engine as _;
use rust_decimal::Decimal;
use rust_decimal::prelude::*;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};
use uuid::Uuid;
use std::sync::Arc;
use std::time::Instant;
use tracing::{info, debug, warn};
use crate::types::*;
use crate::price::PriceCache;
use crate::strategy::{Strategy, execution_cost_pct, extract_price_impact_pct};
use crate::tokens::TokenRegistry;

/// DEX backends to query via Jupiter's `dexes` filter parameter.
const DEXES: &[&str] = &["Raydium", "Whirlpool", "Meteora"];

const JUPITER_API: &str = "https://public.jupiterapi.com";

/// Parse a route string like "USDC -> SOL -> USDC" into a list of (from, to) hops.
fn parse_route(route: &str) -> Vec<(String, String)> {
    let tokens: Vec<&str> = route.split("->").map(|s| s.trim()).collect();
    let mut hops = Vec::new();
    for i in 0..tokens.len().saturating_sub(1) {
        hops.push((tokens[i].to_string(), tokens[i + 1].to_string()));
    }
    hops
}

/// A single DEX quote result: how much output you get and which DEX provided it.
#[derive(Debug, Clone)]
struct DexQuote {
    dex: String,
    out_amount: u64,
    /// The full Jupiter quote JSON, needed to build swap instructions later.
    raw_quote: serde_json::Value,
}

pub struct TriangularStrategy {
    threshold: Decimal,
    client: reqwest::Client,
    registry: Arc<TokenRegistry>,
}

impl TriangularStrategy {
    pub fn new(threshold: f64, registry: Arc<TokenRegistry>) -> Self {
        Self {
            threshold: Decimal::from_f64(threshold).unwrap_or(Decimal::new(5, 2)), // 0.05 default (was 0.3)
            client: reqwest::Client::new(),
            registry,
        }
    }

    fn resolve_mint(&self, symbol: &str) -> Option<String> {
        self.registry.resolve_mint(symbol).map(|s| s.to_string())
    }

    fn resolve_decimals(&self, symbol: &str) -> u32 {
        self.registry.resolve_decimals(symbol)
    }

    /// High-liquidity pairs that actually exist on multiple DEXes.
    /// Only these are worth cross-DEX checking. Curated to minimize API calls.
    fn generate_routes(&self) -> Vec<(String, String)> {
        let mut routes = vec![
            // Major pairs — deep liquidity on Raydium + Orca + Meteora
            ("SOL".into(), "USDC".into()),
            ("RAY".into(), "USDC".into()),
            ("BONK".into(), "USDC".into()),
            ("WIF".into(), "USDC".into()),
            ("JUP".into(), "USDC".into()),
            // SOL derivative pairs (staking arb — persistent small spreads)
            ("JitoSOL".into(), "SOL".into()),
            ("mSOL".into(), "SOL".into()),
            // Mid-cap with multi-DEX presence
            ("ORCA".into(), "USDC".into()),
            ("MNDE".into(), "USDC".into()),
            ("POPCAT".into(), "USDC".into()),
            ("PYTH".into(), "USDC".into()),
            ("RENDER".into(), "USDC".into()),
            ("HNT".into(), "USDC".into()),
            ("MEW".into(), "USDC".into()),
            ("BOME".into(), "USDC".into()),
            ("MYRO".into(), "USDC".into()),
            // SOL-denominated pairs (often have wider spreads)
            ("BONK".into(), "SOL".into()),
            ("WIF".into(), "SOL".into()),
            ("JUP".into(), "SOL".into()),
            ("POPCAT".into(), "SOL".into()),
            ("MEW".into(), "SOL".into()),
        ];
        // Add any tokens from the dynamic registry that aren't already listed
        for token in self.registry.all() {
            let sym = token.symbol.clone();
            if !routes.iter().any(|(a, _)| a == &sym) {
                routes.push((sym, "USDC".into()));
            }
        }
        routes
    }

    /// Fetch a Jupiter V6 quote for a single swap leg, optionally restricted to a single DEX.
    async fn fetch_quote(
        &self,
        input_mint: &str,
        output_mint: &str,
        amount: u64,
        dex: Option<&str>,
    ) -> anyhow::Result<serde_json::Value> {
        let mut url = format!(
            "{}/quote?inputMint={}&outputMint={}&amount={}&slippageBps=50",
            JUPITER_API, input_mint, output_mint, amount
        );
        if let Some(dex_name) = dex {
            url.push_str(&format!("&dexes={}", dex_name));
        }

        let mut req = self.client.get(&url)
            .header("User-Agent", "ArbitraSaaS-Engine/0.1");
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

    /// Query all configured DEXes for a single pair direction and return per-DEX quotes.
    async fn fetch_quotes_all_dexes(
        &self,
        input_mint: &str,
        output_mint: &str,
        amount: u64,
        from_sym: &str,
        to_sym: &str,
    ) -> Vec<DexQuote> {
        let mut quotes = Vec::new();
        for dex in DEXES {
            match self.fetch_quote(input_mint, output_mint, amount, Some(dex)).await {
                Ok(json) => {
                    if let Some(out_str) = json["outAmount"].as_str() {
                        if let Ok(out_amount) = out_str.parse::<u64>() {
                            debug!(
                                "{}: {} -> {} | in={} out={} via {}",
                                dex, from_sym, to_sym, amount, out_amount, dex
                            );
                            quotes.push(DexQuote {
                                dex: dex.to_string(),
                                out_amount,
                                raw_quote: json,
                            });
                        }
                    }
                }
                Err(e) => {
                    debug!("Quote {}->{} via {} failed: {}", from_sym, to_sym, dex, e);
                }
            }
        }
        quotes
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

    /// Build real Jupiter swap instructions for both legs of a cross-DEX arb.
    /// Route format: "USDC -[Raydium]-> SOL -[Whirlpool]-> USDC"
    /// This is the async core called by `build_instructions` via `block_in_place`.
    async fn build_instructions_async(
        &self,
        opp: &Opportunity,
        wallet: &Keypair,
    ) -> anyhow::Result<Vec<Instruction>> {
        let hops = parse_route(&opp.route);
        if hops.len() != 2 {
            anyhow::bail!("Cross-DEX arb requires exactly 2 hops, got {}: {}", hops.len(), opp.route);
        }

        let user_pubkey = wallet.pubkey().to_string();
        let mut all_instructions: Vec<Instruction> = Vec::new();

        let first_symbol = &hops[0].0;
        let first_decimals = self.resolve_decimals(first_symbol);
        let initial_amount = opp.trade_size_usdc.to_u64().unwrap_or(5000) * 10u64.pow(first_decimals);
        let mut carry_amount = initial_amount;

        // Parse DEX info from the route: "USDC -[Raydium]-> SOL -[Whirlpool]-> USDC"
        // Split by "->" and look for [DexName] patterns in the segments
        let route_str = &opp.route;
        let mut leg_dexes: Vec<Option<String>> = Vec::new();
        for part in route_str.split("->") {
            let trimmed = part.trim();
            if trimmed.contains('[') && trimmed.contains(']') {
                let start = trimmed.find('[').unwrap();
                let end = trimmed.find(']').unwrap();
                let dex_name = &trimmed[start + 1..end];
                leg_dexes.push(Some(dex_name.to_string()));
            }
        }

        for (i, (from_sym, to_sym)) in hops.iter().enumerate() {
            // Strip any [DexName] annotation from the symbol
            let clean_from = from_sym.split('[').next().unwrap_or(from_sym).trim();
            let clean_to = to_sym.split('[').next().unwrap_or(to_sym).trim();

            let input_mint = self.resolve_mint(clean_from)
                .ok_or_else(|| anyhow::anyhow!("Unknown token symbol: {}", clean_from))?;
            let output_mint = self.resolve_mint(clean_to)
                .ok_or_else(|| anyhow::anyhow!("Unknown token symbol: {}", clean_to))?;

            let dex_filter = leg_dexes.get(i).and_then(|d| d.as_deref());

            debug!(
                "Leg {}/{}: {} -> {} (dex={:?}), amount={}",
                i + 1, hops.len(), clean_from, clean_to, dex_filter, carry_amount
            );

            // Get quote restricted to the specific DEX for this leg
            let quote = self.fetch_quote(&input_mint, &output_mint, carry_amount, dex_filter).await
                .map_err(|e| anyhow::anyhow!("Quote failed for leg {} ({} -> {}): {}", i + 1, clean_from, clean_to, e))?;

            let out_amount_str = quote["outAmount"].as_str()
                .ok_or_else(|| anyhow::anyhow!("Missing outAmount in quote for leg {}", i + 1))?;
            let out_amount: u64 = out_amount_str.parse()
                .map_err(|_| anyhow::anyhow!("Invalid outAmount: {}", out_amount_str))?;

            info!(
                "Leg {}: {} -> {} via {:?} | in={} out={}",
                i + 1, clean_from, clean_to, dex_filter, carry_amount, out_amount
            );

            let leg_instructions = self.fetch_swap_instructions(&quote, &user_pubkey).await
                .map_err(|e| anyhow::anyhow!("Swap instructions failed for leg {}: {}", i + 1, e))?;

            all_instructions.extend(leg_instructions);
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
    fn name(&self) -> &str { "Cross-DEX Spread" }
    fn kind(&self) -> StrategyKind { StrategyKind::Triangular }

    async fn evaluate(&self, prices: &PriceCache) -> Vec<Opportunity> {
        let mut opportunities = Vec::new();
        let routes = self.generate_routes();

        for (token_a, token_b) in &routes {
            // Skip pairs where we don't have a cached price for either token
            if prices.get_price(token_a).is_none() && prices.get_price(token_b).is_none() {
                continue;
            }

            let mint_a = match self.resolve_mint(token_a) { Some(m) => m, None => continue };
            let mint_b = match self.resolve_mint(token_b) { Some(m) => m, None => continue };

            let decimals_a = self.resolve_decimals(token_a);
            // Use ~$100 worth for realistic spread detection (1 unit distorts prices)
            let base_unit: u64 = 10u64.pow(decimals_a);
            let start_amount: u64 = if token_a == "SOL" || token_a == "JitoSOL" || token_a == "mSOL" {
                base_unit / 2 // ~0.5 SOL ≈ $75
            } else if token_a == "USDC" {
                100 * base_unit // $100
            } else {
                base_unit * 100 // 100 units of token
            };

            // --- Buy leg: A -> B on each DEX ---
            let buy_quotes = self.fetch_quotes_all_dexes(
                &mint_a, &mint_b, start_amount, token_a, token_b,
            ).await;

            if buy_quotes.len() < 2 {
                debug!("{}/{}: fewer than 2 DEX quotes for buy leg, skipping", token_a, token_b);
                continue;
            }

            // --- Find best buy DEX ---
            let best_buy = buy_quotes.iter().max_by_key(|q| q.out_amount).unwrap();

            // --- Sell leg: B -> A on each DEX using best buy output ---
            let sell_quotes_precise = self.fetch_quotes_all_dexes(
                &mint_b, &mint_a, best_buy.out_amount, token_b, token_a,
            ).await;

            if sell_quotes_precise.len() < 2 {
                debug!("{}/{}: fewer than 2 DEX quotes for sell leg, skipping", token_a, token_b);
                continue;
            }

            // Best sell = DEX that gives the MOST A back for our B (highest out_amount on sell)
            let best_sell = match sell_quotes_precise.iter()
                .filter(|q| q.dex != best_buy.dex) // Must be a different DEX for cross-DEX arb
                .max_by_key(|q| q.out_amount)
            {
                Some(s) => s,
                None => {
                    // Fallback: allow same DEX if it still shows profit (unlikely but possible)
                    match sell_quotes_precise.iter().max_by_key(|q| q.out_amount) {
                        Some(s) => s,
                        None => continue,
                    }
                }
            };

            // Profit: did we get more A back than we started with?
            let gross_profit_pct = ((best_sell.out_amount as f64 / start_amount as f64) - 1.0) * 100.0;

            // --- Accurate fee calculation ---
            let sol_price = prices.get_price("SOL").unwrap_or(150.0);
            let trade_size = 100.0_f64; // USDC
            // 2 transactions (buy leg + sell leg) with safety margin
            let fixed_cost_pct = execution_cost_pct(sol_price, trade_size, 2);
            // Sum price impact from both leg quotes
            let buy_impact = extract_price_impact_pct(&best_buy.raw_quote);
            let sell_impact = extract_price_impact_pct(&best_sell.raw_quote);
            let total_price_impact_pct = buy_impact + sell_impact;
            let total_fees_pct = fixed_cost_pct + total_price_impact_pct;
            let net_profit = gross_profit_pct - total_fees_pct;

            // Sanity check
            if net_profit > 10.0 || net_profit < -50.0 {
                warn!("{}/{}: insane profit {:.2}% — likely decimals mismatch, skipping", token_a, token_b, net_profit);
                continue;
            }

            info!(
                "{}/{}: buy on {} (out={}), sell on {} (out={}) | gross={:.4}% fees={:.4}% net={:.4}%",
                token_a, token_b,
                best_buy.dex, best_buy.out_amount,
                best_sell.dex, best_sell.out_amount,
                gross_profit_pct, total_fees_pct, net_profit
            );

            if net_profit > self.threshold.to_f64().unwrap_or(0.3) {
                info!(
                    "CROSS-DEX ARB FOUND: {} buy-on-{} sell-on-{}: {:.4}% net",
                    token_a, best_buy.dex, best_sell.dex, net_profit
                );
                let route = format!(
                    "{} -[{}]-> {} -[{}]-> {}",
                    token_a, best_buy.dex, token_b, best_sell.dex, token_a
                );
                opportunities.push(Opportunity {
                    id: Uuid::new_v4().to_string(),
                    strategy: StrategyKind::Triangular,
                    route,
                    expected_profit_pct: Decimal::from_f64(net_profit).unwrap_or_default(),
                    estimated_fees_pct: Decimal::from_f64(total_fees_pct).unwrap_or_default(),
                    trade_size_usdc: Decimal::new(45, 0),
                    instructions: vec![],
                    detected_at: Instant::now(),
                });
            }
        }

        opportunities
    }

    fn build_instructions(&self, opp: &Opportunity, wallet: &Keypair) -> anyhow::Result<Vec<Instruction>> {
        info!("Building cross-DEX instructions for {}", opp.route);

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

    fn test_registry() -> Arc<TokenRegistry> {
        Arc::new(TokenRegistry::new_with_defaults())
    }

    #[tokio::test]
    async fn test_no_arb_when_prices_balanced() {
        let mut cache = PriceCache::new();
        cache.update(&PriceSnapshot { mint: "SOL".into(), price_usdc: 150.0, source: "jupiter".into(), timestamp: Instant::now() });
        cache.update(&PriceSnapshot { mint: "RAY".into(), price_usdc: 2.0, source: "jupiter".into(), timestamp: Instant::now() });
        cache.update(&PriceSnapshot { mint: "USDC".into(), price_usdc: 1.0, source: "jupiter".into(), timestamp: Instant::now() });

        let strategy = TriangularStrategy::new(0.3, test_registry());
        let opps = strategy.evaluate(&cache).await;
        // Balanced prices should produce no opportunities (cross-DEX spreads are tiny)
        assert!(opps.is_empty());
    }

    #[test]
    fn test_profit_calculation() {
        use crate::strategy::{execution_cost_pct};
        // Cross-DEX spread: buy 1 SOL on Raydium for 150 USDC, sell on Orca for 150.6 USDC
        // Gross profit = (150.6 - 150.0) / 150.0 * 100 = 0.4%
        let buy_cost = 150.0_f64;
        let sell_revenue = 150.6_f64;
        let gross = (sell_revenue / buy_cost - 1.0) * 100.0;
        // Real fees: 2 txs at SOL price $150, trade size $100
        let fees = execution_cost_pct(150.0, 100.0, 2);
        let net = gross - fees;
        assert!(gross > 0.3);
        assert!(net > 0.0);
        // Fee should be small relative to trade size
        assert!(fees < 0.1, "Fixed fee pct should be tiny: {}", fees);
    }

    #[test]
    fn test_parse_route_cross_dex() {
        let hops = parse_route("USDC -[Raydium]-> SOL -[Whirlpool]-> USDC");
        assert_eq!(hops.len(), 2);
        // Note: the DEX annotations are part of the token strings from naive splitting;
        // build_instructions_async handles stripping them.
        assert_eq!(hops[0].0, "USDC -[Raydium]");
        assert_eq!(hops[0].1, "SOL -[Whirlpool]");
        assert_eq!(hops[1].0, "SOL -[Whirlpool]");
        assert_eq!(hops[1].1, "USDC");
    }

    #[test]
    fn test_parse_route_simple_two_hops() {
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
        let registry = test_registry();
        assert_eq!(registry.resolve_mint("SOL"), Some("So11111111111111111111111111111111111111112"));
        assert_eq!(registry.resolve_mint("USDC"), Some("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"));
        assert_eq!(registry.resolve_mint("BONK"), Some("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"));
        assert_eq!(registry.resolve_mint("UNKNOWN"), None);
    }

    #[test]
    fn test_resolve_decimals() {
        let registry = test_registry();
        assert_eq!(registry.resolve_decimals("SOL"), 9);
        assert_eq!(registry.resolve_decimals("USDC"), 6);
        assert_eq!(registry.resolve_decimals("BONK"), 5);
        // Unknown defaults to 6
        assert_eq!(registry.resolve_decimals("UNKNOWN"), 6);
    }

    #[test]
    fn test_all_routes_have_known_mints() {
        let strategy = TriangularStrategy::new(0.3, test_registry());
        let routes = strategy.generate_routes();
        for (a, b) in &routes {
            assert!(strategy.resolve_mint(a).is_some(), "Unknown mint for route token: {}", a);
            assert!(strategy.resolve_mint(b).is_some(), "Unknown mint for route token: {}", b);
        }
    }

    #[test]
    fn test_dexes_list() {
        assert_eq!(DEXES.len(), 3);
        assert!(DEXES.contains(&"Raydium"));
        assert!(DEXES.contains(&"Whirlpool"));
        assert!(DEXES.contains(&"Meteora"));
    }

    #[test]
    fn test_routes_are_pairs() {
        let strategy = TriangularStrategy::new(0.3, test_registry());
        let routes = strategy.generate_routes();
        for (a, b) in &routes {
            assert!(!a.is_empty());
            assert!(!b.is_empty());
            assert_ne!(a, b, "Route pair must have different tokens");
        }
    }
}
