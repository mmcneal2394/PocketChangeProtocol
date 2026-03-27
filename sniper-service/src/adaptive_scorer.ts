/**
 * adaptive_scorer.ts — Self-learning trade scorer
 * ─────────────────────────────────────────────────────────────────────────────
 * Three learning modes:
 *   1. TRADE OUTCOMES — learns from every completed trade (win/loss)
 *   2. SHADOW TRACKING — tracks rejected candidates, checks price after 5min,
 *      learns from missed opportunities
 *   3. EXPLORATION — lowers threshold during quiet periods to generate data
 *
 * Persists to Postgres (primary) + Redis (cache) + file (backup).
 * Schema-versioned for safe upgrades.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import { loadTradesFromDB, saveTradetoDB, loadScorerState, saveScorerState } from './scorer_db';
import path from 'path';

const SIGNALS_DIR = path.join(process.cwd(), 'signals');
const MODEL_FILE  = path.join(SIGNALS_DIR, 'adaptive_model.json');
const MODEL_VERSION = 3; // bump on schema changes
const MIN_TRADES_TO_SCORE = 5;
const SHADOW_CHECK_MS = 5 * 60_000; // check shadow candidates after 5 min
const SHADOW_WIN_THRESHOLD = 10; // +10% = we missed a good trade
const SHADOW_LOSS_THRESHOLD = -10; // -10% = correct rejection
const EXPLORATION_IDLE_MS = 10 * 60_000; // if no trade in 10min, enter exploration mode

interface FeatureDef {
  name: string;
  buckets: [number, number];
  defaultWeight: number;
}

const FEATURES: FeatureDef[] = [
  { name: 'volume1h',        buckets: [5000, 50000],    defaultWeight: 0.8 },
  { name: 'priceChange1h',   buckets: [-20, 20],        defaultWeight: 0.5 },
  { name: 'momentum5m',      buckets: [0, 10],          defaultWeight: 1.2 },
  { name: 'buyRatio',        buckets: [1.5, 4],         defaultWeight: 1.5 },
  { name: 'buys1h',          buckets: [20, 200],        defaultWeight: 0.8 },
  { name: 'liquidity',       buckets: [5000, 30000],    defaultWeight: 0.8 },
  { name: 'mcap',            buckets: [10000, 100000],  defaultWeight: 0.8 },
  { name: 'tokenAgeSec',     buckets: [120, 600],       defaultWeight: 2.0 },
  { name: 'velocityScore',   buckets: [2, 8],           defaultWeight: 1.8 },
  { name: 'detectionSource', buckets: [0, 1],           defaultWeight: 1.5 },
];

export interface EntryMetrics {
  volume1h:        number;
  priceChange1h:   number;
  momentum5m:      number;
  buyRatio:        number;
  buys1h:          number;
  liquidity:       number;
  mcap:            number;
  tokenAgeSec:     number;
  velocityScore:   number;
  detectionSource: number;
  source:          string;
}

interface BucketStats {
  low:  { wins: number; total: number };
  mid:  { wins: number; total: number };
  high: { wins: number; total: number };
}

interface TradeRecord {
  mint: string; symbol: string; metrics: EntryMetrics;
  pnlPct: number; pnlSol: number; won: boolean;
  holdMs: number; reason: string; ts: number;
}

interface ShadowRecord {
  mint: string; symbol: string; metrics: EntryMetrics;
  score: number; rejectedAt: number; checked: boolean;
  pnlPctAfter5m: number | null; // filled after check
}

interface AdaptiveModel {
  version:        number;
  trades:         TradeRecord[];
  shadowTrades:   ShadowRecord[];
  bucketStats:    { [feature: string]: BucketStats };
  featureWeights: { [feature: string]: number };
  winRate:        number;
  avgWinPct:      number;
  avgLossPct:     number;
  threshold:      number;
  lastTradeAt:    number;
  updatedAt:      number;
}

// ── Model state ──────────────────────────────────────────────────────────────
let model: AdaptiveModel = createFreshModel();

function createFreshModel(): AdaptiveModel {
  const bucketStats: { [k: string]: BucketStats } = {};
  const featureWeights: { [k: string]: number } = {};
  for (const f of FEATURES) {
    bucketStats[f.name] = {
      low: { wins: 0, total: 0 }, mid: { wins: 0, total: 0 }, high: { wins: 0, total: 0 },
    };
    featureWeights[f.name] = f.defaultWeight;
  }
  return {
    version: MODEL_VERSION,
    trades: [],
    shadowTrades: [],
    bucketStats,
    featureWeights,
    winRate: 0.5,
    avgWinPct: 0,
    avgLossPct: 0,
    threshold: 0.35,
    lastTradeAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────
function loadModel() {
  try {
    if (fs.existsSync(MODEL_FILE)) {
      const raw = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf-8'));
      migrateAndMerge(raw);
    }
  } catch { /* start fresh */ }
}

