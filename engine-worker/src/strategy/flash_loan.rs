use async_trait::async_trait;
use rust_decimal::Decimal;
use rust_decimal::prelude::*;
use solana_sdk::instruction::{Instruction, AccountMeta};
use solana_sdk::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};
use uuid::Uuid;
use std::str::FromStr;
use std::time::Instant;
use tracing::{info, debug, warn};
use crate::types::*;
use crate::price::PriceCache;
use crate::strategy::Strategy;
use crate::engine::get_discriminator;

const ESTIMATED_FEE_PCT: f64 = 0.3;

/// USDC mint on Solana mainnet (6 decimals)
const USDC_MINT: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/// Known token mints for route resolution
const TOKEN_MINTS: &[(&str, &str)] = &[
    ("SOL", "So11111111111111111111111111111111111111112"),
    ("RAY", "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R"),
    ("BONK", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"),
    ("WIF", "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm"),
    ("mSOL", "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So"),
    ("JitoSOL", "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"),
];

/// Jupiter API slippage tolerance in basis points
const SLIPPAGE_BPS: u32 = 50;

pub struct FlashLoanStrategy {
    threshold: Decimal,
    vault_available: bool,
    /// PocketChange vault program ID
    program_id: Pubkey,
    /// SPL Token program ID
    token_program: Pubkey,
    /// Vault state PDA
    vault_state: Pubkey,
    /// Vault's USDC token account
    vault_usdc: Pubkey,
    /// Treasury USDC token account (receives 20% profit)
    treasury_usdc: Pubkey,
    /// HTTP client for Jupiter API calls
    http_client: reqwest::Client,
}

impl FlashLoanStrategy {
    pub fn new(threshold: f64, vault_available: bool) -> Self {
        // Default PDAs — in production these are derived or loaded from config.
        // Using the on-chain program ID from CLAUDE.md.
        let program_id = Pubkey::from_str("GKUwMKjS4UU5zFQXV83oNjm8DZmVpYzyiTGAhHEiCnLR")
            .unwrap_or_default();
        let token_program = spl_token_id();

        // Derive vault state PDA: seeds = [b"vault"]
        let (vault_state, _) = Pubkey::find_program_address(&[b"vault"], &program_id);
        // Derive vault USDC ATA: seeds = [b"vault_usdc"]
        let (vault_usdc, _) = Pubkey::find_program_address(&[b"vault_usdc"], &program_id);
        // Derive treasury USDC ATA: seeds = [b"treasury"]
        let (treasury_usdc, _) = Pubkey::find_program_address(&[b"treasury"], &program_id);

        Self {
            threshold: Decimal::from_f64(threshold).unwrap_or(Decimal::new(3, 1)),
            vault_available,
            program_id,
            token_program,
            vault_state,
            vault_usdc,
            treasury_usdc,
            http_client: reqwest::Client::new(),
        }
    }

    /// Resolve a token symbol (e.g. "RAY") to its mint address string.
    fn resolve_mint(symbol: &str) -> Option<&'static str> {
        if symbol == "USDC" {
            return Some(USDC_MINT);
        }
        TOKEN_MINTS.iter().find(|(s, _)| *s == symbol).map(|(_, m)| *m)
    }

    /// Extract the intermediate token symbol from the route string.
    /// Routes are formatted as "USDC -> TOKEN -> USDC (flash loan)".
    fn parse_route_token(route: &str) -> Option<String> {
        // "USDC -> RAY -> USDC (flash loan)" => "RAY"
        let parts: Vec<&str> = route.split(" -> ").collect();
        if parts.len() >= 2 {
            // Second segment is the token, possibly with trailing text
            let token = parts[1].split_whitespace().next().unwrap_or("");
            if !token.is_empty() {
                return Some(token.to_string());
            }
        }
        None
    }

    /// Fetch a Jupiter quote for a swap route.
    async fn fetch_jupiter_quote(
        &self,
        input_mint: &str,
        output_mint: &str,
        amount: u64,
    ) -> anyhow::Result<serde_json::Value> {
        let url = format!(
            "https://public.jupiterapi.com/quote?inputMint={}&outputMint={}&amount={}&slippageBps={}",
            input_mint, output_mint, amount, SLIPPAGE_BPS
        );

        let resp = self.http_client
            .get(&url)
            .header("User-Agent", "Mozilla/5.0 ArbitraSaaS-Engine/0.1")
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(anyhow::anyhow!("Jupiter quote failed: HTTP {}", resp.status()));
        }

        let body: serde_json::Value = resp.json().await?;
        if body.get("error").is_some() {
            return Err(anyhow::anyhow!("Jupiter quote error: {}", body));
        }

        Ok(body)
    }

    /// Fetch swap instructions from Jupiter's swap-instructions endpoint.
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

        let resp = self.http_client
            .post("https://public.jupiterapi.com/swap-instructions")
            .header("User-Agent", "Mozilla/5.0 ArbitraSaaS-Engine/0.1")
            .header("Content-Type", "application/json")
            .json(&payload)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await?;

        if !resp.status().is_success() {
            return Err(anyhow::anyhow!("Jupiter swap-instructions failed: HTTP {}", resp.status()));
        }

        let instructions_data: serde_json::Value = resp.json().await?;
        let mut parsed = Vec::new();

        // Parse setup instructions (ATA creation, etc.)
        if let Some(setup) = instructions_data["setupInstructions"].as_array() {
            for ix in setup {
                parsed.push(Self::parse_jupiter_instruction(ix)?);
            }
        }

        // Parse the main swap instruction
        if let Some(swap) = instructions_data["swapInstruction"].as_object() {
            parsed.push(Self::parse_jupiter_instruction(
                &serde_json::Value::Object(swap.clone()),
            )?);
        } else {
            return Err(anyhow::anyhow!("Missing swapInstruction in Jupiter response"));
        }

        Ok(parsed)
    }

    /// Parse a single Jupiter JSON instruction into a Solana Instruction.
    fn parse_jupiter_instruction(ix: &serde_json::Value) -> anyhow::Result<Instruction> {
        let program_id_str = ix["programId"].as_str().unwrap_or_default();
        let program_id = program_id_str
            .parse::<Pubkey>()
            .map_err(|_| anyhow::anyhow!("Invalid programId: {}", program_id_str))?;

        let data_b64 = ix["data"].as_str().unwrap_or_default();
        let data = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            data_b64,
        )
        .unwrap_or_default();

        let accounts_json = ix["accounts"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("No accounts array in instruction"))?;

        let mut accounts = Vec::new();
        for acc in accounts_json {
            let pubkey_str = acc["pubkey"].as_str().unwrap_or_default();
            let pubkey = pubkey_str
                .parse::<Pubkey>()
                .map_err(|_| anyhow::anyhow!("Invalid pubkey: {}", pubkey_str))?;
            let is_signer = acc["isSigner"].as_bool().unwrap_or(false);
            let is_writable = acc["isWritable"].as_bool().unwrap_or(false);

            if is_writable {
                accounts.push(AccountMeta::new(pubkey, is_signer));
            } else {
                accounts.push(AccountMeta::new_readonly(pubkey, is_signer));
            }
        }

        Ok(Instruction {
            program_id,
            accounts,
            data,
        })
    }

    /// Build the vault borrow instruction.
    fn build_borrow_ix(&self, admin: &Pubkey, admin_usdc: &Pubkey, borrow_amount: u64) -> Instruction {
        let mut data = get_discriminator("borrow_for_arbitrage").to_vec();
        data.extend_from_slice(&borrow_amount.to_le_bytes());

        Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(*admin, true),
                AccountMeta::new(self.vault_state, false),
                AccountMeta::new(self.vault_usdc, false),
                AccountMeta::new(*admin_usdc, false),
                AccountMeta::new_readonly(self.token_program, false),
            ],
            data,
        }
    }

    /// Build the vault process_arbitrage (repay + profit split) instruction.
    fn build_process_ix(&self, admin: &Pubkey, reported_profit: u64) -> Instruction {
        let mut data = get_discriminator("process_arbitrage").to_vec();
        data.extend_from_slice(&reported_profit.to_le_bytes());

        Instruction {
            program_id: self.program_id,
            accounts: vec![
                AccountMeta::new(*admin, true),
                AccountMeta::new(self.vault_state, false),
                AccountMeta::new(self.vault_usdc, false),
                AccountMeta::new(self.treasury_usdc, false),
                AccountMeta::new_readonly(self.token_program, false),
            ],
            data,
        }
    }

    /// Derive the admin's USDC associated token account.
    fn derive_admin_usdc_ata(admin: &Pubkey) -> Pubkey {
        let usdc_mint = Pubkey::from_str(USDC_MINT).unwrap();
        // ATA = PDA([admin, TOKEN_PROGRAM_ID, mint], ATA_PROGRAM_ID)
        let ata_program = Pubkey::from_str("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL").unwrap();
        let (ata, _) = Pubkey::find_program_address(
            &[admin.as_ref(), spl_token_id().as_ref(), usdc_mint.as_ref()],
            &ata_program,
        );
        ata
    }

    /// Full async pipeline: quote -> swap ixs -> wrap with borrow/repay.
    async fn build_flash_loan_ixs(
        &self,
        opp: &Opportunity,
        wallet: &Keypair,
    ) -> anyhow::Result<Vec<Instruction>> {
        let token_symbol = Self::parse_route_token(&opp.route)
            .ok_or_else(|| anyhow::anyhow!("Cannot parse token from route: {}", opp.route))?;

        let token_mint = Self::resolve_mint(&token_symbol)
            .ok_or_else(|| anyhow::anyhow!("Unknown token mint for: {}", token_symbol))?;

        // Convert trade_size_usdc to u64 lamports (USDC has 6 decimals)
        let borrow_amount: u64 = (opp.trade_size_usdc * Decimal::new(1_000_000, 0))
            .to_u64()
            .unwrap_or(10_000_000_000); // fallback 10k USDC

        let admin_pubkey = wallet.pubkey();
        let admin_usdc = Self::derive_admin_usdc_ata(&admin_pubkey);
        let user_pubkey_str = admin_pubkey.to_string();

        info!(
            "Flash loan: borrowing {} USDC lamports, route USDC -> {} -> USDC",
            borrow_amount, token_symbol
        );

        // Leg 1: USDC -> Token
        let quote_leg1 = self
            .fetch_jupiter_quote(USDC_MINT, token_mint, borrow_amount)
            .await?;

        let leg1_out_amount = quote_leg1["outAmount"]
            .as_str()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);

        if leg1_out_amount == 0 {
            return Err(anyhow::anyhow!("Jupiter returned zero outAmount for leg 1"));
        }

        let swap_ixs_leg1 = self
            .fetch_swap_instructions(&quote_leg1, &user_pubkey_str)
            .await?;

        // Leg 2: Token -> USDC
        let quote_leg2 = self
            .fetch_jupiter_quote(token_mint, USDC_MINT, leg1_out_amount)
            .await?;

        let leg2_out_amount = quote_leg2["outAmount"]
            .as_str()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);

        if leg2_out_amount == 0 {
            return Err(anyhow::anyhow!("Jupiter returned zero outAmount for leg 2"));
        }

        let swap_ixs_leg2 = self
            .fetch_swap_instructions(&quote_leg2, &user_pubkey_str)
            .await?;

        // Calculate reported profit (USDC lamports returned minus borrowed)
        let reported_profit = leg2_out_amount.saturating_sub(borrow_amount);

        info!(
            "Flash loan projected: borrow={} return={} profit={} USDC lamports",
            borrow_amount, leg2_out_amount, reported_profit
        );

        if reported_profit == 0 {
            warn!("Flash loan would not be profitable after slippage, skipping");
            return Err(anyhow::anyhow!("Unprofitable after slippage"));
        }

        // Assemble: borrow -> swap leg1 -> swap leg2 -> process_arbitrage
        let mut all_ixs = Vec::new();

        // 1. Borrow from vault
        all_ixs.push(self.build_borrow_ix(&admin_pubkey, &admin_usdc, borrow_amount));

        // 2. Swap USDC -> Token (setup + swap)
        all_ixs.extend(swap_ixs_leg1);

        // 3. Swap Token -> USDC (setup + swap)
        all_ixs.extend(swap_ixs_leg2);

        // 4. Return principal + split profit
        all_ixs.push(self.build_process_ix(&admin_pubkey, reported_profit));

        info!(
            "[PocketChange] Flash loan assembled: {} instructions, borrow {} -> profit {} USDC",
            all_ixs.len(),
            borrow_amount,
            reported_profit
        );

        Ok(all_ixs)
    }
}

