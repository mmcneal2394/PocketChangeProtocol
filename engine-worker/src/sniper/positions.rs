//! Position management — tracks open positions, trailing stops, and exit logic.

use std::collections::{HashMap, HashSet};
use tracing::{info, warn};
use super::{SniperConfig, discovery::TokenCandidate, scorer::ScoreResult, executor};
use crate::pool_monitor::decode::PoolUpdate;

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct Position {
    pub mint: String,
    pub symbol: String,
    pub buy_price_sol: f64,
    pub token_amount: u64,
    pub opened_at: u64,
    pub tp_pct: f64,
    pub sl_pct: f64,
    pub peak_pnl_pct: f64,
    pub peak_at: Option<u64>,
    pub entry_buy_ratio: f64,
    pub candidate: TokenCandidate, // full entry context for scorer
    // Cached current price from Geyser pool state
    pub cached_price_sol: Option<f64>,
    pub cached_price_at: u64,
}

pub struct PositionManager {
    pub positions: Vec<Position>,
    pub blacklist: HashSet<String>,
    pub stats: TradeStats,
    config: SniperConfig,
    // Pool price cache from Geyser
    pool_prices: HashMap<String, f64>, // mint → SOL price
}

#[derive(Debug, Clone, Default)]
pub struct TradeStats {
    pub wins: u32,
    pub losses: u32,
    pub total_pnl_sol: f64,
}

impl PositionManager {
    pub fn new(config: SniperConfig) -> Self {
        Self {
            positions: Vec::new(),
            blacklist: HashSet::new(),
            stats: TradeStats::default(),
            config,
            pool_prices: HashMap::new(),
        }
    }

    pub fn is_full(&self) -> bool {
        self.positions.len() >= self.config.max_positions
    }

    pub fn has_position(&self, mint: &str) -> bool {
        self.positions.iter().any(|p| p.mint == mint)
    }

    pub fn is_blacklisted(&self, mint: &str) -> bool {
        self.blacklist.contains(mint)
    }

    /// Update cached price from Geyser pool update
    pub fn update_pool_price(&mut self, update: &PoolUpdate) {
        let sol_mint = "So11111111111111111111111111111111111111112";
        if update.tb == sol_mint {
            // ta is the token, price is SOL per token
            if update.px > 0.0 {
                self.pool_prices.insert(update.ta.clone(), update.px);
            }
        } else if update.ta == sol_mint {
            // tb is the token, price is inverse
            if update.px > 0.0 {
                self.pool_prices.insert(update.tb.clone(), 1.0 / update.px);
            }
        }

        // Update any open positions with this mint
        let now = now_ms();
        for pos in &mut self.positions {
            if let Some(&price) = self.pool_prices.get(&pos.mint) {
                pos.cached_price_sol = Some(price * pos.token_amount as f64);
                pos.cached_price_at = now;
            }
        }
    }