function migrateAndMerge(raw: any) {
  const fresh = createFreshModel();
  // Keep trades and shadow trades regardless of version
  model = {
    ...fresh,
    trades: Array.isArray(raw.trades) ? raw.trades : [],
    shadowTrades: Array.isArray(raw.shadowTrades) ? raw.shadowTrades : [],
    winRate: typeof raw.winRate === 'number' ? raw.winRate : 0.5,
    avgWinPct: raw.avgWinPct || 0,
    avgLossPct: raw.avgLossPct || 0,
    threshold: typeof raw.threshold === 'number' ? raw.threshold : 0.35,
    lastTradeAt: raw.lastTradeAt || Date.now(),
    version: MODEL_VERSION,
  };
  // Merge bucket stats — keep existing data for known features, add new features
  for (const f of FEATURES) {
    if (raw.bucketStats?.[f.name]) {
      model.bucketStats[f.name] = raw.bucketStats[f.name];
    }
    if (raw.featureWeights?.[f.name] !== undefined) {
      model.featureWeights[f.name] = raw.featureWeights[f.name];
    }
  }
  console.log(`[SCORER] Loaded: ${model.trades.length} trades, ${model.shadowTrades.length} shadow, ${(model.winRate*100).toFixed(0)}% WR, threshold ${(model.threshold*100).toFixed(0)}%`);
}

function saveModel() {
  try {
    if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });
    // Limit stored trades to last 200 to prevent unbounded growth
    if (model.trades.length > 200) model.trades = model.trades.slice(-200);
    if (model.shadowTrades.length > 500) model.shadowTrades = model.shadowTrades.slice(-500);
    fs.writeFileSync(MODEL_FILE, JSON.stringify(model, null, 2));
  } catch { /* never crash on save */ }
  saveModelToRedis().catch(() => {});
}

async function saveModelToRedis() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;
  try {
    const Redis = (await import('ioredis')).default;
    const redis = new Redis(redisUrl, { lazyConnect: true });
    await redis.connect();
    await redis.set('sniper:adaptive_model', JSON.stringify(model));
    await redis.disconnect();
  } catch { /* non-fatal */ }
}

export async function loadModelFromRedis() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;
  try {
    const Redis = (await import('ioredis')).default;
    const redis = new Redis(redisUrl, { lazyConnect: true });
    await redis.connect();
    const data = await redis.get('sniper:adaptive_model');
    await redis.disconnect();
    if (data) {
      migrateAndMerge(JSON.parse(data));
      console.log(`[SCORER] Loaded from Redis: ${model.trades.length} trades`);
    }
  } catch { /* fallback to file */ }
}

// Initialize — file first
loadModel();

