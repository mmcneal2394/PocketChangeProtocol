//! Velocity tracker — tracks per-mint swap activity from Geyser pool updates.
//! Unlike the TS version (WebSocket logsSubscribe), this receives decoded pool
//! state directly from the Geyser monitor — no RPC calls needed to resolve mints.

use std::collections::HashMap;
use crate::pool_monitor::decode::PoolUpdate;

const WINDOW_SECS: u64 = 60;
const MIN_EVENTS: usize = 3;
const STALE_SECS: u64 = 120;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct MintVelocity {
    pub buys_60s: u32,
    pub sells_60s: u32,
    pub buy_ratio: f64,
    pub velocity: f64,      // events/min
    pub is_accelerating: bool,
    pub sol_volume_60s: f64,
    pub last_seen: u64,
    pub first_seen: u64,
}

struct MintEvent {
    ts: u64,
    is_buy: bool,
    sol_amount: f64,
}

pub struct VelocityTracker {
    events: HashMap<String, Vec<MintEvent>>,   // mint → events
    first_seen: HashMap<String, u64>,
    prev_velocity: HashMap<String, f64>,
    prev_reserves: HashMap<String, (u64, u64)>, // pool_addr → (reserve_a, reserve_b)
}

impl VelocityTracker {
    pub fn new() -> Self {
        Self {
            events: HashMap::new(),
            first_seen: HashMap::new(),
            prev_velocity: HashMap::new(),
            prev_reserves: HashMap::new(),
        }
    }

    /// Process a pool update from Geyser — infer buy/sell from reserve changes
    pub fn record_pool_update(&mut self, update: &PoolUpdate) {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        // Determine token mint (non-SOL side)
        let sol_mint = "So11111111111111111111111111111111111111112";
        let token_mint = if update.tb == sol_mint {
            &update.ta
        } else if update.ta == sol_mint {
            &update.tb
        } else {
            return; // skip non-SOL pairs for velocity
        };

        // Infer buy/sell from reserve changes
        let prev = self.prev_reserves.get(&update.p).copied();
        self.prev_reserves.insert(update.p.clone(), (update.ra, update.rb));

        if let Some((prev_ra, prev_rb)) = prev {
            // If token reserves decreased and SOL reserves increased → someone bought the token
            let is_buy = if update.tb == sol_mint {
                // ta = token, tb = SOL. Buy = token reserves go down, SOL goes up
                update.ra < prev_ra && update.rb > prev_rb
            } else {
                // ta = SOL, tb = token. Buy = token reserves go down, SOL goes up
                update.rb < prev_rb && update.ra > prev_ra
            };

            let sol_delta = if update.tb == sol_mint {
                (update.rb as f64 - prev_rb as f64).abs() / 1e9
            } else {
                (update.ra as f64 - prev_ra as f64).abs() / 1e9
            };

            // Only record if there was a meaningful change (>0.0001 SOL)
            if sol_delta > 0.0001 {
                if !self.events.contains_key(token_mint) {
                    self.events.insert(token_mint.to_string(), Vec::new());
                    self.first_seen.insert(token_mint.to_string(), now_ms);
                }
                self.events.get_mut(token_mint).unwrap().push(MintEvent {
                    ts: now_ms,
                    is_buy,
                    sol_amount: sol_delta,
                });
            }
        }
    }

    /// Get velocity data for a specific mint
    pub fn get_mint_velocity(&self, mint: &str) -> Option<MintVelocity> {
        let events = self.events.get(mint)?;
        let now = now_ms();
        let cutoff = now.saturating_sub(WINDOW_SECS * 1000);
        let recent: Vec<&MintEvent> = events.iter().filter(|e| e.ts >= cutoff).collect();

        if recent.len() < MIN_EVENTS { return None; }

        let buys: u32 = recent.iter().filter(|e| e.is_buy).count() as u32;
        let total = recent.len() as u32;
        let sells = total - buys;
        let buy_ratio = if total > 0 { buys as f64 / total as f64 } else { 0.0 };
        let sol_vol: f64 = recent.iter().map(|e| e.sol_amount).sum();

        let first = self.first_seen.get(mint).copied().unwrap_or(now);
        let window = ((now - first).min(WINDOW_SECS * 1000) as f64) / 1000.0;
        let velocity = if window > 0.0 { (total as f64 / window) * 60.0 } else { 0.0 };

        let prev_vel = self.prev_velocity.get(mint).copied().unwrap_or(0.0);
        let is_accelerating = velocity > prev_vel * 1.2;

        Some(MintVelocity {
            buys_60s: buys,
            sells_60s: sells,
            buy_ratio,
            velocity,
            is_accelerating,
            sol_volume_60s: sol_vol,
            last_seen: recent.last().map(|e| e.ts).unwrap_or(now),
            first_seen: first,
        })
    }

    /// Check if a mint is currently accelerating
    pub fn is_accelerating(&self, mint: &str) -> bool {
        self.get_mint_velocity(mint)
            .map(|v| v.is_accelerating && v.buys_60s >= 5 && v.buy_ratio >= 0.60)
            .unwrap_or(false)
    }

    /// Periodic cleanup — call every few seconds
    pub fn cleanup(&mut self) {
        let now = now_ms();
        let cutoff = now.saturating_sub(STALE_SECS * 1000);
        let window_cutoff = now.saturating_sub(WINDOW_SECS * 1000);

        // Collect mints to remove first (can't modify sibling fields inside retain closure)
        let mut to_remove: Vec<String> = Vec::new();

        self.events.retain(|mint, events| {
            events.retain(|e| e.ts >= window_cutoff);
            if events.is_empty() {
                to_remove.push(mint.clone());
                false
            } else {
                let last = events.last().map(|e| e.ts).unwrap_or(0);
                if last < cutoff {
                    to_remove.push(mint.clone());
                    false
                } else {
                    true
                }
            }
        });

        for mint in &to_remove {
            self.first_seen.remove(mint);
            self.prev_velocity.remove(mint);
        }
    }

    /// Update prev_velocity for acceleration detection (call periodically)
    pub fn snapshot_velocities(&mut self) {
        for (mint, _) in &self.events {
            if let Some(vel) = self.get_mint_velocity(mint) {
                self.prev_velocity.insert(mint.clone(), vel.velocity);
            }
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