    /// Try to enter a position
    pub async fn try_enter(
        &mut self,
        config: &SniperConfig,
        http: &reqwest::Client,
        candidate: &TokenCandidate,
        _score: &ScoreResult,
    ) {
        let buy_sol = config.buy_size_sol;
        let buy_lamports = (buy_sol * 1e9) as u64;

        // Get Jupiter quote for entry
        let quote = match executor::get_jupiter_quote(
            http,
            &config.jupiter_api_key,
            "So11111111111111111111111111111111111111112",
            &candidate.mint,
            buy_lamports,
        ).await {
            Ok(q) => q,
            Err(e) => {
                warn!("[SNIPER] No quote for {} — {}", candidate.symbol, e);
                return;
            }
        };

        let token_amount: u64 = quote["outAmount"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .or_else(|| quote["outAmount"].as_u64())
            .unwrap_or(0);

        if token_amount == 0 {
            warn!("[SNIPER] Zero outAmount for {}", candidate.symbol);
            return;
        }

        // Execute swap (executor handles paper vs live mode internally)
        match executor::execute_swap(http, config, &quote).await {
            Ok(sig) => {
                info!("[SNIPER] {} buy tx: {}", if config.paper_mode { "PAPER" } else { "LIVE" }, sig);
            }
            Err(e) => {
                warn!("[SNIPER] Swap failed for {}: {}", candidate.symbol, e);
                return;
            }
        };

        // Calculate TP/SL targets
        let (tp, sl) = calc_exit_targets(candidate.price_change_1h);

        let pos = Position {
            mint: candidate.mint.clone(),
            symbol: candidate.symbol.clone(),
            buy_price_sol: buy_sol,
            token_amount,
            opened_at: now_ms(),
            tp_pct: tp,
            sl_pct: sl,
            peak_pnl_pct: 0.0,
            peak_at: None,
            entry_buy_ratio: candidate.buy_ratio,
            candidate: candidate.clone(),
            cached_price_sol: None,
            cached_price_at: 0,
        };
        self.positions.push(pos);

        info!("[SNIPER] Entered {}: {} SOL -> {} tokens | TP:+{:.0}% SL:-{:.0}%",
            candidate.symbol, buy_sol, token_amount, tp, sl);

        // Telegram alert
        executor::send_telegram(config,
            &format!("{} <b>BUY {}</b>\nSize: {} SOL\n1h: +{:.0}% | Vol: ${:.0}k\nBuys/Sells: {}/{} ({:.1}x)\nTP: +{:.0}% | SL: -{:.0}%",
                if config.paper_mode { "[PAPER]" } else { "[LIVE]" },
                candidate.symbol, buy_sol,
                candidate.price_change_1h, candidate.volume_1h / 1000.0,
                candidate.buys_1h, candidate.sells_1h, candidate.buy_ratio,
                tp, sl,
            )
        ).await;
    }
}

/// Dynamic TP/SL — wider targets, let winners run (Artemis-informed)
fn calc_exit_targets(price_change_1h: f64) -> (f64, f64) {
    if price_change_1h >= 80.0 { (20.0, 15.0) }
    else if price_change_1h >= 40.0 { (35.0, 15.0) }
    else { (50.0, 15.0) }
}

/// Exit monitor loop — checks positions every second for exits
pub async fn exit_monitor_loop(
    config: SniperConfig,
    http: reqwest::Client,
    positions: std::sync::Arc<tokio::sync::RwLock<PositionManager>>,
    _velocity: std::sync::Arc<tokio::sync::RwLock<super::velocity::VelocityTracker>>,
) {
    info!("[EXITS] Starting position exit monitor");
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(config.poll_interval_secs)).await;

        // Collect exit decisions without mutating stats (avoids borrow conflicts)
        struct ExitInfo {
            index: usize,
            pnl_sol: f64,
            pnl_pct: f64,
            peak: f64,
            reason: String,
            symbol: String,
            mint: String,
            held_ms: u64,
            is_sl: bool,
        }

        let mut pos_mgr = positions.write().await;
        let now = now_ms();
        let mut exit_infos: Vec<ExitInfo> = Vec::new();

        let min_hold_ms: u64 = 45_000; // 45s breathing room
        let catastrophic_sl: f64 = 25.0;

