/**
 * trade_logger.ts — Comprehensive trade logging for adaptive learning
 * ─────────────────────────────────────────────────────────────────────────────
 * Captures every decision factor at each stage: detection → evaluation →
 * entry → hold → exit → post-analysis. Feeds the adaptive scorer with
 * rich, queryable data.
 */

import fs from 'fs';
import path from 'path';

const SIGNALS_DIR = path.join(process.cwd(), 'signals');
const TRADES_FILE = path.join(SIGNALS_DIR, 'trade_analytics.json');

// ── Full trade lifecycle record ──────────────────────────────────────────────
export interface TradeAnalytics {
  id: string;                    // unique trade ID
  mint: string;
  symbol: string;
  status: 'open' | 'closed';

  // Detection phase
  detection: {
    source: 'velocity-first' | 'dexscreener' | 'velocity-override';
    detectedAt: number;          // timestamp
    velocityAtDetection: {
      buys60s: number;
      sells60s: number;
      buyRatio60s: number;
      velocity: number;          // tx/min
      isAccelerating: boolean;
      solVolume60s: number;
    } | null;
    dexscreenerData: {
      volume1h: number;
      priceChange1h: number;
      priceChange5m: number | null;
      priceChange1m: number | null;
      buys1h: number;
      sells1h: number;
      buyRatio: number;
      liquidity: number;
      mcap: number;
      tokenAgeSec: number | null;
      dexCount: number;
    } | null;
  };

  // Scoring phase
  scoring: {
    adaptiveScore: number;       // 0-1
    confidence: string;          // HIGH/MED/LOW/NO_DATA
    reasons: string[];           // feature-level explanations
    shouldEnter: boolean;
    threshold: number;           // what the threshold was at decision time
    featureBreakdown: { [feature: string]: { value: number; bucket: string; bucketWinRate: number } };
  };

  // Entry phase
  entry: {
    executedAt: number;
    buySizeSol: number;
    tokenAmount: number;
    entryPriceSol: number;       // price per token in SOL
    jupiterRoute: string | null; // route summary if available
    signalToEntryMs: number;     // latency from detection to execution
    tpPct: number;
    slPct: number;
  };

  // Hold phase (updated in real-time)
  hold: {
    peakPnlPct: number;
    peakPnlAt: number | null;    // when peak was hit
    troughPnlPct: number;
    trailActivatedAt: number | null;
    orderFlowReversals: number;  // count of times buy ratio flipped
    velocitySnapshots: Array<{   // periodic velocity during hold
      ts: number;
      buys60s: number;
      sells60s: number;
      buyRatio60s: number;
    }>;
    priceChecks: Array<{         // PnL over time
      ts: number;
      pnlPct: number;
    }>;
  };

  // Exit phase
  exit: {
    exitedAt: number;
    reason: string;              // TP, SL, TRAIL, TIMEOUT, ORDERFLOW-REVERSAL
    pnlPct: number;
    pnlSol: number;
    holdMs: number;
    exitPriceSol: number;
    velocityAtExit: {
      buys60s: number;
      sells60s: number;
      buyRatio60s: number;
    } | null;
  } | null;

  // Post-analysis (computed after exit)
  postAnalysis: {
    optimalExitPnl: number | null;     // what was the best possible exit?
    exitedTooEarly: boolean | null;    // did price pump after exit?
    exitedTooLate: boolean | null;     // did we ride past the peak?
    effectiveSlippage: number | null;  // entry quote vs actual
  } | null;
}

// ── In-memory trade store ────────────────────────────────────────────────────
let trades: TradeAnalytics[] = [];

function loadTrades() {
  try {
    if (fs.existsSync(TRADES_FILE)) {
      trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf-8'));
    }
  } catch { trades = []; }
}

function saveTrades() {
  try {
    if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });
    // Keep last 100 trades to prevent unbounded growth
    if (trades.length > 100) trades = trades.slice(-100);
    fs.writeFileSync(TRADES_FILE, JSON.stringify(trades, null, 2));
  } catch { /* never crash on save */ }
  saveAnalyticsToRedis().catch(() => {});
}

async function saveAnalyticsToRedis() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;
  try {
    const Redis = (await import('ioredis')).default;
    const redis = new Redis(redisUrl, { lazyConnect: true });
    await redis.connect();
    await redis.set('sniper:trade_analytics', JSON.stringify(trades));
    await redis.disconnect();
  } catch { /* non-fatal */ }
}

