use solana_sdk::signature::{Keypair, Signer};
use std::fs;

fn main() {
    let data = fs::read_to_string("e:/PumpFunBundler/wallets.json").unwrap();
    let wallets: Vec<String> = serde_json::from_str(&data).unwrap();

    for key_base58 in wallets {
        let decoded = bs58::decode(&key_base58).into_vec().unwrap();
        let kp = Keypair::from_bytes(&decoded).unwrap();
        let pubkey = kp.pubkey().to_string();
        
        if pubkey.to_lowercase().starts_with("abpr") {
            println!("FOUND ABPR WALLET MATCH! Pubkey: {}", pubkey);
            println!("Private Key Base58: {}", key_base58);
        }
    }
    println!("Done checking pumpfun bundler wallets.");
}