        for (i, pos) in pos_mgr.positions.iter_mut().enumerate() {
            let held_ms = now - pos.opened_at;
            let force_exit = held_ms > config.max_hold_secs * 1000;

            let cur_value_sol = if pos.cached_price_sol.is_some() && (now - pos.cached_price_at) < 10_000 {
                pos.cached_price_sol
            } else {
                match executor::get_jupiter_quote(
                    &http, &config.jupiter_api_key,
                    &pos.mint, "So11111111111111111111111111111111111111112",
                    pos.token_amount,
                ).await {
                    Ok(q) => {
                        let out: f64 = q["outAmount"]
                            .as_str().and_then(|s| s.parse().ok())
                            .unwrap_or(0.0) / 1e9;
                        if out > 0.0 { Some(out) } else { None }
                    }
                    Err(_) => None,
                }
            };

            if cur_value_sol.is_none() && !force_exit { continue; }

            let pnl_pct = cur_value_sol
                .map(|v| ((v - pos.buy_price_sol) / pos.buy_price_sol) * 100.0)
                .unwrap_or(-100.0);

            if pnl_pct > pos.peak_pnl_pct {
                pos.peak_pnl_pct = pnl_pct;
                pos.peak_at = Some(now);
            }

            let peak = pos.peak_pnl_pct;
            // Minimum hold: 45s breathing room (except catastrophic loss)
            if held_ms < min_hold_ms && !force_exit {
                if pnl_pct > -(catastrophic_sl) {
                    continue; // still breathing, skip exit check
                }
            }

            let active_sl = pos.sl_pct;
            let tp = pnl_pct >= pos.tp_pct;
            let sl = pnl_pct <= -active_sl;

            // Trail: wider distances, only activate at +20% (let winners run)
            let trail_pct = if peak >= 30.0 { peak * 0.12 }
                else if peak >= 20.0 { peak * 0.15 }
                else if peak >= 10.0 { peak * 0.20 }
                else { 999.0 }; // no trail below +10%
            let trail = peak >= 10.0 && pnl_pct <= (peak - trail_pct);

            if tp || sl || trail || force_exit {
                let reason = if tp { format!("TP +{:.1}%", pnl_pct) }
                    else if trail { format!("TRAIL peak:+{:.1}% pullback:{:.1}%", peak, pnl_pct) }
                    else if sl { format!("SL {:.1}%", pnl_pct) }
                    else { format!("TIMEOUT {:.1}min", held_ms as f64 / 60000.0) };

                let pnl_sol = cur_value_sol.unwrap_or(0.0) - pos.buy_price_sol;

                if config.paper_mode {
                    info!("[PAPER] Simulated sell: {} {}", pos.symbol, reason);
                } else {
                    let sell_quote = executor::get_jupiter_quote(
                        &http, &config.jupiter_api_key,
                        &pos.mint, "So11111111111111111111111111111111111111112",
                        pos.token_amount,
                    ).await;
                    if let Ok(q) = sell_quote {
                        let _ = executor::execute_swap(&http, &config, &q).await;
                    }
                }

                exit_infos.push(ExitInfo {
                    index: i, pnl_sol, pnl_pct, peak, reason,
                    symbol: pos.symbol.clone(), mint: pos.mint.clone(),
                    held_ms, is_sl: sl,
                });
            } else if held_ms % 20_000 < config.poll_interval_secs * 1000 {
                let trail_tag = if peak >= 2.0 {
                    format!(" | trail floor: +{:.1}% (peak:+{:.1}%)", peak - trail_pct, peak)
                } else { String::new() };
                info!("[SNIPER] {} | PnL: {}{:.1}% | held: {:.1}min | SL: -{:.0}%{}",
                    pos.symbol, if pnl_pct >= 0.0 { "+" } else { "" }, pnl_pct,
                    held_ms as f64 / 60000.0, active_sl, trail_tag);
            }
        }

        // Apply mutations after iteration ends (borrow checker safe)
        for exit in &exit_infos {
            let win = exit.pnl_sol >= 0.0;
            if win { pos_mgr.stats.wins += 1; } else { pos_mgr.stats.losses += 1; }
            pos_mgr.stats.total_pnl_sol += exit.pnl_sol;
            if exit.is_sl { pos_mgr.blacklist.insert(exit.mint.clone()); }

            info!("[SNIPER] {} {} | PnL: {}{:.4} SOL ({:.1}%) | {}",
                if win { "WIN" } else { "LOSS" }, exit.symbol,
                if exit.pnl_sol >= 0.0 { "+" } else { "" }, exit.pnl_sol, exit.pnl_pct, exit.reason);

            executor::send_telegram(&config,
                &format!("{} <b>SELL {}</b> {}\nPnL: {}{:.4} SOL ({:.1}%)\nPeak: +{:.1}% | Reason: {}\nHeld: {:.1}min\nSession: W{}/L{} | {}{:.4} SOL",
                    if config.paper_mode { "[PAPER]" } else { "[LIVE]" },
                    exit.symbol, if win { "+++" } else { "---" },
                    if exit.pnl_sol >= 0.0 { "+" } else { "" }, exit.pnl_sol, exit.pnl_pct,
                    exit.peak, exit.reason, exit.held_ms as f64 / 60000.0,
                    pos_mgr.stats.wins, pos_mgr.stats.losses,
                    if pos_mgr.stats.total_pnl_sol >= 0.0 { "+" } else { "" },
                    pos_mgr.stats.total_pnl_sol,
                )
            ).await;
        }

        // Remove exited positions (reverse order)
        for exit in exit_infos.iter().rev() {
            pos_mgr.positions.remove(exit.index);
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