async function loadAnalyticsFromRedis() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;
  try {
    const Redis = (await import('ioredis')).default;
    const redis = new Redis(redisUrl, { lazyConnect: true });
    await redis.connect();
    const data = await redis.get('sniper:trade_analytics');
    await redis.disconnect();
    if (data) {
      trades = JSON.parse(data);
      console.log(`[ANALYTICS] Loaded ${trades.length} trades from Redis`);
    }
  } catch { /* fallback to file */ }
}

loadTrades();
loadAnalyticsFromRedis().catch(() => {});

// ── Public API ───────────────────────────────────────────────────────────────

/** Create a new trade record at detection time */
export function logDetection(params: {
  mint: string;
  symbol: string;
  source: TradeAnalytics['detection']['source'];
  velocity: TradeAnalytics['detection']['velocityAtDetection'];
  dexscreener: TradeAnalytics['detection']['dexscreenerData'];
}): string {
  const id = `T${Date.now().toString(36)}_${params.mint.slice(0, 6)}`;
  const trade: TradeAnalytics = {
    id,
    mint: params.mint,
    symbol: params.symbol,
    status: 'open',
    detection: {
      source: params.source,
      detectedAt: Date.now(),
      velocityAtDetection: params.velocity,
      dexscreenerData: params.dexscreener,
    },
    scoring: {
      adaptiveScore: 0, confidence: '', reasons: [],
      shouldEnter: false, threshold: 0, featureBreakdown: {},
    },
    entry: {
      executedAt: 0, buySizeSol: 0, tokenAmount: 0, entryPriceSol: 0,
      jupiterRoute: null, signalToEntryMs: 0, tpPct: 0, slPct: 0,
    },
    hold: {
      peakPnlPct: 0, peakPnlAt: null, troughPnlPct: 0,
      trailActivatedAt: null, orderFlowReversals: 0,
      velocitySnapshots: [], priceChecks: [],
    },
    exit: null,
    postAnalysis: null,
  };
  trades.push(trade);
  saveTrades();
  return id;
}

/** Record scoring decision */
export function logScoring(tradeId: string, scoring: TradeAnalytics['scoring']) {
  const t = trades.find(t => t.id === tradeId);
  if (t) { t.scoring = scoring; saveTrades(); }
}

/** Record entry execution */
export function logEntry(tradeId: string, entry: Partial<TradeAnalytics['entry']>) {
  const t = trades.find(t => t.id === tradeId);
  if (t) {
    Object.assign(t.entry, entry);
    t.entry.signalToEntryMs = t.entry.executedAt - t.detection.detectedAt;
    saveTrades();
  }
}

/** Record a price check during hold */
export function logPriceCheck(mint: string, pnlPct: number) {
  const t = trades.find(t => t.mint === mint && t.status === 'open');
  if (!t) return;

  t.hold.priceChecks.push({ ts: Date.now(), pnlPct });

  // Keep last 100 checks to avoid unbounded growth
  if (t.hold.priceChecks.length > 100) {
    t.hold.priceChecks = t.hold.priceChecks.slice(-100);
  }

  if (pnlPct > t.hold.peakPnlPct) {
    t.hold.peakPnlPct = pnlPct;
    t.hold.peakPnlAt = Date.now();
  }
  if (pnlPct < t.hold.troughPnlPct) {
    t.hold.troughPnlPct = pnlPct;
  }

  // Don't save on every check — batch save happens on exit
}

/** Record trail activation */
export function logTrailActivation(mint: string) {
  const t = trades.find(t => t.mint === mint && t.status === 'open');
  if (t && !t.hold.trailActivatedAt) {
    t.hold.trailActivatedAt = Date.now();
  }
}

/** Record velocity snapshot during hold */
export function logVelocitySnapshot(mint: string, vel: { buys60s: number; sells60s: number; buyRatio60s: number }) {
  const t = trades.find(t => t.mint === mint && t.status === 'open');
  if (t) {
    t.hold.velocitySnapshots.push({ ts: Date.now(), ...vel });
    if (t.hold.velocitySnapshots.length > 50) {
      t.hold.velocitySnapshots = t.hold.velocitySnapshots.slice(-50);
    }
  }
}

/** Record order flow reversal */
export function logOrderFlowReversal(mint: string) {
  const t = trades.find(t => t.mint === mint && t.status === 'open');
  if (t) t.hold.orderFlowReversals++;
}

