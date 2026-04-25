/**
 * signal_weight_tracker.ts
 *
 * Layer 1 of the Unified Mathematical Trading Framework.
 *
 * Maintains a 24-hour rolling window of signal "impressions" for each source
 * (velocity, wallet, catalyst, trending, gmgn). Computes dynamic weights
 * proportional to each signal's recent accuracy, using Laplace smoothing
 * to handle cold-start. Writes signals/signal_weights.json.
 *
 * Weight formula:  w_i = (correct_i + α) / (total_i + 2α)
 *   where α = 1 (Laplace prior) ensures no weight is ever exactly 0 or 1.
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Types ──────────────────────────────────────────────────────────────────

export type SignalSource = 'velocity' | 'wallet' | 'catalyst' | 'trending' | 'gmgn';

export const ALL_SIGNAL_SOURCES: SignalSource[] = [
  'velocity', 'wallet', 'catalyst', 'trending', 'gmgn',
];

export interface SignalImpression {
  /** Which signal source flagged this token */
  source: SignalSource;
  /** Token mint address */
  mint: string;
  /** Timestamp when the signal was generated */
  signalTs: number;
  /** Whether the token had a positive return within the evaluation window */
  correct: boolean;
}

export interface SignalWeightEntry {
  source: SignalSource;
  correct: number;
  total: number;
  weight: number;
  accuracy: number;
}

export interface SignalWeightsFile {
  updatedAt: number;
  windowHours: number;
  totalImpressions: number;
  weights: Record<SignalSource, SignalWeightEntry>;
}

// ── Core Logic ─────────────────────────────────────────────────────────────

const LAPLACE_ALPHA = 1;           // Smoothing prior
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Compute the Laplace-smoothed weight for a signal source.
 *   weight = (correct + α) / (total + 2α)
 *
 * This ensures:
 *   - With zero data, weight = α / 2α = 0.5 (equal prior)
 *   - Weight asymptotically approaches true accuracy as data grows
 *   - Weight is never exactly 0 or 1
 */
export function computeSignalWeight(correct: number, total: number, alpha: number = LAPLACE_ALPHA): number {
  return (correct + alpha) / (total + 2 * alpha);
}

/**
 * Given a set of impressions within the rolling window, compute weights
 * for all signal sources.
 */
export function computeAllWeights(
  impressions: SignalImpression[],
  windowMs: number = DEFAULT_WINDOW_MS,
): SignalWeightsFile {
  const cutoff = Date.now() - windowMs;
  const recent = impressions.filter(imp => imp.signalTs >= cutoff);

  const counts: Record<SignalSource, { correct: number; total: number }> = {} as any;
  for (const src of ALL_SIGNAL_SOURCES) {
    counts[src] = { correct: 0, total: 0 };
  }

  for (const imp of recent) {
    if (counts[imp.source]) {
      counts[imp.source].total += 1;
      if (imp.correct) counts[imp.source].correct += 1;
    }
  }

  const weights: Record<SignalSource, SignalWeightEntry> = {} as any;
  for (const src of ALL_SIGNAL_SOURCES) {
    const { correct, total } = counts[src];
    const weight = computeSignalWeight(correct, total);
    const accuracy = total > 0 ? correct / total : 0;
    weights[src] = { source: src, correct, total, weight, accuracy };
  }

  return {
    updatedAt: Date.now(),
    windowHours: windowMs / (60 * 60 * 1000),
    totalImpressions: recent.length,
    weights,
  };
}

/**
 * Compute the unified confidence score for a token using the weighted ensemble.
 *
 *   score = Σ(w_i × s_i) / Σ(w_i)
 *
 * where s_i ∈ [0, 1] is the raw signal strength and w_i is the dynamic weight.
 * Normalizing by Σ(w_i) ensures the output is in [0, 1].
 */
export function computeWeightedScore(
  signals: Partial<Record<SignalSource, number>>,
  weights: Record<SignalSource, SignalWeightEntry>,
): { score: number; breakdown: Record<string, number>; totalWeight: number } {
  let weightedSum = 0;
  let totalWeight = 0;
  const breakdown: Record<string, number> = {};

  for (const src of ALL_SIGNAL_SOURCES) {
    const signalValue = signals[src];
    if (signalValue === undefined || signalValue === null) continue;

    const w = weights[src]?.weight ?? 0.5; // fallback to equal prior
    const clamped = Math.max(0, Math.min(1, signalValue));
    weightedSum += w * clamped;
    totalWeight += w;
    breakdown[src] = w * clamped;
  }

  const score = totalWeight > 0 ? weightedSum / totalWeight : 0;
  return { score: Math.max(0, Math.min(1, score)), breakdown, totalWeight };
}

// ── Trade History Extraction ───────────────────────────────────────────────

interface TradeHistoryEntry {
  mint?: string;
  action?: string;
  entrySource?: string;
  entryMode?: string;
  entryFamily?: string;
  pnlSol?: number;
  pnlPct?: number;
  amountSol?: number;
  openedAt?: number;
  closedAt?: number;
  timestamp?: number;
  ts?: number;
  walletSignal?: boolean;
  catalystBoost?: number;
  alphaBoost?: number;
  reason?: string;
}