/// SPL Token program ID
fn spl_token_id() -> Pubkey {
    Pubkey::from_str("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA").unwrap()
}

#[async_trait]
impl Strategy for FlashLoanStrategy {
    fn name(&self) -> &str { "Flash Loan" }
    fn kind(&self) -> StrategyKind { StrategyKind::FlashLoan }

    async fn evaluate(&self, prices: &PriceCache) -> Vec<Opportunity> {
        if !self.vault_available {
            return vec![];
        }

        let mut opportunities = Vec::new();

        // Check USDC -> token -> USDC routes via Jupiter
        let usdc_price = prices.get_price("USDC").unwrap_or(1.0);
        let sol_price = match prices.get_price("SOL") {
            Some(p) if p > 0.0 => p,
            _ => return vec![],
        };

        // Look for price discrepancies across available tokens
        let tokens = ["RAY", "BONK", "WIF", "mSOL", "JitoSOL"];
        for token in &tokens {
            let token_price = match prices.get_price(token) {
                Some(p) if p > 0.0 => p,
                _ => continue,
            };

            // Simulate: borrow USDC -> buy token -> sell token for USDC
            // If we can get more USDC back than we borrowed, it's profitable
            let round_trip = usdc_price / token_price * token_price / usdc_price;
            let profit_pct = (round_trip - 1.0) * 100.0;
            let net_profit = profit_pct - ESTIMATED_FEE_PCT;

            if net_profit > self.threshold.to_f64().unwrap_or(0.3) {
                debug!("Flash loan opportunity: USDC -> {} -> USDC: {:.4}%", token, net_profit);
                opportunities.push(Opportunity {
                    id: Uuid::new_v4().to_string(),
                    strategy: StrategyKind::FlashLoan,
                    route: format!("USDC -> {} -> USDC (flash loan)", token),
                    expected_profit_pct: Decimal::from_f64(net_profit).unwrap_or_default(),
                    trade_size_usdc: Decimal::new(10000, 0), // 10,000 USDC from vault
                    instructions: vec![],
                    detected_at: Instant::now(),
                });
            }
        }

        opportunities
    }

