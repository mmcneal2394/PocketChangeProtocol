pub mod jupiter;
pub mod cex;

use std::collections::HashMap;
use std::time::{Duration, Instant};
use crate::types::PriceSnapshot;

pub struct PriceEntry {
    pub price_usdc: f64,
    pub source: String,
    pub updated_at: Instant,
}

pub struct PriceCache {
    prices: HashMap<String, PriceEntry>,
}

impl PriceCache {
    pub fn new() -> Self {
        Self { prices: HashMap::new() }
    }

    pub fn update(&mut self, snapshot: &PriceSnapshot) {
        // Store under plain mint key (backward compat for Jupiter / general lookups)
        self.prices.insert(snapshot.mint.clone(), PriceEntry {
            price_usdc: snapshot.price_usdc,
            source: snapshot.source.clone(),
            updated_at: snapshot.timestamp,
        });
        // Also store under "mint:source" composite key for multi-exchange queries
        let composite = format!("{}:{}", snapshot.mint, snapshot.source);
        self.prices.insert(composite, PriceEntry {
            price_usdc: snapshot.price_usdc,
            source: snapshot.source.clone(),
            updated_at: snapshot.timestamp,
        });
    }

    pub fn get(&self, mint: &str) -> Option<&PriceEntry> {
        self.prices.get(mint)
    }

    /// Get a price entry for a specific mint from a specific source (e.g. "SOL", "mexc").
    pub fn get_by_source(&self, mint: &str, source: &str) -> Option<&PriceEntry> {
        let key = format!("{}:{}", mint, source);
        self.prices.get(&key)
    }

    /// Return all CEX prices for a given mint across configured exchanges.
    pub fn get_cex_prices(&self, mint: &str) -> Vec<(&str, f64)> {
        const CEX_SOURCES: &[&str] = &["mexc", "gate", "kucoin"];
        let mut results = Vec::new();
        for &src in CEX_SOURCES {
            let key = format!("{}:{}", mint, src);
            if let Some(entry) = self.prices.get(&key) {
                results.push((src, entry.price_usdc));
            }
        }
        results
    }

    pub fn is_fresh(&self, mint: &str, max_age: Duration) -> bool {
        self.prices.get(mint)
            .map(|e| e.updated_at.elapsed() < max_age)
            .unwrap_or(false)
    }

    pub fn get_price(&self, mint: &str) -> Option<f64> {
        self.prices.get(mint).map(|e| e.price_usdc)
    }

    /// Remove entries from a given source that are older than `max_age`.
    pub fn mark_stale(&mut self, source: &str, max_age: Duration) {
        self.prices.retain(|_, entry| {
            !(entry.source == source && entry.updated_at.elapsed() > max_age)
        });
    }
}
