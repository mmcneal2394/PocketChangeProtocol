//! DexScreener token discovery — finds momentum candidates from new pairs and boosted tokens.

use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, warn};
use serde::Deserialize;

use super::{SniperConfig, velocity::VelocityTracker, scorer::{AdaptiveScorer, ScoreResult}, positions::PositionManager};

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct TokenCandidate {
    pub mint: String,
    pub symbol: String,
    pub volume_1h: f64,
    pub price_change_1h: f64,
    pub price_change_5m: Option<f64>,
    pub price_change_1m: Option<f64>,
    pub buys_1h: u64,
    pub sells_1h: u64,
    pub buy_ratio: f64,
    pub liquidity: f64,
    pub mcap: f64,
    pub token_age_sec: Option<u64>,
    pub pair_created_at: Option<u64>,
    pub source: String,
}

#[derive(Deserialize)]
struct DexPairsResponse {
    pairs: Option<Vec<DexPair>>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct DexPair {
    #[serde(rename = "chainId")]
    chain_id: Option<String>,
    #[serde(rename = "baseToken")]
    base_token: Option<DexToken>,
    #[serde(rename = "quoteToken")]
    quote_token: Option<DexToken>,
    volume: Option<DexVolume>,
    #[serde(rename = "priceChange")]
    price_change: Option<DexPriceChange>,
    txns: Option<DexTxns>,
    liquidity: Option<DexLiquidity>,
    #[serde(rename = "marketCap")]
    market_cap: Option<f64>,
    #[serde(rename = "pairCreatedAt")]
    pair_created_at: Option<u64>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct DexToken {
    address: Option<String>,
    symbol: Option<String>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct DexVolume {
    h1: Option<f64>,
    h24: Option<f64>,
}

#[derive(Deserialize)]
struct DexPriceChange {
    h1: Option<f64>,
    m5: Option<f64>,
    m1: Option<f64>,
}

#[derive(Deserialize)]
struct DexTxns {
    h1: Option<DexTxnCounts>,
}

#[derive(Deserialize)]
struct DexTxnCounts {
    buys: Option<u64>,
    sells: Option<u64>,
}

#[derive(Deserialize)]
struct DexLiquidity {
    usd: Option<f64>,
}

#[derive(Deserialize)]
struct BoostToken {
    #[serde(rename = "chainId")]
    chain_id: Option<String>,
    #[serde(rename = "tokenAddress")]
    token_address: Option<String>,
}

const MIN_LIQ: f64 = 1_000.0;
const MAX_LIQ: f64 = 500_000.0;
const MIN_BUYS: u64 = 8;
const MIN_BUY_RATIO: f64 = 1.2;

pub async fn poll_loop(
    config: SniperConfig,
    http: reqwest::Client,
    velocity: Arc<RwLock<VelocityTracker>>,
    scorer: Arc<RwLock<AdaptiveScorer>>,
    positions: Arc<RwLock<PositionManager>>,
) {
    info!("[DISCOVERY] Starting DexScreener poll (every {}s)", config.poll_interval_secs);
    loop {
        match fetch_candidates(&http).await {
            Ok(candidates) => {
                info!("[DISCOVERY] {} candidates from DexScreener", candidates.len());

                // Phase 1: Find best candidate (read-only locks)
                let best = {
                    let pos = positions.read().await;
                    let vel = velocity.read().await;
                    let s = scorer.read().await;
                    let mut result: Option<(TokenCandidate, ScoreResult)> = None;

                    for c in &candidates {
                        if pos.is_full() { break; }
                        if pos.has_position(&c.mint) { continue; }
                        if pos.is_blacklisted(&c.mint) { continue; }

                        if c.volume_1h < config.min_volume_1h { continue; }
                        if c.price_change_1h < config.min_price_change_1h { continue; }
                        if c.buy_ratio < config.min_buy_ratio { continue; }
                        if c.buys_1h < config.min_buys_1h { continue; }

                        if let Some(m5) = c.price_change_5m {
                            if m5 < 2.0 {
                                if let Some(m1) = c.price_change_1m {
                                    if m1 < 3.0 { continue; }
                                } else if !vel.is_accelerating(&c.mint) {
                                    continue;
                                }
                            }
                        }

                        let score = s.score_candidate(c);
                        if !score.should_enter { continue; }

                        info!("[DISCOVERY] Candidate: {} | +{:.0}%/1h | ${:.0}k vol | {}B/{}S ({:.1}x) | score:{:.0}%",
                            c.symbol, c.price_change_1h, c.volume_1h / 1000.0,
                            c.buys_1h, c.sells_1h, c.buy_ratio, score.score * 100.0);

                        result = Some((c.clone(), score));
                        break;
                    }
                    result
                }; // all read locks dropped here

                // Phase 2: Enter position (write lock)
                if let Some((candidate, score)) = best {
                    let mut pos_write = positions.write().await;
                    pos_write.try_enter(&config, &http, &candidate, &score).await;
                }
            }
            Err(e) => {
                warn!("[DISCOVERY] DexScreener fetch error: {}", e);
            }
        }

        tokio::time::sleep(std::time::Duration::from_secs(config.poll_interval_secs)).await;
    }
}

async fn fetch_candidates(http: &reqwest::Client) -> anyhow::Result<Vec<TokenCandidate>> {
    let mut candidates = Vec::new();
    let mut sol_mints: Vec<String> = Vec::new();

    // Source 1: DexScreener latest token profiles (all new tokens across chains)
    match http.get("https://api.dexscreener.com/token-profiles/latest/v1")
        .header("Accept", "application/json")
        .send().await
    {
        Ok(resp) => {
            if let Ok(profiles) = resp.json::<Vec<BoostToken>>().await {
                let mints: Vec<String> = profiles.iter()
                    .filter(|p| p.chain_id.as_deref() == Some("solana"))
                    .filter_map(|p| p.token_address.clone())
                    .collect();
                info!("[DISCOVERY] Profiles: {} Solana tokens", mints.len());
                sol_mints.extend(mints);
            }
        }
        Err(e) => warn!("[DISCOVERY] Profiles fetch error: {}", e),
    }

    // Source 2: DexScreener boosted tokens
    match http.get("https://api.dexscreener.com/token-boosts/latest/v1")
        .header("Accept", "application/json")
        .send().await
    {
        Ok(resp) => {
            if let Ok(boosts) = resp.json::<Vec<BoostToken>>().await {
                let mints: Vec<String> = boosts.iter()
                    .filter(|b| b.chain_id.as_deref() == Some("solana"))
                    .filter_map(|b| b.token_address.clone())
                    .collect();
                info!("[DISCOVERY] Boosted: {} Solana mints", mints.len());
                sol_mints.extend(mints);
            }
        }
        Err(_) => {}
    }

    // Source 3: DexScreener search queries (catches trending memecoins by keyword)
    for query in &["pump", "solana", "meme", "pepe"] {
        let url = format!("https://api.dexscreener.com/latest/dex/search?q={}", query);
        match http.get(&url).header("Accept", "application/json").send().await {
            Ok(r) => {
                if let Ok(data) = r.json::<DexPairsResponse>().await {
                    if let Some(pairs) = data.pairs {
                        for pair in &pairs {
                            if pair.chain_id.as_deref() != Some("solana") { continue; }
                            if let Some(base) = &pair.base_token {
                                if let Some(addr) = &base.address {
                                    sol_mints.push(addr.clone());
                                }
                            }
                        }
                    }
                }
            }
            Err(_) => {}
        }
    }

    // Deduplicate mints
    sol_mints.sort();
    sol_mints.dedup();
    info!("[DISCOVERY] Total unique Solana mints to resolve: {}", sol_mints.len());

    // Batch resolve mints to pairs (DexScreener supports up to 30 per request)
    for chunk in sol_mints.chunks(30) {
        let joined = chunk.join(",");
        let url = format!("https://api.dexscreener.com/latest/dex/tokens/{}", joined);
        match http.get(&url).header("Accept", "application/json").send().await {
            Ok(r) => {
                if let Ok(data) = r.json::<DexPairsResponse>().await {
                    if let Some(pairs) = data.pairs {
                        for pair in pairs {
                            if let Some(c) = parse_pair(&pair, "DexScreener") {
                                if !candidates.iter().any(|x: &TokenCandidate| x.mint == c.mint) {
                                    candidates.push(c);
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => warn!("[DISCOVERY] Token resolve error: {}", e),
        }
    }

    info!("[DISCOVERY] Final: {} qualifying candidates", candidates.len());
    Ok(candidates)
}

fn parse_pair(pair: &DexPair, source: &str) -> Option<TokenCandidate> {
    if pair.chain_id.as_deref() != Some("solana") { return None; }

    let base = pair.base_token.as_ref()?;
    let mint = base.address.as_ref()?.clone();
    let symbol = base.symbol.as_ref()?.clone();

    let vol_1h = pair.volume.as_ref()?.h1.unwrap_or(0.0);
    let liq = pair.liquidity.as_ref().and_then(|l| l.usd).unwrap_or(0.0);
    if liq < MIN_LIQ || liq > MAX_LIQ { return None; }

    let pc = pair.price_change.as_ref()?;
    let pc_1h = pc.h1.unwrap_or(0.0);

    let txns = pair.txns.as_ref()?.h1.as_ref()?;
    let buys = txns.buys.unwrap_or(0);
    let sells = txns.sells.unwrap_or(1);
    if buys < MIN_BUYS { return None; }

    let buy_ratio = buys as f64 / sells.max(1) as f64;
    if buy_ratio < MIN_BUY_RATIO { return None; }

    let mcap = pair.market_cap.unwrap_or(0.0);
    let created_at = pair.pair_created_at;
    let age_sec = created_at.map(|ca| {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        (now_ms.saturating_sub(ca)) / 1000
    });

    Some(TokenCandidate {
        mint,
        symbol,
        volume_1h: vol_1h,
        price_change_1h: pc_1h,
        price_change_5m: pc.m5,
        price_change_1m: pc.m1,
        buys_1h: buys,
        sells_1h: sells,
        buy_ratio,
        liquidity: liq,
        mcap,
        token_age_sec: age_sec,
        pair_created_at: created_at,
        source: source.to_string(),
    })
}