    fn build_instructions(&self, opp: &Opportunity, wallet: &Keypair) -> anyhow::Result<Vec<Instruction>> {
        if !self.vault_available {
            return Err(anyhow::anyhow!("Vault program not available"));
        }

        info!("Building flash loan instructions for {}", opp.route);

        // build_flash_loan_ixs is async — bridge into the current tokio runtime.
        // We use block_in_place + block_on so we don't deadlock multi-threaded tokio.
        let handle = tokio::runtime::Handle::current();
        let result = tokio::task::block_in_place(|| {
            handle.block_on(self.build_flash_loan_ixs(opp, wallet))
        });

        result
    }

    fn min_profit_threshold(&self) -> Decimal { self.threshold }

    fn normalized_profit_pct(&self, opp: &Opportunity) -> Decimal {
        opp.expected_profit_pct
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_disabled_when_vault_unavailable() {
        let cache = PriceCache::new();
        let strategy = FlashLoanStrategy::new(0.3, false);
        let opps = strategy.evaluate(&cache).await;
        assert!(opps.is_empty());
    }

    #[tokio::test]
    async fn test_no_opportunity_when_prices_balanced() {
        let mut cache = PriceCache::new();
        cache.update(&PriceSnapshot { mint: "SOL".into(), price_usdc: 150.0, source: "jupiter".into(), timestamp: Instant::now() });
        cache.update(&PriceSnapshot { mint: "USDC".into(), price_usdc: 1.0, source: "jupiter".into(), timestamp: Instant::now() });
        cache.update(&PriceSnapshot { mint: "RAY".into(), price_usdc: 2.0, source: "jupiter".into(), timestamp: Instant::now() });

        let strategy = FlashLoanStrategy::new(0.3, true);
        let opps = strategy.evaluate(&cache).await;
        assert!(opps.is_empty()); // Balanced = no profit
    }

    #[test]
    fn test_parse_route_token() {
        assert_eq!(
            FlashLoanStrategy::parse_route_token("USDC -> RAY -> USDC (flash loan)"),
            Some("RAY".to_string())
        );
        assert_eq!(
            FlashLoanStrategy::parse_route_token("USDC -> mSOL -> USDC (flash loan)"),
            Some("mSOL".to_string())
        );
        assert_eq!(
            FlashLoanStrategy::parse_route_token("invalid"),
            None
        );
    }

    #[test]
    fn test_resolve_mint() {
        assert_eq!(
            FlashLoanStrategy::resolve_mint("USDC"),
            Some("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
        );
        assert_eq!(
            FlashLoanStrategy::resolve_mint("RAY"),
            Some("4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R")
        );
        assert!(FlashLoanStrategy::resolve_mint("UNKNOWN").is_none());
    }

    #[test]
    fn test_build_borrow_ix_discriminator() {
        let strategy = FlashLoanStrategy::new(0.3, true);
        let admin = Pubkey::new_unique();
        let admin_usdc = Pubkey::new_unique();
        let ix = strategy.build_borrow_ix(&admin, &admin_usdc, 10_000_000_000);

        // First 8 bytes should be the discriminator for "borrow_for_arbitrage"
        assert_eq!(&ix.data[..8], &get_discriminator("borrow_for_arbitrage"));
        // Next 8 bytes should be the borrow amount in LE
        assert_eq!(&ix.data[8..16], &10_000_000_000u64.to_le_bytes());
        // 5 accounts: admin, vault_state, vault_usdc, admin_usdc, token_program
        assert_eq!(ix.accounts.len(), 5);
        assert_eq!(ix.program_id, strategy.program_id);
    }

    #[test]
    fn test_build_process_ix_discriminator() {
        let strategy = FlashLoanStrategy::new(0.3, true);
        let admin = Pubkey::new_unique();
        let ix = strategy.build_process_ix(&admin, 500_000);

        assert_eq!(&ix.data[..8], &get_discriminator("process_arbitrage"));
        assert_eq!(&ix.data[8..16], &500_000u64.to_le_bytes());
        assert_eq!(ix.accounts.len(), 5);
    }

    #[test]
    fn test_build_instructions_fails_when_vault_unavailable() {
        let strategy = FlashLoanStrategy::new(0.3, false);
        let wallet = Keypair::new();
        let opp = Opportunity {
            id: "test".to_string(),
            strategy: StrategyKind::FlashLoan,
            route: "USDC -> RAY -> USDC (flash loan)".to_string(),
            expected_profit_pct: Decimal::new(5, 1),
            trade_size_usdc: Decimal::new(10000, 0),
            instructions: vec![],
            detected_at: Instant::now(),
        };
        let result = strategy.build_instructions(&opp, &wallet);
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("Vault program not available"));
    }
}
