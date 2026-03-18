use async_trait::async_trait;
use serde_json::Value;
use solana_sdk::instruction::{Instruction, AccountMeta};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;

use crate::engine::aggregator::{DexProvider, Quote, AggregatorError};

pub struct JupiterProvider {
    client: reqwest::Client,
}

impl JupiterProvider {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl DexProvider for JupiterProvider {
    fn name(&self) -> &'static str {
        "Jupiter_v6"
    }
    
    async fn get_quote(
        &self,
        input_mint: &str,
        output_mint: &str,
        amount: u64,
    ) -> Result<Quote, AggregatorError> {
        let url = format!(
            "https://public.jupiterapi.com/quote?inputMint={}&outputMint={}&amount={}&slippageBps=50",
            input_mint, output_mint, amount
        );
        
        let res = self.client.get(&url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .send()
            .await?;
            
        let status = res.status();
        let json: Value = res.json().await?;

        if !status.is_success() || json.get("error").is_some() {
            return Err(AggregatorError::Provider {
                provider: self.name().to_string(),
                message: json.to_string(),
                status: Some(status.as_u16()),
            });
        }
        
        let out_amount_str = json["outAmount"].as_str().ok_or_else(|| AggregatorError::InvalidResponse("Missing outAmount".into()))?;
        let out_amount = out_amount_str.parse::<u64>().unwrap_or(0);
        
        Ok(Quote {
            input_mint: input_mint.to_string(),
            output_mint: output_mint.to_string(),
            in_amount: amount,
            out_amount,
            provider_name: self.name().to_string(),
            raw_response: json,
        })
    }

    async fn get_instructions(
        &self,
        quote: &Quote,
        user_pubkey: &str,
    ) -> Result<Vec<Instruction>, AggregatorError> {
        let payload = serde_json::json!({
            "quoteResponse": quote.raw_response,
            "userPublicKey": user_pubkey,
            "wrapAndUnwrapSol": true,
        });
        
        let res = self.client.post("https://public.jupiterapi.com/swap-instructions")
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
            .header("Content-Type", "application/json")
            .json(&payload)
            .send()
            .await?;
            
        let status = res.status();
        let resp_str = res.text().await.unwrap_or_default();
        
        if !status.is_success() || resp_str.contains("Rate limit") || resp_str.contains("\"error\"") {
            return Err(AggregatorError::Provider {
                provider: self.name().to_string(),
                message: resp_str,
                status: Some(status.as_u16()),
            });
        }
        
        let instructions_data: Value = serde_json::from_str(&resp_str)
            .map_err(|_| AggregatorError::InvalidResponse("Failed to parse JSON".into()))?;
            
        let mut parsed_instructions = Vec::new();

        let parse_account_meta = |acc: &Value| -> Result<AccountMeta, AggregatorError> {
            let pubkey_str = acc["pubkey"].as_str().unwrap_or_default();
            let pubkey = pubkey_str.parse::<Pubkey>().map_err(|_| AggregatorError::InvalidResponse(format!("Invalid pubkey: {:?}", pubkey_str)))?;
            let is_signer = acc["isSigner"].as_bool().unwrap_or(false);
            let is_writable = acc["isWritable"].as_bool().unwrap_or(false);

            if is_writable {
                Ok(AccountMeta::new(pubkey, is_signer))
            } else {
                Ok(AccountMeta::new_readonly(pubkey, is_signer))
            }
        };

        let map_instruction = |ix: &Value| -> Result<Instruction, AggregatorError> {
            let program_id_str = ix["programId"].as_str().unwrap_or_default();
            let program_id = program_id_str.parse::<Pubkey>().map_err(|_| AggregatorError::InvalidResponse(format!("Invalid block: {:?}", program_id_str)))?;
            
            let data_b64 = ix["data"].as_str().unwrap_or_default();
            let data = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data_b64).unwrap_or_default();
            
            let accounts_json = ix["accounts"].as_array().ok_or(AggregatorError::InvalidResponse("No accounts array".into()))?;
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

        if let Some(setup) = instructions_data["setupInstructions"].as_array() {
            for ix in setup {
                parsed_instructions.push(map_instruction(ix)?);
            }
        }
        
        if let Some(swap) = instructions_data["swapInstruction"].as_object() {
            parsed_instructions.push(map_instruction(&Value::Object(swap.clone()))?);
        } else {
             return Err(AggregatorError::InvalidResponse("Missing swapInstruction".into()));
        }

        Ok(parsed_instructions)
    }
}

pub struct OpenOceanProvider {
    client: reqwest::Client,
}

impl OpenOceanProvider {
    pub fn new() -> Self {
        Self { client: reqwest::Client::new() }
    }
}

#[async_trait]
impl DexProvider for OpenOceanProvider {
    fn name(&self) -> &'static str {
        "OpenOcean_v3"
    }
    
