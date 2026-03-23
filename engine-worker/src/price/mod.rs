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
        self.prices.insert(snapshot.mint.clone(), PriceEntry {
            price_usdc: snapshot.price_usdc,
            source: snapshot.source.clone(),
            updated_at: snapshot.timestamp,
        });
    }

    pub fn get(&self, mint: &str) -> Option<&PriceEntry> {
        self.prices.get(mint)
    }

    pub fn is_fresh(&self, mint: &str, max_age: Duration) -> bool {
        self.prices.get(mint)
            .map(|e| e.updated_at.elapsed() < max_age)
            .unwrap_or(false)
    }

    pub fn get_price(&self, mint: &str) -> Option<f64> {
        self.prices.get(mint).map(|e| e.price_usdc)
    }
}
