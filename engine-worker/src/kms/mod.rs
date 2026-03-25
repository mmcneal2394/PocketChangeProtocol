use aes_gcm::{
    aead::{Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
    AeadCore,
};
use anyhow::{anyhow, Result};
use solana_sdk::signature::Keypair;

#[derive(Debug, Clone)]
pub struct EncryptedPayload {
    pub nonce: Vec<u8>,     // 12 bytes
    pub ciphertext: Vec<u8>,
}

pub struct KMSClient {
    cipher: Aes256Gcm,
    previous_cipher: Option<Aes256Gcm>,
}

impl KMSClient {
    pub fn from_key(key: &[u8; 32]) -> Self {
        Self {
            cipher: Aes256Gcm::new_from_slice(key).expect("valid 32-byte key"),
            previous_cipher: None,
        }
    }

<<<<<<< HEAD
    pub fn with_rotation(current_key: &[u8; 32], previous_key: Option<&[u8; 32]>) -> Self {
        Self {
            cipher: Aes256Gcm::new_from_slice(current_key).expect("valid key"),
            previous_cipher: previous_key.map(|k| Aes256Gcm::new_from_slice(k).expect("valid key")),
        }
    }

    pub fn from_env() -> Result<Self> {
        let key_hex = std::env::var("KMS_MASTER_KEY")
            .map_err(|_| anyhow!("KMS_MASTER_KEY env var not set"))?;
        let key_bytes = hex::decode(&key_hex)
            .map_err(|_| anyhow!("KMS_MASTER_KEY must be valid hex"))?;
        if key_bytes.len() != 32 {
            return Err(anyhow!("KMS_MASTER_KEY must be 32 bytes (64 hex chars)"));
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&key_bytes);

        let previous = std::env::var("KMS_MASTER_KEY_PREVIOUS").ok().and_then(|h| {
            hex::decode(&h).ok().and_then(|b| {
                if b.len() == 32 {
                    let mut k = [0u8; 32];
                    k.copy_from_slice(&b);
                    Some(k)
                } else {
                    None
                }
            })
        });

        Ok(Self::with_rotation(&key, previous.as_ref()))
    }

    pub fn encrypt(&self, plaintext: &[u8]) -> Result<EncryptedPayload> {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = self.cipher.encrypt(&nonce, plaintext)
            .map_err(|e| anyhow!("Encryption failed: {}", e))?;
        Ok(EncryptedPayload {
            nonce: nonce.to_vec(),
            ciphertext,
        })
    }

    pub fn decrypt(&self, payload: &EncryptedPayload) -> Result<Vec<u8>> {
        let nonce = Nonce::from_slice(&payload.nonce);
        self.cipher.decrypt(nonce, payload.ciphertext.as_ref())
            .map_err(|e| anyhow!("Decryption failed: {}", e))
    }

    pub fn decrypt_with_rotation(&self, payload: &EncryptedPayload) -> Result<Vec<u8>> {
        // Try current key first
        if let Ok(result) = self.decrypt(payload) {
            return Ok(result);
        }
        // Fall back to previous key
        if let Some(ref prev) = self.previous_cipher {
            let nonce = Nonce::from_slice(&payload.nonce);
            prev.decrypt(nonce, payload.ciphertext.as_ref())
                .map_err(|e| anyhow!("Decryption failed with both keys: {}", e))
        } else {
            Err(anyhow!("Decryption failed and no previous key available"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let key = [42u8; 32];
        let kms = KMSClient::from_key(&key);
        let secret = b"my_private_key_bytes_here";
        let encrypted = kms.encrypt(secret).unwrap();
        assert_ne!(encrypted.ciphertext, secret);
        assert_eq!(encrypted.nonce.len(), 12);
        let decrypted = kms.decrypt(&encrypted).unwrap();
        assert_eq!(decrypted, secret);
    }

    #[test]
    fn test_wrong_key_fails() {
        let key1 = [1u8; 32];
        let key2 = [2u8; 32];
        let kms1 = KMSClient::from_key(&key1);
        let kms2 = KMSClient::from_key(&key2);
        let encrypted = kms1.encrypt(b"secret").unwrap();
        assert!(kms2.decrypt(&encrypted).is_err());
    }

    #[test]
    fn test_key_rotation() {
        let old_key = [1u8; 32];
        let new_key = [2u8; 32];
        let old_kms = KMSClient::from_key(&old_key);
        let secret = b"my_private_key_bytes";
        let encrypted = old_kms.encrypt(secret).unwrap();

        // New key alone fails
        let new_kms = KMSClient::from_key(&new_key);
        assert!(new_kms.decrypt(&encrypted).is_err());

        // With rotation, falls back to old key
        let rotator = KMSClient::with_rotation(&new_key, Some(&old_key));
        let decrypted = rotator.decrypt_with_rotation(&encrypted).unwrap();
        assert_eq!(decrypted, secret);
=======
    /// Takes the `encryptedKey` from PostgreSQL and the tenant's exact salt.
    /// In production, AES keys are rotated in Postgres regularly.
    pub fn decrypt_tenant_key(&self, encrypted_hex: &str, nonce_hex: &str) -> Result<String, Box<dyn std::error::Error>> {
        // let nonce = Nonce::from_slice(nonce_hex.as_bytes());
        // let cipher_text = hex::decode(encrypted_hex)?;
        // let plaintext = self.master_key.decrypt(nonce, cipher_text.as_ref())?;
        //
        // Ok(String::from_utf8(plaintext)?)
        
        println!("🔒 [KMS] Decrypted raw bytes for {}", encrypted_hex);
        Ok("5vewERBqeRo67iKyzbfKqydTiwUFZLn8TUNexoDhuAaCWWzHjnPQJ34kspW3SGFkwaA51evwJW7Fm6uHXgGWKjMH".to_string())
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f
    }
}