    async fn get_quote(
        &self,
        input_mint: &str,
        output_mint: &str,
        amount: u64,
    ) -> Result<Quote, AggregatorError> {
        // OpenOcean expects amounts scaled down to UI representation
        let is_sol = input_mint == "So11111111111111111111111111111111111111112";
        let is_usdc = input_mint == "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        let dec_in = if is_sol { 9 } else if is_usdc { 6 } else { 6 };
        
        let amount_ui = (amount as f64) / 10_f64.powi(dec_in);
        let url = format!(
            "https://open-api.openocean.finance/v3/solana/quote?inTokenAddress={}&outTokenAddress={}&amount={}&gasPrice=5&slippage=1",
            input_mint, output_mint, amount_ui
        );
        
        let res = self.client.get(&url).send().await?;
        let status = res.status();
        let json: Value = res.json().await?;

        if !status.is_success() || json.get("data").is_none() {
            return Err(AggregatorError::Provider {
                provider: self.name().to_string(),
                message: "OpenOcean JSON missing data loop".to_string(),
                status: Some(status.as_u16()),
            });
        }
        
        let out_amount_str = json["data"]["outAmount"].as_str().unwrap_or("0");
        let out_ui: f64 = out_amount_str.parse().unwrap_or(0.0);
        
        let out_is_sol = output_mint == "So11111111111111111111111111111111111111112";
        let out_is_usdc = output_mint == "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
        let dec_out = if out_is_sol { 9 } else if out_is_usdc { 6 } else { 6 };
        let out_amount = (out_ui * 10_f64.powi(dec_out)) as u64;

        Ok(Quote {
            input_mint: input_mint.to_string(),
            output_mint: output_mint.to_string(),
            in_amount: amount,
            out_amount,
            provider_name: self.name().to_string(),
            raw_response: json,
        })
    }

    async fn get_instructions(
        &self,
        quote: &Quote,
        user_pubkey: &str,
    ) -> Result<Vec<Instruction>, AggregatorError> {
        let amount_ui = (quote.in_amount as f64) / 10_f64.powi(if quote.input_mint == "So11111111111111111111111111111111111111112" { 9 } else { 6 });
        
        let url = format!(
            "https://open-api.openocean.finance/v3/solana/swap_quote?inTokenAddress={}&outTokenAddress={}&amount={}&gasPrice=5&slippage=1&account={}",
            quote.input_mint, quote.output_mint, amount_ui, user_pubkey
        );

        let res = self.client.get(&url).send().await?;
        let json: Value = res.json().await?;

        if let Some(tx_b64) = json["data"]["transaction"].as_str() {
            use base64::Engine;
            let tx_bytes = base64::engine::general_purpose::STANDARD.decode(tx_b64)
                .map_err(|_| AggregatorError::InvalidResponse("Failed B64 decode".into()))?;
            
            // Deserialize standard Solana transaction
            let v_tx: solana_sdk::transaction::VersionedTransaction = bincode::deserialize(&tx_bytes)
                .map_err(|e| AggregatorError::InvalidResponse(format!("Bincode err: {}", e)))?;
                
            // Safe extraction: ALTs currently skipped in dummy mapping, raw static compilation
            let static_keys = v_tx.message.static_account_keys();
            let mut parsed_instructions = Vec::new();
            
            for compiled_ix in v_tx.message.instructions() {
                let program_id = static_keys[compiled_ix.program_id_index as usize];
                
                let mut accounts = Vec::new();
                for &idx in &compiled_ix.accounts {
                    let pubkey = static_keys.get(idx as usize).copied().unwrap_or_default();
                    let is_signer = v_tx.message.is_signer(usize::from(idx));
                    let is_writable = v_tx.message.is_maybe_writable(usize::from(idx));
                    if is_writable {
                        accounts.push(AccountMeta::new(pubkey, is_signer));
                    } else {
                        accounts.push(AccountMeta::new_readonly(pubkey, is_signer));
                    }
                }
                
                parsed_instructions.push(Instruction {
                    program_id,
                    accounts,
                    data: compiled_ix.data.clone(),
                });
            }
            
            return Ok(parsed_instructions);
        }

        Err(AggregatorError::InvalidResponse("OpenOcean returning malformed routing instructions".into()))
    }
}