/** Record exit and compute post-analysis */
export function logExit(mint: string, exit: {
  reason: string;
  pnlPct: number;
  pnlSol: number;
  holdMs: number;
  exitPriceSol: number;
  velocityAtExit: TradeAnalytics['exit'] extends null ? never : NonNullable<TradeAnalytics['exit']>['velocityAtExit'];
}) {
  const t = trades.find(t => t.mint === mint && t.status === 'open');
  if (!t) return;

  t.status = 'closed';
  t.exit = { exitedAt: Date.now(), ...exit };

  // Post-analysis
  const peak = t.hold.peakPnlPct;
  // Approximate entry slippage: first price check within 10s of entry reflects
  // execution slippage rather than market movement (negative = unfavorable)
  const firstCheck = t.hold.priceChecks.find(pc => pc.ts - t.entry.executedAt < 10_000);
  const estimatedSlippage = firstCheck ? Math.min(0, firstCheck.pnlPct) : null;
  t.postAnalysis = {
    optimalExitPnl: peak,
    exitedTooEarly: exit.pnlPct >= 0 && peak > exit.pnlPct * 2, // missed 2x the gain
    exitedTooLate: exit.pnlPct < 0 && peak > 3, // was up 3%+ but exited negative
    effectiveSlippage: estimatedSlippage,
  };

  // Log summary
  const latency = t.entry.signalToEntryMs;
  const holdVelChange = t.hold.velocitySnapshots.length >= 2
    ? t.hold.velocitySnapshots[t.hold.velocitySnapshots.length - 1].buyRatio60s - t.hold.velocitySnapshots[0].buyRatio60s
    : null;

  console.log(
    `[ANALYTICS] Trade ${t.id} closed:\n` +
    `  Source: ${t.detection.source} | Signal→Entry: ${latency}ms\n` +
    `  PnL: ${exit.pnlPct >= 0 ? '+' : ''}${exit.pnlPct.toFixed(1)}% (${exit.pnlSol >= 0 ? '+' : ''}${exit.pnlSol.toFixed(4)} SOL)\n` +
    `  Peak: +${peak.toFixed(1)}% | Trough: ${t.hold.troughPnlPct.toFixed(1)}%\n` +
    `  Hold: ${(exit.holdMs / 60000).toFixed(1)}min | Checks: ${t.hold.priceChecks.length}\n` +
    `  ${t.postAnalysis.exitedTooEarly ? '⚠ EXITED TOO EARLY (missed gains)' : ''}` +
    `  ${t.postAnalysis.exitedTooLate ? '⚠ EXITED TOO LATE (peak was +' + peak.toFixed(1) + '%)' : ''}` +
    `  OrderFlow reversals: ${t.hold.orderFlowReversals}` +
    (holdVelChange !== null ? ` | BuyRatio shift: ${holdVelChange > 0 ? '+' : ''}${(holdVelChange * 100).toFixed(0)}%` : '')
  );

  saveTrades();
}

/** Get analytics summary for Telegram */
export function getAnalyticsSummary(): string {
  const closed = trades.filter(t => t.status === 'closed');
  if (closed.length === 0) return 'No completed trades';

  const wins = closed.filter(t => t.exit && t.exit.pnlPct >= 0);
  const losses = closed.filter(t => t.exit && t.exit.pnlPct < 0);
  const totalPnl = closed.reduce((s, t) => s + (t.exit?.pnlSol ?? 0), 0);
  const avgLatency = closed.reduce((s, t) => s + t.entry.signalToEntryMs, 0) / closed.length;
  const tooEarly = closed.filter(t => t.postAnalysis?.exitedTooEarly).length;
  const tooLate = closed.filter(t => t.postAnalysis?.exitedTooLate).length;

  // Source breakdown
  const bySource: Record<string, { wins: number; total: number }> = {};
  for (const t of closed) {
    const src = t.detection.source;
    if (!bySource[src]) bySource[src] = { wins: 0, total: 0 };
    bySource[src].total++;
    if (t.exit && t.exit.pnlPct >= 0) bySource[src].wins++;
  }

  let sourceStr = Object.entries(bySource)
    .map(([src, s]) => `${src}: ${s.wins}/${s.total}`)
    .join(' | ');

  return (
    `Trades: ${closed.length} (${wins.length}W/${losses.length}L)\n` +
    `PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL\n` +
    `Avg latency: ${avgLatency.toFixed(0)}ms\n` +
    `Timing: ${tooEarly} early exits, ${tooLate} late exits\n` +
    `Sources: ${sourceStr}`
  );
}

/** Get trade by mint (for open positions) */
export function getOpenTrade(mint: string): TradeAnalytics | undefined {
  return trades.find(t => t.mint === mint && t.status === 'open');
}

/** Get all trades for analysis */
export function getAllTrades(): TradeAnalytics[] {
  return trades;
}
