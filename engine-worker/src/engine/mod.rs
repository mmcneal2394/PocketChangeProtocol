pub mod drift;

use solana_sdk::{
    instruction::{Instruction, AccountMeta},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
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
pub struct VaultExecutor {
    pub admin: Keypair,
    pub program_id: Pubkey,
    pub token_program: Pubkey,
}

impl VaultExecutor {
    pub fn new(admin: Keypair, program_id: Pubkey, token_program: Pubkey) -> Self {
        VaultExecutor {
            admin,
            program_id,
            token_program,
        }
    }

    /// Forms a Jito bundle or standard transaction block surrounding internal dex swaps.
    pub fn build_vault_ptb(
        &self,
        vault_state: Pubkey,
        vault_usdc: Pubkey,
        admin_usdc: Pubkey,
        treasury_usdc: Pubkey,
        borrow_amount: u64,
        reported_profit: u64,
        swap_instructions: Vec<Instruction>
    ) -> Result<Vec<Instruction>, String> {
        
        let mut ixs = Vec::new();

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

    /// Requests the actual serialized transaction or instruction arrays from Jupiter's execution endpoint
    pub async fn fetch_jupiter_instructions(&self, quote_response: serde_json::Value, user_pubkey: &str) -> Result<Vec<Instruction>, String> {
        let client = reqwest::Client::new();
        
        let payload = serde_json::json!({
            "quoteResponse": quote_response,
            "userPublicKey": user_pubkey,
            "wrapAndUnwrapSol": true,
            // Optimization for PTBs: request raw swap instructions instead of a fully-baked base64 transaction if possible.
            // Note: Currently calling /swap endpoint directly limits customization, standard PTBs parse /swap-instructions.
        });

        // Hitting the detailed instructions endpoint natively
        let resp = client.post("https://quote-api.jup.ag/v6/swap-instructions")
            .json(&payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!("Jupiter instructions failed: {}", resp.status()));
        }

        let instructions_data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        
        let mut parsed_instructions = Vec::new();

        // Helper to map Jupiter's json representation of pubkey, isSigner, isWritable to solana_sdk AccountMeta
        let parse_account_meta = |acc: &serde_json::Value| -> Result<AccountMeta, String> {
            let pubkey_str = acc["pubkey"].as_str().unwrap_or_default();
            let pubkey = pubkey_str.parse::<Pubkey>().map_err(|_| format!("Invalid pubkey: {}", pubkey_str))?;
            let is_signer = acc["isSigner"].as_bool().unwrap_or(false);
            let is_writable = acc["isWritable"].as_bool().unwrap_or(false);

            if is_writable {
                Ok(AccountMeta::new(pubkey, is_signer))
            } else {
                Ok(AccountMeta::new_readonly(pubkey, is_signer))
            }
        };

        let map_instruction = |ix: &serde_json::Value| -> Result<Instruction, String> {
            let program_id_str = ix["programId"].as_str().unwrap_or_default();
            let program_id = program_id_str.parse::<Pubkey>().map_err(|_| format!("Invalid programId: {}", program_id_str))?;
            
            let data_b64 = ix["data"].as_str().unwrap_or_default();
            let data = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data_b64).unwrap_or_default();
            
            let accounts_json = ix["accounts"].as_array().ok_or("No accounts array")?;
            let mut accounts = Vec::new();
            for acc in accounts_json {
                accounts.push(parse_account_meta(acc)?);
            }

            Ok(Instruction {
                program_id,
                accounts,
                data,
            })
        };

        // Extract setup instructions (like ATAs)
        if let Some(setup) = instructions_data["setupInstructions"].as_array() {
            for ix in setup {
                parsed_instructions.push(map_instruction(ix)?);
            }
        }
        
        // Extract the target swap ix
        if let Some(swap) = instructions_data["swapInstruction"].as_object() {
            parsed_instructions.push(map_instruction(&serde_json::Value::Object(swap.clone()))?);
        }

        Ok(parsed_instructions)
    }

}

