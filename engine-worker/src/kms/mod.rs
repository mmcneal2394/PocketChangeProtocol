use aes_gcm::{
    aead::{Aead, KeyInit, generic_array::GenericArray},
    Aes256Gcm, Nonce
};
use std::env;

/// Simulates communication with our Hardware Security Module (HSM) / Key Management System.
/// The Next.js frontend encrypts the user's base58 string using an RSA public key.
/// Here, the Worker uses AES-256 (Master Cluster Key config) to decrypt it into memory for
/// a fraction of a second during trade execution.

pub struct TenantWallet {
    pub tenant_id: String,
    pub wallet_id: String,
    pub decrypted_keypair: String,  // Simulated for now; should return Keypair
}

pub struct KMSClient {
    master_key: Aes256Gcm,
}

impl KMSClient {
    pub fn new() -> Self {
        let key_str = env::var("KMS_MASTER_KEY").unwrap_or_else(|_| "00000000000000000000000000000000".to_string());
        let key = GenericArray::from_slice(key_str.as_bytes());
        let cipher = Aes256Gcm::new(key);
        
        KMSClient { master_key: cipher }
    }

    pub fn decrypt_tenant_key(&self, encrypted_hex: &str, nonce_hex: &str) -> Result<String, Box<dyn std::error::Error>> {
        let nonce = Nonce::from_slice(nonce_hex.as_bytes());
        let cipher_text = hex::decode(encrypted_hex)?;
        
        // Decrypt the payload back into the user's base58 private key string
        let plaintext = self.master_key.decrypt(nonce, cipher_text.as_ref())
            .map_err(|_| "KMS Decryption failed: Invalid ciphertext or MAC")?;

        println!("🔒 [KMS] Successfully unlocked Tenant AES Key Vault.");
        Ok(String::from_utf8(plaintext)?)
    }
}
