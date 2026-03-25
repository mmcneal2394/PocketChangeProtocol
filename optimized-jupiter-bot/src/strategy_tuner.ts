/**
 * strategy_tuner.ts  —  Two-Speed Auto-Calibration
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  FAST LOOP  (default: 15 min, override FAST_TUNE_INTERVAL_MINUTES)
 *    · Reads last 50 trades only (cheap I/O)
 *    · Recalibrates: MIN_PROFIT_SOL, MIN_SPREAD_BPS
 *    · Safe to run frequently — these are threshold-only, no execution risk
 *    · Adapts to intraday volatility spikes, route crowding, fee changes
 *
 *  SLOW LOOP  (default: 72 h,  override TUNE_INTERVAL_HOURS)
 *    · Reads last 500 trades
 *    · Recalibrates: TIP_PERCENTAGE, MAX_SLIPPAGE_BPS, MAX_TRADE_SIZE_SOL,
 *                    SPLIT_RATIO  (full Kelly / Sharpe / percentile rebuild)
 *    · Needs statistical depth — never run on sparse data
 *
 *  Both loops write to strategy_params.json.  The slow loop merges over the
 *  fast loop's latest thresholds so nothing is ever overwritten blindly.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs   from 'fs';
import path from 'path';
import { logger } from './utils/logger';

// ── Intervals ─────────────────────────────────────────────────────────────────
const FAST_INTERVAL_MS = (parseInt(process.env.FAST_TUNE_INTERVAL_MINUTES || '15')) * 60 * 1000;
const SLOW_INTERVAL_MS = (parseInt(process.env.TUNE_INTERVAL_HOURS        || '72')) * 60 * 60 * 1000;

const FAST_WINDOW = 50;   // trade rows for fast loop
const SLOW_WINDOW = 500;  // trade rows for slow loop

const PARAMS_PATH     = path.join(process.cwd(), 'strategy_params.json');
const TELEMETRY_PATHS = [
  path.join(process.cwd(), 'engine-worker', 'telemetry.jsonl'),
  path.join(process.cwd(), 'telemetry.jsonl'),
];

// ── Default parameters ────────────────────────────────────────────────────────
// ENV overrides take priority — allows MIN_MODE to inject 0.005 SOL trade size
// without mutating strategy_params.json.
export const DEFAULT_PARAMS = {
  // --- Fast-loop owned ---
  MIN_PROFIT_SOL:          0.0001,
  MIN_SPREAD_BPS:          8,
  PRIORITY_MICRO_LAMPORTS: parseInt(process.env.PRIORITY_MICRO_LAMPORTS || '250000'),
  // --- Slow-loop owned ---
  TIP_PERCENTAGE:          0.50,
  MAX_SLIPPAGE_BPS:        50,
  MAX_TRADE_SIZE_SOL:      parseFloat(process.env.MAX_TRADE_SIZE_SOL || '0.02'),
  SPLIT_RATIO:             0.50,
  // --- Metadata ---
  fastUpdatedAt: 0,
  slowUpdatedAt: 0,
};


export type StrategyParams = typeof DEFAULT_PARAMS;

// ── Persist / load ─────────────────────────────────────────────────────────────
export function loadStrategyParams(): StrategyParams {
  try {
    if (fs.existsSync(PARAMS_PATH)) {
      return { ...DEFAULT_PARAMS, ...JSON.parse(fs.readFileSync(PARAMS_PATH, 'utf-8')) };
    }
  } catch {}
  return { ...DEFAULT_PARAMS };
}

function saveParams(params: StrategyParams): void {
  try {
    fs.writeFileSync(PARAMS_PATH, JSON.stringify(params, null, 2), 'utf-8');
  } catch (e: any) {
    logger.error(`[TUNER] Failed to save params: ${e.message}`);
  }
}

// ── Telemetry reader ──────────────────────────────────────────────────────────
interface TradeRow { success: boolean; profit_sol: number; spread_bps?: number; }

function readTelemetry(maxRows: number): TradeRow[] {
  for (const p of TELEMETRY_PATHS) {
    if (!fs.existsSync(p)) continue;
    try {
      const lines = fs.readFileSync(p, 'utf-8').trim().split('\n');
      return lines
        .filter(l => l.length > 5)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean)
        .slice(-maxRows) as TradeRow[];
    } catch { continue; }
  }
  return [];
}

// ── Math helpers ──────────────────────────────────────────────────────────────
function ema(values: number[], period: number): number {
  if (!values.length) return 0;
  const alpha = 2 / (period + 1);
  return values.reduce((acc, v, i) => i === 0 ? v : alpha * v + (1 - alpha) * acc, values[0]);
}

function stdDev(values: number[]): number {
  if (values.length <= 1) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo  = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function kellyFraction(winRate: number, avgWin: number, avgLoss: number): number {
  if (avgLoss <= 0 || avgWin <= 0) return 0.05;
  const b = avgWin / avgLoss;
  const kelly = (winRate * b - (1 - winRate)) / b;
  return Math.max(0.01, Math.min(0.25, kelly * 0.25)); // quarter-Kelly, clamped
}

function sharpeRatio(returns: number[]): number {
  if (returns.length < 5) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sd   = stdDev(returns);
  return sd === 0 ? 0 : mean / sd;
}

// ══ FAST LOOP ════════════════════════════════════════════════════════════════
// Only touches: MIN_PROFIT_SOL, MIN_SPREAD_BPS
// Safe to run every 15 min — pure threshold adjustments, no execution logic.
// ─────────────────────────────────────────────────────────────────────────────
function runFastTune(): void {
  const trades = readTelemetry(FAST_WINDOW);
  const current = loadStrategyParams();

  if (trades.length < 5) {
    logger.debug('[FAST-TUNER] <5 trades in window — skipping');
    return;
  }

  const profits       = trades.map(t => t.profit_sol);
  const winningProfits = profits.filter(p => p > 0).sort((a, b) => a - b);
  const emaWin        = ema(trades.map(t => t.success ? 1 : 0), 10);
  const spreads       = trades.filter(t => t.spread_bps != null).map(t => t.spread_bps!).sort((a, b) => a - b);

  // MIN_PROFIT: use P25 of recent wins as loose floor; scale by win rate
  const p25win  = winningProfits.length > 0 ? percentile(winningProfits, 25) : current.MIN_PROFIT_SOL;
  let newMinProfit = Math.max(0.00005, p25win * 0.85);
  if (emaWin < 0.35) newMinProfit = Math.min(newMinProfit * 1.4, 0.002); // losing streak → raise bar
  if (emaWin > 0.65) newMinProfit = Math.max(newMinProfit * 0.9, 0.00005); // winning → lower bar

  // MIN_SPREAD_BPS: 1.1× the median spread, floor at 4 BPS
  const medianSpread   = spreads.length > 0 ? percentile(spreads, 50) : current.MIN_SPREAD_BPS;
  const newMinSpread   = Math.max(4, Math.round(medianSpread * 1.1));

  // PRIORITY_MICRO_LAMPORTS: scale by win rate. Higher fees on losing streak to fight harder.
  let newPriority = current.PRIORITY_MICRO_LAMPORTS;
  if (emaWin < 0.40) newPriority = Math.min(newPriority * 1.3, 1000000); // 1.3x boost, max 1M
  if (emaWin > 0.70) newPriority = Math.max(newPriority * 0.8, 50000);    // 0.8x reduction, min 50K

  // Clamp changes to ±30% of current to prevent wild swings from outliers
  const clamp = (val: number, prev: number, pct = 0.30) =>
    Math.max(prev * (1 - pct), Math.min(prev * (1 + pct), val));

  const updated: StrategyParams = {
    ...current,
    MIN_PROFIT_SOL: parseFloat(clamp(newMinProfit, current.MIN_PROFIT_SOL).toFixed(6)),
    MIN_SPREAD_BPS: Math.round(clamp(newMinSpread, current.MIN_SPREAD_BPS)),
    PRIORITY_MICRO_LAMPORTS: Math.round(clamp(newPriority, current.PRIORITY_MICRO_LAMPORTS)),
    fastUpdatedAt:  Date.now(),
  };

  saveParams(updated);
  logger.info(`[FAST-TUNER] ✓ MIN_PROFIT: ${updated.MIN_PROFIT_SOL} SOL | MIN_SPREAD: ${updated.MIN_SPREAD_BPS} BPS | PRIORITY: ${updated.PRIORITY_MICRO_LAMPORTS} microL | EMA win: ${(emaWin * 100).toFixed(0)}%`);
}

// ══ SLOW LOOP ════════════════════════════════════════════════════════════════
// Touches: TIP_PERCENTAGE, MAX_SLIPPAGE_BPS, MAX_TRADE_SIZE_SOL, SPLIT_RATIO
// Needs 500-trade window and full Kelly/Sharpe/percentile math.
// Never called on sparse data (guarded by ≥50 trade minimum).
// ─────────────────────────────────────────────────────────────────────────────
function runSlowTune(): void {
  const trades = readTelemetry(SLOW_WINDOW);
  const current = loadStrategyParams();

  if (trades.length < 50) {
    logger.warn(`[SLOW-TUNER] Only ${trades.length} trades — need ≥50 for full calibration. Keeping current slow params.`);
    return;
  }

  const profits = trades.map(t => t.profit_sol);
  const wins    = trades.filter(t => t.success && t.profit_sol > 0);
  const losses  = trades.filter(t => !t.success || t.profit_sol <= 0);

  const winRate = wins.length / trades.length;
  const avgWin  = wins.length  > 0 ? wins.reduce((a, t)  => a + t.profit_sol, 0) / wins.length  : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, t) => a + t.profit_sol, 0) / losses.length) : 0.0001;

  const kellyF  = kellyFraction(winRate, avgWin, avgLoss);
  const sharpe  = sharpeRatio(profits);
  const vol     = stdDev(profits);

  const sorted  = [...profits].sort((a, b) => a - b);
  const p50     = percentile(sorted, 50);
  const p75     = percentile(sorted, 75);

  const spreads = trades.filter(t => t.spread_bps != null).map(t => t.spread_bps!).sort((a, b) => a - b);

  // TIP_PERCENTAGE: Kelly-anchored, Sharpe-adjusted, clamped [0.20, 0.70]
  let newTip = 0.30 + (kellyF * 0.8);
  if (sharpe > 1.5) newTip = Math.min(newTip * 1.2, 0.70);
  if (sharpe < 0.5) newTip = Math.max(newTip * 0.85, 0.20);
  newTip = Math.max(0.20, Math.min(0.70, newTip));

  // MAX_SLIPPAGE_BPS: volatility-driven, clamped [20, 100]
  let newSlippage = current.MAX_SLIPPAGE_BPS;
  if (vol > 0.001)  newSlippage = Math.min(newSlippage + 10, 100);
  if (vol < 0.0002) newSlippage = Math.max(newSlippage - 5,  20);

  // MAX_TRADE_SIZE_SOL: quarter-Kelly of capital ceiling, clamped [0.005, ceiling]
  const CEILING  = parseFloat(process.env.MAX_CAPITAL_SOL || '0.10');
  const newSize  = Math.max(0.005, Math.min(kellyF * CEILING, CEILING));

  // SPLIT_RATIO: balanced (0.50) if median is >60% of P75, else lean to 0.40
  const newSplit = p75 > 0 && p50 / p75 > 0.60 ? 0.50 : 0.40;

  // Clamp all changes to ±25% of current to prevent stat-noise driven lurches
  const clamp = (val: number, prev: number, pct = 0.25) =>
    Math.max(prev * (1 - pct), Math.min(prev * (1 + pct), val));

  const updated: StrategyParams = {
    ...current,
    TIP_PERCENTAGE:     parseFloat(clamp(newTip,      current.TIP_PERCENTAGE,     0.25).toFixed(3)),
    MAX_SLIPPAGE_BPS:   Math.round(clamp(newSlippage, current.MAX_SLIPPAGE_BPS,   0.25)),
    MAX_TRADE_SIZE_SOL: parseFloat(clamp(newSize,     current.MAX_TRADE_SIZE_SOL, 0.25).toFixed(4)),
    SPLIT_RATIO:        parseFloat(newSplit.toFixed(2)),
    slowUpdatedAt:      Date.now(),
  };

  saveParams(updated);

  logger.info(`[SLOW-TUNER] ══ 72h Full Recalibration ════════════════════════`);
  logger.info(`[SLOW-TUNER] Trades: ${trades.length} | Win rate: ${(winRate*100).toFixed(1)}% | Kelly: ${(kellyF*100).toFixed(1)}% | Sharpe: ${sharpe.toFixed(2)} | Vol: ${vol.toFixed(6)}`);
  logger.info(`[SLOW-TUNER] TIP %       : ${(updated.TIP_PERCENTAGE*100).toFixed(1)}%   (was ${(current.TIP_PERCENTAGE*100).toFixed(1)}%)`);
  logger.info(`[SLOW-TUNER] SLIPPAGE    : ${updated.MAX_SLIPPAGE_BPS} BPS  (was ${current.MAX_SLIPPAGE_BPS})`);
  logger.info(`[SLOW-TUNER] TRADE SIZE  : ${updated.MAX_TRADE_SIZE_SOL} SOL (was ${current.MAX_TRADE_SIZE_SOL})`);
  logger.info(`[SLOW-TUNER] SPLIT RATIO : ${(updated.SPLIT_RATIO*100).toFixed(0)}%/${((1-updated.SPLIT_RATIO)*100).toFixed(0)}% (was ${(current.SPLIT_RATIO*100).toFixed(0)}%/${((1-current.SPLIT_RATIO)*100).toFixed(0)}%)`);
  logger.info(`[SLOW-TUNER] ═══════════════════════════════════════════════════`);
}

// ── Public boot function ──────────────────────────────────────────────────────
export function startStrategyTuner(): void {
  logger.info(`[TUNER] Two-speed calibration starting:`);
  logger.info(`[TUNER]   FAST loop → every ${FAST_INTERVAL_MS / 60000} min  (MIN_PROFIT, MIN_SPREAD)`);
  logger.info(`[TUNER]   SLOW loop → every ${SLOW_INTERVAL_MS / 3600000} h  (TIP%, SLIPPAGE, TRADE SIZE, SPLIT)`);

  // Fast: first run after 60s, then every FAST_INTERVAL_MS
  setTimeout(() => {
    runFastTune();
    setInterval(runFastTune, FAST_INTERVAL_MS);
  }, 60_000);

  // Slow: first run after 120s (let fast loop run first), then every SLOW_INTERVAL_MS
  setTimeout(() => {
    runSlowTune();
    setInterval(runSlowTune, SLOW_INTERVAL_MS);
  }, 120_000);
}