// Init: Postgres (primary) → Redis (fallback) → file (last resort) → training seed
async function initScorer() {
  // 1. Try Postgres first (durable, survives redeploys)
  const dbState = await loadScorerState().catch(() => null);
  const dbTrades = await loadTradesFromDB().catch(() => []);

  if (dbState && dbState.totalTrades > 0) {
    // Restore scorer state from Postgres
    model.bucketStats = dbState.bucketStats;
    model.featureWeights = dbState.featureWeights;
    model.winRate = dbState.winRate;
    model.threshold = dbState.threshold;
    console.log(`[SCORER] Loaded from Postgres: ${dbState.totalTrades} trades, ${(dbState.winRate * 100).toFixed(0)}% WR, threshold ${(dbState.threshold * 100).toFixed(0)}%`);
  } else if (dbTrades.length > 0) {
    // No scorer state saved yet, but we have trades — rebuild from trade history
    console.log(`[SCORER] Rebuilding from ${dbTrades.length} Postgres trades...`);
    for (const t of dbTrades) {
      updateBuckets(t.metrics, t.won);
      model.trades.push({
        mint: t.mint, symbol: t.symbol, metrics: t.metrics,
        pnlPct: t.pnlPct, pnlSol: 0, won: t.won,
        holdMs: 0, reason: t.exitReason, ts: Date.now(),
      });
    }
    recalculateWeights();
    const wins = model.trades.filter(t => t.won).length;
    model.winRate = model.trades.length > 0 ? wins / model.trades.length : 0.5;
    await saveScorerState({
      bucketStats: model.bucketStats,
      featureWeights: model.featureWeights,
      winRate: model.winRate,
      threshold: model.threshold,
      totalTrades: model.trades.length,
    }).catch(() => {});
    console.log(`[SCORER] Rebuilt: ${model.trades.length} trades, ${(model.winRate * 100).toFixed(0)}% WR`);
  } else {
    // 2. Fall back to Redis
    await loadModelFromRedis().catch(() => {});
    console.log(`[SCORER] Loaded from Redis/file fallback`);
  }

  // 3. Force reset if requested
  if (process.env.RESET_SCORER === 'true') {
    const shadowKeep = model.shadowTrades.filter(s => s.checked);
    model = createFreshModel();
    model.shadowTrades = shadowKeep;
    saveModel();
    console.log(`[SCORER] HARD RESET — cleared all trades + bucket stats, kept ${shadowKeep.length} shadow records`);
  }
}
initScorer().catch(() => {});

// ── Bucket classification ────────────────────────────────────────────────────
function getBucket(featureName: string, value: number): 'low' | 'mid' | 'high' {
  const def = FEATURES.find(f => f.name === featureName);
  if (!def) return 'mid';
  if (value < def.buckets[0]) return 'low';
  if (value > def.buckets[1]) return 'high';
  return 'mid';
}

// ── Score a candidate ────────────────────────────────────────────────────────
export function scoreCandidate(metrics: EntryMetrics): {
  score: number; confidence: string; reasons: string[]; shouldEnter: boolean;
} {
  const reasons: string[] = [];
  const totalData = model.trades.length + model.shadowTrades.filter(s => s.checked).length;

  // FIX #1: Exploration mode — if idle too long, lower threshold to generate data
  const idleMs = Date.now() - model.lastTradeAt;
  const inExploration = totalData < MIN_TRADES_TO_SCORE || idleMs > EXPLORATION_IDLE_MS;

  if (inExploration) {
    const effectiveThreshold = 0.15; // exploration = let almost anything through to gather data
    reasons.push(totalData < MIN_TRADES_TO_SCORE
      ? `${totalData}/${MIN_TRADES_TO_SCORE} data points — exploring`
      : `Idle ${(idleMs/60000).toFixed(0)}min — exploring (threshold: ${(effectiveThreshold*100).toFixed(0)}%)`);

    // Still compute score for logging, but use lower threshold
    const { score } = computeScore(metrics);
    return {
      score,
      confidence: 'EXPLORE',
      reasons,
      shouldEnter: score >= effectiveThreshold,
    };
  }

  const { score, reasons: scoreReasons } = computeScore(metrics);
  reasons.push(...scoreReasons);
  const shouldEnter = score >= model.threshold;
  const confidence = score >= 0.6 ? 'HIGH' : score >= 0.4 ? 'MED' : 'LOW';

  if (!shouldEnter) {
    reasons.push(`Score ${(score * 100).toFixed(0)}% < threshold ${(model.threshold * 100).toFixed(0)}%`);
  }

  return { score, confidence, reasons, shouldEnter };
}

function computeScore(metrics: EntryMetrics): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let totalWeight = 0;
  let weightedScore = 0;

  for (const feat of FEATURES) {
    const val = (metrics as any)[feat.name] ?? 0;
    const bucket = getBucket(feat.name, val);
    const stats = model.bucketStats[feat.name]?.[bucket];
    const weight = model.featureWeights[feat.name] ?? feat.defaultWeight;

    if (stats && stats.total > 0) {
      const wr = stats.wins / stats.total;
      weightedScore += wr * weight;
      totalWeight += weight;
      if (stats.total >= 3 && (wr >= 0.7 || wr <= 0.3)) {
        reasons.push(`${feat.name}=${val.toFixed(0)} (${bucket}) → ${(wr*100).toFixed(0)}%${wr <= 0.3 ? ' ⚠' : ''}`);
      }
    } else {
      weightedScore += model.winRate * weight;
      totalWeight += weight;
    }
  }

  return { score: totalWeight > 0 ? weightedScore / totalWeight : 0.5, reasons };
}

