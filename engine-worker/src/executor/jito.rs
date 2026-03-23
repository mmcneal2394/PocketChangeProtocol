use solana_sdk::{
    instruction::Instruction,
    pubkey::Pubkey,
    signature::Keypair,
    signer::Signer,
    system_instruction,
    transaction::Transaction,
    hash::Hash,
};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use tracing::info;
use std::str::FromStr;

/// Jito tip program
const JITO_TIP_PROGRAM: &str = "T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt";

/// Jito tip accounts (randomly select one)
const JITO_TIP_ACCOUNTS: &[&str] = &[
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4bPqMViA3k9TVBvD5uhj3YH",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLM4",
    "ADaUMid9yfUytqMBgopwjb2DTLSLl4RMjpGfqdbt5jQ5",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSMNMgBMIcQMhyMu3Db",
    "DttWaMuVvTiDuNGoQxQjunGipXzNGfBwJfxPaoTBzrS2",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

pub struct JitoClient {
    endpoint: String,
    client: reqwest::Client,
}

impl JitoClient {
    pub fn new(endpoint: String) -> Self {
        Self {
            endpoint,
            client: reqwest::Client::new(),
        }
    }

    /// Build a Jito bundle from instructions: wraps into transaction + appends tip
    pub fn build_bundle(
        &self,
        instructions: Vec<Instruction>,
        tip_lamports: u64,
        payer: &Keypair,
        recent_blockhash: Hash,
    ) -> Vec<Transaction> {
        let tip_account = self.random_tip_account();
        let tip_ix = system_instruction::transfer(
            &payer.pubkey(),
            &tip_account,
            tip_lamports,
        );

        let mut all_ixs = instructions;
        all_ixs.push(tip_ix);

        let tx = Transaction::new_signed_with_payer(
            &all_ixs,
            Some(&payer.pubkey()),
            &[payer],
            recent_blockhash,
        );

        vec![tx]
    }

    /// Submit bundle to Jito block engine
    pub async fn submit_bundle(&self, bundle: &[Transaction]) -> anyhow::Result<String> {
        let encoded: Vec<String> = bundle.iter()
            .map(|tx| {
                let serialized = bincode::serialize(tx).unwrap();
                BASE64.encode(&serialized)
            })
            .collect();

        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "sendBundle",
            "params": [encoded]
        });

        let resp = self.client.post(&format!("{}/api/v1/bundles", self.endpoint))
            .json(&body)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await?;

        let result: serde_json::Value = resp.json().await?;

        if let Some(error) = result.get("error") {
            return Err(anyhow::anyhow!("Jito bundle error: {}", error));
        }

        let bundle_id = result["result"]
            .as_str()
            .unwrap_or("unknown")
            .to_string();

        info!("Jito bundle submitted: {}", bundle_id);
        Ok(bundle_id)
    }

    fn random_tip_account(&self) -> Pubkey {
        let idx = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .subsec_nanos() as usize % JITO_TIP_ACCOUNTS.len();
        Pubkey::from_str(JITO_TIP_ACCOUNTS[idx]).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bundle_includes_tip() {
        let payer = Keypair::new();
        let client = JitoClient::new("https://test.jito.wtf".into());
        let swap_ix = system_instruction::transfer(
            &payer.pubkey(),
            &payer.pubkey(),
            1000,
        );
        let blockhash = Hash::default();
        let bundle = client.build_bundle(vec![swap_ix], 10000, &payer, blockhash);

        assert_eq!(bundle.len(), 1);
        // Should have 2 instructions: swap + tip
        assert_eq!(bundle[0].message.instructions.len(), 2);
    }
}
