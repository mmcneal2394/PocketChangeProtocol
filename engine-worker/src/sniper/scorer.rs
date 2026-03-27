//! Adaptive scorer — learns from trade outcomes using Bayesian bucket scoring.
//! Port of adaptive_scorer.ts to Rust.

use std::collections::HashMap;
use serde::{Serialize, Deserialize};
use super::discovery::TokenCandidate;

const MIN_TRADES_TO_SCORE: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BucketStats {
    wins: u32,
    total: u32,
}

impl BucketStats {
    fn win_rate(&self) -> f64 {
        if self.total == 0 { 0.5 } else { self.wins as f64 / self.total as f64 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FeatureDef {
    name: String,
    low_boundary: f64,
    high_boundary: f64,
    default_weight: f64,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ScoreResult {
    pub score: f64,
    pub confidence: String,
    pub reasons: Vec<String>,
    pub should_enter: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TradeRecord {
    mint: String,
    symbol: String,
    features: HashMap<String, f64>,
    pnl_pct: f64,
    won: bool,
    hold_ms: u64,
    reason: String,
    ts: u64,
}

#[derive(Serialize, Deserialize)]
pub struct AdaptiveScorer {
    features: Vec<FeatureDef>,
    bucket_stats: HashMap<String, [BucketStats; 3]>, // [low, mid, high]
    feature_weights: HashMap<String, f64>,
    trades: Vec<TradeRecord>,
    win_rate: f64,
    threshold: f64,
}

impl AdaptiveScorer {
    pub fn new() -> Self {
        let features = vec![
            FeatureDef { name: "volume_1h".into(),       low_boundary: 50000.0, high_boundary: 200000.0, default_weight: 1.0 },
            FeatureDef { name: "price_change_1h".into(), low_boundary: 10.0,    high_boundary: 50.0,     default_weight: 1.0 },
            FeatureDef { name: "momentum_5m".into(),     low_boundary: 2.0,     high_boundary: 10.0,     default_weight: 1.5 },
            FeatureDef { name: "buy_ratio".into(),       low_boundary: 3.0,     high_boundary: 6.0,      default_weight: 1.2 },
            FeatureDef { name: "buys_1h".into(),         low_boundary: 100.0,   high_boundary: 500.0,    default_weight: 0.8 },
            FeatureDef { name: "liquidity".into(),       low_boundary: 10000.0, high_boundary: 50000.0,  default_weight: 0.8 },
            FeatureDef { name: "mcap".into(),            low_boundary: 20000.0, high_boundary: 100000.0, default_weight: 0.6 },
            FeatureDef { name: "token_age_sec".into(),   low_boundary: 600.0,   high_boundary: 3600.0,   default_weight: 1.0 },
        ];

        let mut bucket_stats = HashMap::new();
        let mut feature_weights = HashMap::new();
        for f in &features {
            bucket_stats.insert(f.name.clone(), [
                BucketStats { wins: 0, total: 0 },
                BucketStats { wins: 0, total: 0 },
                BucketStats { wins: 0, total: 0 },
            ]);
            feature_weights.insert(f.name.clone(), f.default_weight);
        }

        Self {
            features,
            bucket_stats,
            feature_weights,
            trades: Vec::new(),
            win_rate: 0.5,
            threshold: 0.35,
        }
    }

    fn get_bucket(&self, feature: &str, value: f64) -> usize {
        let def = self.features.iter().find(|f| f.name == feature);
        match def {
            Some(d) => {
                if value < d.low_boundary { 0 }      // low
                else if value > d.high_boundary { 2 } // high
                else { 1 }                            // mid
            }
            None => 1,
        }
    }

    fn extract_features(&self, candidate: &TokenCandidate) -> HashMap<String, f64> {
        let mut features = HashMap::new();
        features.insert("volume_1h".into(), candidate.volume_1h);
        features.insert("price_change_1h".into(), candidate.price_change_1h);
        features.insert("momentum_5m".into(), candidate.price_change_5m.unwrap_or(0.0));
        features.insert("buy_ratio".into(), candidate.buy_ratio);
        features.insert("buys_1h".into(), candidate.buys_1h as f64);
        features.insert("liquidity".into(), candidate.liquidity);
        features.insert("mcap".into(), candidate.mcap);
        features.insert("token_age_sec".into(), candidate.token_age_sec.unwrap_or(9999) as f64);
        features
    }

    pub fn score_candidate(&self, candidate: &TokenCandidate) -> ScoreResult {
        if self.trades.len() < MIN_TRADES_TO_SCORE {
            return ScoreResult {
                score: 0.5,
                confidence: "NO_DATA".into(),
                reasons: vec![format!("{}/{} trades — learning", self.trades.len(), MIN_TRADES_TO_SCORE)],
                should_enter: true,
            };
        }

        let features = self.extract_features(candidate);
        let mut total_weight = 0.0;
        let mut weighted_score = 0.0;
        let mut reasons = Vec::new();

        for feat in &self.features {
            let val = features.get(&feat.name).copied().unwrap_or(0.0);
            let bucket = self.get_bucket(&feat.name, val);
            let weight = self.feature_weights.get(&feat.name).copied().unwrap_or(feat.default_weight);

            if let Some(stats) = self.bucket_stats.get(&feat.name) {
                let wr = stats[bucket].win_rate();
                if stats[bucket].total > 0 {
                    weighted_score += wr * weight;
                } else {
                    weighted_score += self.win_rate * weight;
                }
                total_weight += weight;

                if stats[bucket].total >= 3 {
                    if wr >= 0.7 {
                        reasons.push(format!("{}={:.0} → {:.0}% win", feat.name, val, wr * 100.0));
                    } else if wr <= 0.3 {
                        reasons.push(format!("{}={:.0} → {:.0}% win !", feat.name, val, wr * 100.0));
                    }
                }
            }
        }

        let score = if total_weight > 0.0 { weighted_score / total_weight } else { 0.5 };
        let should_enter = score >= self.threshold;
        let confidence = if score >= 0.6 { "HIGH" } else if score >= 0.4 { "MED" } else { "LOW" };

        ScoreResult {
            score,
            confidence: confidence.into(),
            reasons,
            should_enter,
        }
    }

    #[allow(dead_code)]
    pub fn record_outcome(
        &mut self,
        candidate: &TokenCandidate,
        pnl_pct: f64,
        hold_ms: u64,
        reason: &str,
    ) {
        let won = pnl_pct >= 0.0;
        let features = self.extract_features(candidate);

        self.trades.push(TradeRecord {
            mint: candidate.mint.clone(),
            symbol: candidate.symbol.clone(),
            features: features.clone(),
            pnl_pct,
            won,
            hold_ms,
            reason: reason.into(),
            ts: now_ms(),
        });

        // Update bucket stats
        for feat in &self.features {
            let val = features.get(&feat.name).copied().unwrap_or(0.0);
            let bucket = self.get_bucket(&feat.name, val);
            if let Some(stats) = self.bucket_stats.get_mut(&feat.name) {
                stats[bucket].total += 1;
                if won { stats[bucket].wins += 1; }
            }
        }

        // Update feature weights based on discriminating power
        for feat in &self.features {
            if let Some(stats) = self.bucket_stats.get(&feat.name) {
                let rates: Vec<f64> = stats.iter().map(|s| {
                    if s.total >= 2 { s.win_rate() } else { 0.5 }
                }).collect();
                let mean = rates.iter().sum::<f64>() / rates.len() as f64;
                let variance = rates.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / rates.len() as f64;
                self.feature_weights.insert(feat.name.clone(), feat.default_weight + variance * 5.0);
            }
        }

        // Update win rate
        let wins = self.trades.iter().filter(|t| t.won).count();
        self.win_rate = if self.trades.is_empty() { 0.5 } else { wins as f64 / self.trades.len() as f64 };

        // Adaptive threshold
        if self.trades.len() >= MIN_TRADES_TO_SCORE {
            if self.win_rate < 0.35 {
                self.threshold = (self.threshold + 0.02).min(0.65);
            } else if self.win_rate > 0.55 {
                self.threshold = (self.threshold - 0.01).max(0.25);
            }
        }

        tracing::info!(
            "[SCORER] Trade #{}: {} {} {:.1}% | WR: {:.0}% ({}/{}L) | Threshold: {:.0}%",
            self.trades.len(), if won { "WIN" } else { "LOSS" }, candidate.symbol, pnl_pct,
            self.win_rate * 100.0, wins, self.trades.len() - wins, self.threshold * 100.0
        );
    }
}

#[allow(dead_code)]
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
