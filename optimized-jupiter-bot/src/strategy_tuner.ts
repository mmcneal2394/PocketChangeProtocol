/**
 * strategy_tuner.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * 72-Hour Auto-Calibration Engine
 *
 * Every 3 days (configurable via TUNE_INTERVAL_HOURS), this module reads the
 * last N trade outcomes from trades.db / telemetry logs, then recalculates
 * optimal values for the core strategy parameters using:
 *
 *   1. Kelly Criterion  — optimal fraction of capital to risk per trade
 *   2. EMA Win-Rate     — exponential moving average of recent win rate
 *   3. Sharpe Ratio     — risk-adjusted return signal for tip %, slippage
 *   4. Percentile BPS   — 25th/50th/75th profit spread for threshold setting
 *   5. Volatility Band  — rolling std-dev on profit used to gate trade size
 *
 * Output is written to strategy_params.json which config.ts reads on restart,
 * AND emitted as a log event visible in the admin panel's live log stream.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import path from 'path';
import { logger } from './utils/logger';

// ── Tuning interval ──────────────────────────────────────────────────────────
const TUNE_INTERVAL_MS  = (parseInt(process.env.TUNE_INTERVAL_HOURS || '72')) * 60 * 60 * 1000;
const PARAMS_PATH       = path.join(__dirname, '..', 'strategy_params.json');
const TELEMETRY_PATHS   = [
  path.join(__dirname, '..', 'engine-worker', 'telemetry.jsonl'),
  path.join(process.cwd(), 'engine-worker', 'telemetry.jsonl'),
  path.join(process.cwd(), 'telemetry.jsonl'),
];

// ── Default safe parameters (used when no history available) ─────────────────
export const DEFAULT_PARAMS = {
  MIN_PROFIT_SOL:   0.0001,   // Minimum net profit to execute a trade
  TIP_PERCENTAGE:   0.50,     // Fraction of gross profit paid as Jito tip
  MAX_SLIPPAGE_BPS: 50,       // Max tolerable slippage in basis points
  MAX_TRADE_SIZE_SOL: 0.02,   // Capital committed per swap
  SPLIT_RATIO:      0.50,     // Fraction of tokens routed to first sell DEX
  MIN_SPREAD_BPS:   8,        // Minimum spread in BPS to even consider a route
  updatedAt:        0,
};

export type StrategyParams = typeof DEFAULT_PARAMS;

// ── Load current params from disk (or defaults) ───────────────────────────────
export function loadStrategyParams(): StrategyParams {
  try {
    if (fs.existsSync(PARAMS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(PARAMS_PATH, 'utf-8'));
      return { ...DEFAULT_PARAMS, ...raw };
    }
  } catch (e: any) {
    logger.warn(`[TUNER] Could not read strategy_params.json: ${e.message}`);
  }
  return { ...DEFAULT_PARAMS };
}

// ── Read latest N trade outcomes from telemetry ───────────────────────────────
interface TradeRecord {
  success: boolean;
  profit_sol: number;
  spread_bps?: number;
  route?: string;
}

function readTelemetry(maxRows = 500): TradeRecord[] {
  for (const p of TELEMETRY_PATHS) {
    if (!fs.existsSync(p)) continue;
    try {
      const lines = fs.readFileSync(p, 'utf-8').trim().split('\n');
      return lines
        .filter(l => l.length > 5)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean)
        .slice(-maxRows) as TradeRecord[];
    } catch { continue; }
  }
  return [];
}

// ── Math helpers ──────────────────────────────────────────────────────────────

/** Exponential Moving Average (α = 2/(N+1)) */
function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const alpha = 2 / (period + 1);
  let result = values[0];
  for (let i = 1; i < values.length; i++) {
    result = alpha * values[i] + (1 - alpha) * result;
  }
  return result;
}

/** Population standard deviation */
function stdDev(values: number[]): number {
  if (values.length <= 1) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Percentile (linear interpolation) */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const low = Math.floor(idx);
  const high = Math.ceil(idx);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (idx - low);
}

/**
 * Kelly Criterion for binary outcomes:
 *   f* = (p * b - q) / b
 *   where p = win probability, q = 1 - p, b = avg_win / avg_loss
 *   Returns a fraction in [0, 0.25] (quarter-Kelly for safety)
 */
