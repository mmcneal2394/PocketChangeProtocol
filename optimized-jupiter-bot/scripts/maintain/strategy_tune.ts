/**
 * strategy_tune.ts  —  Prometheus agent: on-demand strategy recalibration
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads SQLite trade history, recalculates Kelly fraction, Sharpe ratio,
 * and per-param thresholds — then writes updated strategy_params.json.
 *
 * This is the swarm-triggered version of strategy_tuner.ts (which runs
 * inside the engine process). Run this standalone to force a recalibration
 * without restarting the engine (the engine hot-reloads strategy_params.json).
 *
 * Usage:
 *   npx ts-node scripts/maintain/strategy_tune.ts
 *   npx ts-node scripts/maintain/strategy_tune.ts --fast  (threshold-only)
 *   npx ts-node scripts/maintain/strategy_tune.ts --slow  (full Kelly rebuild)
 *   npx ts-node scripts/maintain/strategy_tune.ts --dry-run (print only)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs   from 'fs';
import path from 'path';
const Database = require('better-sqlite3');
import RedisBus from '../../src/utils/redis_bus';

const FAST_ONLY = process.argv.includes('--fast');
const SLOW_ONLY = process.argv.includes('--slow');
const DRY_RUN   = process.argv.includes('--dry-run');
const RUN_ALL   = !FAST_ONLY && !SLOW_ONLY;

const DB_PATH     = path.join(process.cwd(), process.env.LOG_DB_PATH || 'trades.db');
const PARAMS_PATH = path.join(process.cwd(), 'strategy_params.json');
const TUNE_LOG    = path.join(process.cwd(), 'strategy_tune_log.jsonl');

const FAST_WINDOW = 50;
const SLOW_WINDOW = 500;

// ── Param bounds (safety rails — never go outside these) ──────────────────────
const BOUNDS = {
  MIN_PROFIT_SOL:    { min: 0.00005, max: 0.01 },
  MIN_SPREAD_BPS:    { min: 3,       max: 50   },
  TIP_PERCENTAGE:    { min: 0.20,    max: 0.75 },
  MAX_SLIPPAGE_BPS:  { min: 20,      max: 200  },
  MAX_TRADE_SIZE_SOL:{ min: 0.005,   max: 0.5  },
  SPLIT_RATIO:       { min: 0.25,    max: 0.75 },
};

const DEFAULT_PARAMS = {
  MIN_PROFIT_SOL: 0.0001, MIN_SPREAD_BPS: 8, PRIORITY_MICRO_LAMPORTS: 250000,
  TIP_PERCENTAGE: 0.50, MAX_SLIPPAGE_BPS: 50, MAX_TRADE_SIZE_SOL: 0.02, SPLIT_RATIO: 0.50,
  fastUpdatedAt: 0, slowUpdatedAt: 0,
};

function clamp(v: number, key: keyof typeof BOUNDS): number {
  const b = BOUNDS[key];
  return Math.min(b.max, Math.max(b.min, v));
}

function loadParams(): typeof DEFAULT_PARAMS {
  try {
    if (fs.existsSync(PARAMS_PATH)) return { ...DEFAULT_PARAMS, ...JSON.parse(fs.readFileSync(PARAMS_PATH, 'utf-8')) };
  } catch {}
  return { ...DEFAULT_PARAMS };
}

function loadTrades(limit: number): any[] {
  if (!fs.existsSync(DB_PATH)) {
    console.warn('[TUNE] DB not found — using default params');
    return [];
  }
  const db = new Database(DB_PATH, { readonly: true });
  const rows = db.prepare('SELECT * FROM trades WHERE decision = ? ORDER BY timestamp DESC LIMIT ?').all('executed', limit);
  db.close();
  return rows;
}

// ── Fast loop: threshold-only recalibration ───────────────────────────────────
function fastTune(trades: any[], current: typeof DEFAULT_PARAMS): Partial<typeof DEFAULT_PARAMS> {
  if (trades.length < 5) {
    console.log('[TUNE/FAST] Not enough trades for recalibration (need ≥5)');
    return {};
  }

  const profits = trades.map(t => (t.actual_profit || 0) / 1e9); // SOL
  const sorted  = [...profits].sort((a, b) => a - b);

  // MIN_PROFIT_SOL → 25th percentile of actual profits
  const p25 = sorted[Math.floor(sorted.length * 0.25)];
  const newMinProfit = clamp(Math.max(DEFAULT_PARAMS.MIN_PROFIT_SOL, p25 * 0.8), 'MIN_PROFIT_SOL');

  // MIN_SPREAD_BPS → 20th percentile of expected_profit_bps (floor with margin)
  const bps   = trades.map(t => t.expected_profit_bps || 0).sort((a, b) => a - b);
  const p20   = bps[Math.floor(bps.length * 0.20)] || 0;
  const newSpreadBps = clamp(Math.max(3, Math.floor(p20 * 0.8)), 'MIN_SPREAD_BPS');

  return {
    MIN_PROFIT_SOL: parseFloat(newMinProfit.toFixed(8)),
    MIN_SPREAD_BPS: newSpreadBps,
    fastUpdatedAt:  Date.now(),
  };
}

// ── Slow loop: Kelly + Sharpe full rebuild ────────────────────────────────────
function slowTune(trades: any[], current: typeof DEFAULT_PARAMS): Partial<typeof DEFAULT_PARAMS> {
  if (trades.length < 30) {
    console.log('[TUNE/SLOW] Not enough trades for full Kelly rebuild (need ≥30)');
    return {};
  }

  const profits     = trades.map(t => (t.actual_profit || 0) / 1e9);
  const tips        = trades.map(t => (t.jito_tip || 0) / 1e9);
  const wins        = profits.filter(p => p > 0);
  const losses      = profits.filter(p => p <= 0);

  // Kelly criterion: f* = (p * b - q) / b
  // where p = win rate, q = loss rate, b = avg win / avg abs loss
  const p   = wins.length / profits.length;
  const q   = 1 - p;
  const avgWin  = wins.length > 0  ? wins.reduce((s, v) => s + v, 0) / wins.length : 0.0001;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, v) => s + v, 0) / losses.length) : 0.0001;
  const b   = avgWin / avgLoss;
  const kelly = p > 0 && b > 0 ? (p * b - q) / b : 0.3;

  // Half-Kelly (safer): cap at 0.70 so we never over-allocate tips
  const tipPct = clamp(Math.min(0.70, Math.max(0.15, kelly * 0.5)), 'TIP_PERCENTAGE');

  // Sharpe-weighted max trade size
  const mean   = profits.reduce((s, v) => s + v, 0) / profits.length;
  const stdDev = Math.sqrt(profits.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / profits.length);
  const sharpe = stdDev > 0 ? mean / stdDev : 0;
  // Higher Sharpe → allow slightly larger trades (confidence in signal quality)
  const tradeSize = clamp(0.01 + sharpe * 0.005, 'MAX_TRADE_SIZE_SOL');

  // Slippage: p75 of observed tip ratios as a proxy for fee pressure
  const tipRatios = tips.map((t, i) => profits[i] > 0 ? t / Math.max(profits[i], 0.0001) : 0).sort((a, b) => a - b);
  const p75slip   = tipRatios[Math.floor(tipRatios.length * 0.75)] || 0;
  const slippage  = clamp(Math.round(30 + p75slip * 1000), 'MAX_SLIPPAGE_BPS');

  console.log(`[TUNE/SLOW] Kelly: ${(kelly*100).toFixed(1)}% | Half-Kelly tip: ${(tipPct*100).toFixed(1)}% | Sharpe: ${sharpe.toFixed(2)} | TradeSize: ${tradeSize.toFixed(4)} SOL`);

  return {
    TIP_PERCENTAGE:    parseFloat(tipPct.toFixed(4)),
    MAX_SLIPPAGE_BPS:  slippage,
    MAX_TRADE_SIZE_SOL:parseFloat(tradeSize.toFixed(4)),
    SPLIT_RATIO:       clamp(p * 1.2, 'SPLIT_RATIO'), // bias toward win rate
    slowUpdatedAt:     Date.now(),
  };
}

// ── Entry ─────────────────────────────────────────────────────────────────────
function main() {
  const current = loadParams();
  const updates: Partial<typeof DEFAULT_PARAMS> = {};

  if (RUN_ALL || FAST_ONLY) {
    const fastTrades = loadTrades(FAST_WINDOW);
    console.log(`[TUNE/FAST] Loaded ${fastTrades.length} trades`);
    Object.assign(updates, fastTune(fastTrades, current));
  }
  if (RUN_ALL || SLOW_ONLY) {
    const slowTrades = loadTrades(SLOW_WINDOW);
    console.log(`[TUNE/SLOW] Loaded ${slowTrades.length} trades`);
    Object.assign(updates, slowTune(slowTrades, current));
  }

  if (Object.keys(updates).length === 0) {
    console.log('[TUNE] No parameter changes — insufficient trade data or no updates needed');
    return; // Instead of process.exit(0), just return since we are a Redis daemon now
  }

  const newParams = { ...current, ...updates };

  // Print diff
  console.log('\n[TUNE] Parameter changes:');
  for (const [k, v] of Object.entries(updates)) {
    if (k.endsWith('At')) continue;
    const prev = (current as any)[k];
    console.log(`  ${k}: ${prev} → ${v}  ${v > prev ? '▲' : '▼'}`);
  }

  if (DRY_RUN) {
    console.log('\n[TUNE] --dry-run: not writing. Would write:');
    console.log(JSON.stringify(newParams, null, 2));
  } else {
    fs.writeFileSync(PARAMS_PATH, JSON.stringify(newParams, null, 2));
    // Append to tune log for audit trail
    fs.appendFileSync(TUNE_LOG, JSON.stringify({ timestamp: Date.now(), updates }) + '\n');
    console.log(`\n[TUNE] ✅ strategy_params.json updated (engine hot-reloads on next cycle)`);
  }
}

// Redis Pub/Sub Daemon
function startOptimizerDaemon() {
  console.log(`[OPTIMIZER] 🛠️ Initializing Redis Subscriber Daemon...`);
  const subscriber = RedisBus.getSubscriber();

  subscriber.subscribe('optimizer:update', (err, count) => {
    if (err) console.error(`[OPTIMIZER] ❌ Redis Subscribe Error:`, err);
    else console.log(`[OPTIMIZER] ✅ Listening for AI Critic updates tightly via Memory...`);
  });

  subscriber.on('message', (channel, message) => {
    if (channel === 'optimizer:update') {
      console.log(`[OPTIMIZER] 📥 Target received from Critic via Redis! Processing immediately...`);
      main(); // triggers the tuning logic precisely on command
    }
  });

  // Start initial tune naturally on boot
  main();

  // Heartbeat system every 30 seconds
  setInterval(() => {
    RedisBus.publish('heartbeat:agent', { agent: 'pcp-optimizer', timestamp: Date.now() });
  }, 30000);
}

startOptimizerDaemon();