// ── FIX #3: Shadow tracking — learn from rejected candidates ─────────────────
export function recordShadowCandidate(mint: string, symbol: string, metrics: EntryMetrics, score: number) {
  // Don't shadow-track if we already have too many pending
  const pending = model.shadowTrades.filter(s => !s.checked);
  if (pending.length >= 50) return;

  model.shadowTrades.push({
    mint, symbol, metrics, score,
    rejectedAt: Date.now(),
    checked: false,
    pnlPctAfter5m: null,
  });
}

/** Check shadow candidates — call periodically from the sniper */
export async function checkShadowCandidates(jupiterApiKey: string) {
  const now = Date.now();
  const pending = model.shadowTrades.filter(s => !s.checked && now - s.rejectedAt >= SHADOW_CHECK_MS);
  if (pending.length === 0) return;

  let updated = false;
  for (const shadow of pending.slice(0, 5)) { // batch of 5
    shadow.checked = true;
    try {
      // Get current price via Jupiter quote
      const buyLamports = 100000000; // 0.1 SOL
      const url = `https://public.jupiterapi.com/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${shadow.mint}&amount=${buyLamports}&slippageBps=500`;
      const res = await fetch(url, {
        headers: { 'x-api-key': jupiterApiKey, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const quote: any = await res.json();
      const outAmount = Number(quote.outAmount || 0);
      if (outAmount === 0) continue;

      // We need entry price to compute PnL — estimate from entry metrics
      // Since we didn't actually buy, simulate: would the price have gone up?
      // Use a second quote (sell the tokens back) to get round-trip value
      const sellUrl = `https://public.jupiterapi.com/quote?inputMint=${shadow.mint}&outputMint=So11111111111111111111111111111111111111112&amount=${outAmount}&slippageBps=500`;
      const sellRes = await fetch(sellUrl, {
        headers: { 'x-api-key': jupiterApiKey, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!sellRes.ok) continue;
      const sellQuote: any = await sellRes.json();
      const sellAmount = Number(sellQuote.outAmount || 0);
      const pnlPct = ((sellAmount - buyLamports) / buyLamports) * 100;
      shadow.pnlPctAfter5m = pnlPct;

      const wouldHaveWon = pnlPct >= SHADOW_WIN_THRESHOLD;
      const correctReject = pnlPct <= SHADOW_LOSS_THRESHOLD;

      if (wouldHaveWon) {
        // MISSED OPPORTUNITY — update buckets as if this was a winning trade
        console.log(`[SCORER] SHADOW MISS: ${shadow.symbol} → +${pnlPct.toFixed(1)}% in 5min (we rejected at ${(shadow.score*100).toFixed(0)}%)`);
        updateBuckets(shadow.metrics, true);
        updated = true;
      } else if (correctReject) {
        // CORRECT REJECTION — reinforces the scorer's decision
        console.log(`[SCORER] SHADOW OK: ${shadow.symbol} → ${pnlPct.toFixed(1)}% in 5min (correctly rejected)`);
        updateBuckets(shadow.metrics, false);
        updated = true;
      }
      // If -10% < pnl < +10% — inconclusive, don't update
    } catch { /* non-fatal */ }
  }

  if (updated) {
    recalculateWeights();
    saveModel();
  }
}

// ── Record trade outcome ─────────────────────────────────────────────────────
export function recordTradeOutcome(
  mint: string, symbol: string, metrics: EntryMetrics,
  pnlPct: number, pnlSol: number, holdMs: number, reason: string,
) {
  const won = pnlPct >= 0;
  model.trades.push({ mint, symbol, metrics, pnlPct, pnlSol, won, holdMs, reason, ts: Date.now() });
  model.lastTradeAt = Date.now();

  updateBuckets(metrics, won);
  recalculateWeights();

  // Adaptive threshold — cap at 0.40 in paper mode to keep generating data
  const isPaper = (process.env.PAPER_MODE || '').toLowerCase() === 'true';
  const maxThreshold = isPaper ? 0.40 : 0.65;
  if (model.trades.length >= MIN_TRADES_TO_SCORE) {
    if (model.winRate < 0.35) {
      model.threshold = Math.min(maxThreshold, model.threshold + 0.01);
    } else if (model.winRate > 0.55) {
      model.threshold = Math.max(0.20, model.threshold - 0.01);
    }
  }

  model.updatedAt = Date.now();
  saveModel();

  // Persist to Postgres (durable, survives redeploys)
  saveTradetoDB({
    mint, symbol, source: metrics.source || 'live',
    metrics, won, pnlPct, pnlSol, holdMs, exitReason: reason,
  }).catch(() => {});
  saveScorerState({
    bucketStats: model.bucketStats,
    featureWeights: model.featureWeights,
    winRate: model.winRate,
    threshold: model.threshold,
    totalTrades: model.trades.length,
  }).catch(() => {});

  const wins = model.trades.filter(t => t.won);
  const losses = model.trades.filter(t => !t.won);
  console.log(
    `[SCORER] Trade #${model.trades.length}: ${won ? 'WIN' : 'LOSS'} ${symbol} ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% | ` +
    `WR: ${(model.winRate * 100).toFixed(0)}% (${wins.length}W/${losses.length}L) | ` +
    `Threshold: ${(model.threshold * 100).toFixed(0)}%`
  );

  const ranked = FEATURES
    .map(f => ({ name: f.name, weight: model.featureWeights[f.name] ?? f.defaultWeight }))
    .sort((a, b) => b.weight - a.weight);
  console.log(`[SCORER] Top features: ${ranked.slice(0, 4).map(f => `${f.name}(${f.weight.toFixed(2)})`).join(', ')}`);
}

function updateBuckets(metrics: EntryMetrics, won: boolean) {
  for (const feat of FEATURES) {
    const val = (metrics as any)[feat.name] ?? 0;
    const bucket = getBucket(feat.name, val);
    if (!model.bucketStats[feat.name]) {
      model.bucketStats[feat.name] = {
        low: { wins: 0, total: 0 }, mid: { wins: 0, total: 0 }, high: { wins: 0, total: 0 },
      };
    }
    model.bucketStats[feat.name][bucket].total++;
    if (won) model.bucketStats[feat.name][bucket].wins++;
  }
}

function recalculateWeights() {
  for (const feat of FEATURES) {
    const stats = model.bucketStats[feat.name];
    if (!stats) continue;
    const rates = (['low', 'mid', 'high'] as const).map(b => {
      const s = stats[b];
      return s.total >= 2 ? s.wins / s.total : 0.5;
    });
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    const variance = rates.reduce((a, r) => a + (r - mean) ** 2, 0) / rates.length;
    model.featureWeights[feat.name] = feat.defaultWeight + variance * 5;
  }

  const wins = model.trades.filter(t => t.won);
  const losses = model.trades.filter(t => !t.won);
  model.winRate = model.trades.length > 0 ? wins.length / model.trades.length : 0.5;
  model.avgWinPct = wins.length > 0 ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0;
  model.avgLossPct = losses.length > 0 ? losses.reduce((a, t) => a + t.pnlPct, 0) / losses.length : 0;
}

// ── Summary ──────────────────────────────────────────────────────────────────
export function getModelSummary(): string {
  const t = model.trades.length;
  if (t === 0) return 'No trades yet';
  const w = model.trades.filter(x => x.won).length;
  const totalPnl = model.trades.reduce((a, x) => a + x.pnlSol, 0);
  const shadowMisses = model.shadowTrades.filter(s => s.checked && (s.pnlPctAfter5m || 0) >= SHADOW_WIN_THRESHOLD).length;
  const shadowCorrect = model.shadowTrades.filter(s => s.checked && (s.pnlPctAfter5m || 0) <= SHADOW_LOSS_THRESHOLD).length;
  return (
    `Trades: ${t} (${w}W/${t - w}L) | WR: ${(model.winRate * 100).toFixed(0)}%\n` +
    `PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL\n` +
    `Threshold: ${(model.threshold * 100).toFixed(0)}% | ` +
    `Shadow: ${shadowMisses} missed, ${shadowCorrect} correct rejections`
  );
}