function kellyFraction(winRate: number, avgWin: number, avgLoss: number): number {
  if (avgLoss <= 0 || avgWin <= 0) return 0.05;
  const b = avgWin / avgLoss;
  const q = 1 - winRate;
  const kelly = (winRate * b - q) / b;
  // Apply quarter-Kelly and clamp to sane range [0.01, 0.25]
  return Math.max(0.01, Math.min(0.25, kelly * 0.25));
}

/**
 * Sharpe Ratio (annualised proxy, using trade-level returns)
 * Used to determine if increasing tip / slippage is justified.
 */
function sharpeRatio(returns: number[], riskFreeRate = 0): number {
  if (returns.length < 5) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sd   = stdDev(returns);
  if (sd === 0) return 0;
  return (mean - riskFreeRate) / sd;
}

// ── Core calibration logic ────────────────────────────────────────────────────
export function calibrate(trades: TradeRecord[]): StrategyParams {
  const current = loadStrategyParams();

  if (trades.length < 10) {
    logger.warn('[TUNER] Insufficient trade history (<10 records) — keeping current params.');
    return { ...current, updatedAt: Date.now() };
  }

  const profits   = trades.map(t => t.profit_sol);
  const wins      = trades.filter(t => t.success && t.profit_sol > 0);
  const losses    = trades.filter(t => !t.success || t.profit_sol <= 0);

  const winRate   = wins.length / trades.length;
  const avgWin    = wins.length  > 0 ? wins.reduce((a, t)  => a + t.profit_sol, 0) / wins.length  : 0;
  const avgLoss   = losses.length > 0 ? Math.abs(losses.reduce((a, t) => a + t.profit_sol, 0) / losses.length) : 0.0001;

  // 1. EMA of win rate over last 20 trades (responsive to recent shifts)
  const recentWins = trades.slice(-20).map(t => t.success ? 1 : 0);
  const emaWinRate = ema(recentWins, 10);

  // 2. Kelly → optimal trade size fraction
  const kellyF    = kellyFraction(winRate, avgWin, avgLoss);

  // 3. Sharpe → risk signal
  const sharpe    = sharpeRatio(profits);

  // 4. Profit percentiles (sorted)
  const sortedProfits = [...profits].sort((a, b) => a - b);
  const p25 = percentile(sortedProfits, 25);
  const p50 = percentile(sortedProfits, 50);  // median
  const p75 = percentile(sortedProfits, 75);

  // 5. Volatility
  const vol = stdDev(profits);

  // ── Derive new params ─────────────────────────────────────────────────────

  // MIN_PROFIT_SOL: use the 25th percentile of positive profits as the floor.
  // If win rate is low (<40%), raise the bar; if high (>65%), lower it.
  let newMinProfit = Math.max(0.00005, p25 > 0 ? p25 * 0.8 : current.MIN_PROFIT_SOL);
  if (emaWinRate < 0.40) newMinProfit = Math.min(newMinProfit * 1.5, 0.002); // raise threshold when losing
  if (emaWinRate > 0.65) newMinProfit = Math.max(newMinProfit * 0.8, 0.00005); // lower threshold when winning

  // TIP_PERCENTAGE: Kelly-derived. High Sharpe → can pay more; low → be stingier.
  let newTipPct = 0.30 + (kellyF * 0.8); // ranges from ~0.30 to ~0.50
  if (sharpe > 1.5)  newTipPct = Math.min(newTipPct * 1.2, 0.65); // strong signal → tip more
  if (sharpe < 0.5)  newTipPct = Math.max(newTipPct * 0.85, 0.25); // weak signal → tip less
  newTipPct = Math.max(0.20, Math.min(0.70, newTipPct));

  // MAX_SLIPPAGE_BPS: tighten in volatile periods, loosen in stable ones.
  let newSlippage = current.MAX_SLIPPAGE_BPS;
  if (vol > 0.001) newSlippage = Math.min(newSlippage + 10, 100); // high vol → allow more slip
  if (vol < 0.0002) newSlippage = Math.max(newSlippage - 5, 20); // low vol → tighten slip

  // MAX_TRADE_SIZE_SOL: Kelly fraction × a safe capital ceiling (0.1 SOL max for now)
  const CAPITAL_CEILING = parseFloat(process.env.MAX_CAPITAL_SOL || '0.10');
  const newTradeSize = Math.max(0.005, Math.min(kellyF * CAPITAL_CEILING, CAPITAL_CEILING));

  // SPLIT_RATIO: If 3-hop performs better than split, lean toward 50/50.
  // Simple heuristic: if median profit > 75th / 2, balanced split is fine.
  const newSplitRatio = p75 > 0 && p50 / p75 > 0.6 ? 0.50 : 0.40;

  // MIN_SPREAD_BPS: 1.2× the 25th percentile spread, or at least 5 BPS.
  const spreads = trades.filter(t => t.spread_bps != null).map(t => t.spread_bps!);
  const medianSpread = spreads.length > 0 ? percentile([...spreads].sort((a, b) => a - b), 50) : 8;
  const newMinSpread = Math.max(5, Math.round(medianSpread * 1.2));

  const newParams: StrategyParams = {
    MIN_PROFIT_SOL:     parseFloat(newMinProfit.toFixed(6)),
    TIP_PERCENTAGE:     parseFloat(newTipPct.toFixed(3)),
    MAX_SLIPPAGE_BPS:   Math.round(newSlippage),
    MAX_TRADE_SIZE_SOL: parseFloat(newTradeSize.toFixed(4)),
    SPLIT_RATIO:        parseFloat(newSplitRatio.toFixed(2)),
    MIN_SPREAD_BPS:     newMinSpread,
    updatedAt:          Date.now(),
  };

  logger.info(`[TUNER] ── 72h Calibration Complete ──────────────────────────`);
  logger.info(`[TUNER] Trades analysed   : ${trades.length} (wins: ${wins.length} | losses: ${losses.length})`);
  logger.info(`[TUNER] Win rate (EMA-10) : ${(emaWinRate * 100).toFixed(1)}%`);
  logger.info(`[TUNER] Kelly fraction    : ${(kellyF * 100).toFixed(1)}%`);
  logger.info(`[TUNER] Sharpe ratio      : ${sharpe.toFixed(3)}`);
  logger.info(`[TUNER] P50 profit        : ${p50.toFixed(6)} SOL  |  Volatility: ${vol.toFixed(6)}`);
  logger.info(`[TUNER] NEW MIN_PROFIT    : ${newParams.MIN_PROFIT_SOL} SOL  (was ${current.MIN_PROFIT_SOL})`);
  logger.info(`[TUNER] NEW TIP %         : ${(newParams.TIP_PERCENTAGE * 100).toFixed(1)}%   (was ${(current.TIP_PERCENTAGE * 100).toFixed(1)}%)`);
  logger.info(`[TUNER] NEW SLIPPAGE      : ${newParams.MAX_SLIPPAGE_BPS} BPS (was ${current.MAX_SLIPPAGE_BPS})`);
  logger.info(`[TUNER] NEW TRADE SIZE    : ${newParams.MAX_TRADE_SIZE_SOL} SOL (was ${current.MAX_TRADE_SIZE_SOL})`);
  logger.info(`[TUNER] NEW SPLIT RATIO   : ${(newParams.SPLIT_RATIO * 100).toFixed(0)}% / ${((1 - newParams.SPLIT_RATIO) * 100).toFixed(0)}%`);
  logger.info(`[TUNER] ─────────────────────────────────────────────────────`);

  return newParams;
}

// ── Persist to disk ──────────────────────────────────────────────────────────
function saveParams(params: StrategyParams): void {
  try {
    fs.writeFileSync(PARAMS_PATH, JSON.stringify(params, null, 2), 'utf-8');
    logger.info(`[TUNER] Parameters saved → ${PARAMS_PATH}`);
  } catch (e: any) {
    logger.error(`[TUNER] Failed to save params: ${e.message}`);
  }
}

// ── Scheduled loop — runs every TUNE_INTERVAL_MS ─────────────────────────────
export function startStrategyTuner(): void {
  const intervalHours = TUNE_INTERVAL_MS / (1000 * 60 * 60);
  logger.info(`[TUNER] Strategy auto-calibration scheduled every ${intervalHours}h`);

  const run = () => {
    logger.info('[TUNER] Starting 72h parameter recalibration...');
    const trades  = readTelemetry(500);
    const params  = calibrate(trades);
    saveParams(params);
  };

  // Run once at startup (after 60s delay to let engine warm up)
  setTimeout(run, 60_000);

  // Then on schedule
  setInterval(run, TUNE_INTERVAL_MS);
}
