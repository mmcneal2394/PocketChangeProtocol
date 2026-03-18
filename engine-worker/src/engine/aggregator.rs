use async_trait::async_trait;
use serde_json::Value;
use solana_sdk::instruction::Instruction;
use std::sync::Arc;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AggregatorError {
    #[error("Network error: {0}")]
    Network(#[from] reqwest::Error),

    #[error("Provider '{provider}' error{}: {message}", .status.map(|s| format!(" (HTTP {s})")).unwrap_or_default())]
    Provider {
        provider: String,
        message: String,
        status: Option<u16>,
    },

    #[error("Missing valid instruction parameters in response: {0}")]
    InvalidResponse(String),

    #[error("No routes found across all providers")]
    AllExhausted,
}

impl AggregatorError {
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::Network(_) | Self::Provider { status: Some(429), .. } | Self::Provider { status: Some(500..=599), .. }
        )
    }
}

#[derive(Clone, Debug)]
pub struct Quote {
    pub input_mint: String,
    pub output_mint: String,
    pub in_amount: u64,
    pub out_amount: u64,
    pub provider_name: String,
    pub raw_response: Value,
}

#[async_trait]
pub trait DexProvider: Send + Sync + 'static {
    fn name(&self) -> &'static str;
    
    async fn get_quote(
        &self,
        input_mint: &str,
        output_mint: &str,
        amount: u64,
    ) -> Result<Quote, AggregatorError>;

    async fn get_instructions(
        &self,
        quote: &Quote,
        user_pubkey: &str,
    ) -> Result<Vec<Instruction>, AggregatorError>;
}

/// The Core Re-Act Meta-Aggregator Model
pub struct MetaAggregator {
    providers: Vec<Arc<dyn DexProvider>>,
}

impl MetaAggregator {
    pub fn new() -> Self {
        MetaAggregator {
            providers: Vec::new(), // Inject providers dynamically
        }
    }

    pub fn add_provider(&mut self, provider: Arc<dyn DexProvider>) {
        self.providers.push(provider);
    }

    /// Run through all registered providers sequentially or concurrently to find the highest yield route
    pub async fn solve_route(
        &self,
        input_mint: &str,
        output_mint: &str,
        amount: u64,
    ) -> Result<Quote, AggregatorError> {
        let mut best_quote: Option<Quote> = None;

        for provider in &self.providers {
            match provider.get_quote(input_mint, output_mint, amount).await {
                Ok(quote) => {
                    if let Some(ref best) = best_quote {
                        if quote.out_amount > best.out_amount {
                            best_quote = Some(quote);
                        }
                    } else {
                        best_quote = Some(quote);
                    }
                }
                Err(e) => {
                    println!("⚠️ [MetaAggr] {} failed to quote: {}", provider.name(), e);
                }
            }
        }

        best_quote.ok_or(AggregatorError::AllExhausted)
    }

    pub async fn fetch_instructions(
        &self,
        quote: &Quote,
        user_pubkey: &str,
    ) -> Result<Vec<Instruction>, AggregatorError> {
        for provider in &self.providers {
            if provider.name() == quote.provider_name {
                return provider.get_instructions(quote, user_pubkey).await;
            }
        }
        Err(AggregatorError::InvalidResponse(format!("Provider {} missing", quote.provider_name)))
    }
}