/**
 * Convert trade history entries into signal impressions.
 * A signal is "correct" if the trade had a positive PnL.
 *
 * Adapts to the actual trade_history.jsonl format which uses:
 *   pnlSol (not pnlPct), entryMode, entryFamily, reason
 */
export function extractImpressions(trades: TradeHistoryEntry[]): SignalImpression[] {
  const impressions: SignalImpression[] = [];

  for (const trade of trades) {
    if (!trade.mint) continue;
    // Only count SELL actions (completed trades with PnL)
    if (trade.action && trade.action !== 'SELL') continue;
    // Get PnL — prefer pnlSol, fall back to pnlPct
    const pnl = trade.pnlSol ?? trade.pnlPct;
    if (pnl === undefined || pnl === null) continue;

    const ts = trade.openedAt || trade.closedAt || trade.timestamp || trade.ts || Date.now();
    const correct = pnl > 0;

    // Velocity — the dominant entry mode
    if (trade.entryMode === 'velocity' || trade.entryMode === 'micro-scout' ||
        trade.entrySource?.includes('velocity')) {
      impressions.push({ source: 'velocity', mint: trade.mint, signalTs: ts, correct });
    }

    // Wallet signal
    if (trade.walletSignal || trade.entryMode === 'wallet' ||
        trade.entrySource?.includes('wallet') || trade.entryFamily?.includes('wallet')) {
      impressions.push({ source: 'wallet', mint: trade.mint, signalTs: ts, correct });
    }

    // Catalyst boost
    if ((trade.catalystBoost ?? 0) > 0) {
      impressions.push({ source: 'catalyst', mint: trade.mint, signalTs: ts, correct });
    }

    // GMGN source
    if (trade.entrySource?.includes('gmgn') || trade.entryFamily?.includes('gmgn')) {
      impressions.push({ source: 'gmgn', mint: trade.mint, signalTs: ts, correct });
    }

    // Trending — from DexScreener trending list
    if (trade.entrySource?.includes('trending') || trade.entrySource?.includes('dex') ||
        trade.entryFamily?.includes('trending')) {
      impressions.push({ source: 'trending', mint: trade.mint, signalTs: ts, correct });
    }
  }

  return impressions;
}

// ── File I/O ───────────────────────────────────────────────────────────────

const SIGNALS_DIR = path.resolve(__dirname, '../../signals');
const WEIGHTS_FILE = path.join(SIGNALS_DIR, 'signal_weights.json');
const TRADE_HISTORY_FILE = path.join(SIGNALS_DIR, 'archive/trade_history.jsonl');

export function loadSignalWeights(): SignalWeightsFile | null {
  try {
    if (!fs.existsSync(WEIGHTS_FILE)) return null;
    return JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveSignalWeights(data: SignalWeightsFile): void {
  try {
    fs.mkdirSync(path.dirname(WEIGHTS_FILE), { recursive: true });
    fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[SIGNAL-WEIGHTS] Failed to write:', err);
  }
}

export function loadTradeHistory(maxLines: number = 5000): TradeHistoryEntry[] {
  try {
    if (!fs.existsSync(TRADE_HISTORY_FILE)) return [];
    const raw = fs.readFileSync(TRADE_HISTORY_FILE, 'utf-8');
    const lines = raw.trim().split('\n');
    // Take the most recent N lines
    const recent = lines.slice(-maxLines);
    return recent
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean) as TradeHistoryEntry[];
  } catch {
    return [];
  }
}

// ── Standalone Runner (PM2 service) ────────────────────────────────────────

export function runWeightUpdate(): void {
  console.log('[SIGNAL-WEIGHTS] Starting weight computation...');

  const trades = loadTradeHistory(5000);
  console.log(`[SIGNAL-WEIGHTS] Loaded ${trades.length} trades from history`);

  const impressions = extractImpressions(trades);
  console.log(`[SIGNAL-WEIGHTS] Extracted ${impressions.length} signal impressions`);

  const result = computeAllWeights(impressions);
  saveSignalWeights(result);

  console.log(`[SIGNAL-WEIGHTS] Updated weights (${result.totalImpressions} impressions in window):`);
  for (const src of ALL_SIGNAL_SOURCES) {
    const w = result.weights[src];
    console.log(`  ${src}: ${(w.weight * 100).toFixed(1)}% weight (${w.correct}/${w.total} correct, ${(w.accuracy * 100).toFixed(1)}% raw accuracy)`);
  }
}

// If run directly as a PM2 service, update weights on a schedule
if (require.main === module) {
  const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  runWeightUpdate(); // Initial run

  setInterval(() => {
    try {
      runWeightUpdate();
    } catch (err) {
      console.error('[SIGNAL-WEIGHTS] Update failed:', err);
    }
  }, INTERVAL_MS);

  console.log(`[SIGNAL-WEIGHTS] Service started. Next update in ${INTERVAL_MS / 60000} minutes.`);
}
