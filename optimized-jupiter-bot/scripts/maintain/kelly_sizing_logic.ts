/**
 * kelly_sizing_logic.ts
 *
 * Layer 2 of the Unified Mathematical Trading Framework.
 *
 * Implements Fractional Kelly Criterion with ATR-based volatility adjustment
 * for dynamic position sizing. Replaces fixed buySol with a mathematically
 * optimal size that scales with conviction and market volatility.
 *
 * Kelly formula: f* = (p × b − (1 − p)) / b
 *   p = win probability (from Layer 1 ensemble score)
 *   b = win/loss ratio (average win / average loss from trade history)
 *   f* = optimal fraction of bankroll to bet
 *
 * We use Half-Kelly (f* × 0.5) for safety in volatile crypto markets.
 */

export type MaybeNumber = number | null | undefined;

function toFinite(v: MaybeNumber, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface KellySizingInput {
  /** Win probability from weighted ensemble [0, 1] */
  winProbability: number;

  /** Average win / average loss ratio (e.g. 1.5 means wins are 1.5× losses) */
  winLossRatio: number;

  /** Current bankroll in SOL */
  bankrollSol: number;

  /** Current ATR as a percentage (e.g. 5.0 means 5% typical range) */
  atrPct: number;

  /** ATR multiplier for stop distance (default: 2.0) */
  atrMultiplier?: number;

  /** Fractional Kelly scaling (default: 0.5 for half-Kelly) */
  kellyFraction?: number;

  /** Regime multiplier from Layer 3 (default: 1.0) */
  regimeMultiplier?: number;

  /** Minimum position size in SOL */
  minSizeSol?: number;

  /** Maximum position size in SOL (hard cap) */
  maxSizeSol?: number;

  /** Reserve SOL to keep untouched */
  reserveSol?: number;
}

export interface KellySizingResult {
  /** Recommended position size in SOL */
  sizeSol: number;

  /** Raw Kelly fraction before adjustments */
  rawKellyFraction: number;

  /** Adjusted Kelly fraction (half-Kelly × regime) */
  adjustedKellyFraction: number;

  /** Stop distance as percentage */
  stopDistancePct: number;

  /** Whether the trade should be skipped (no edge) */
  skipTrade: boolean;

  /** Human-readable reason if skipped */
  skipReason: string | null;

  /** Breakdown for logging */
  breakdown: {
    winProb: number;
    winLossRatio: number;
    bankroll: number;
    atrPct: number;
    regimeMultiplier: number;
  };
}

// ── Core Kelly Computation ─────────────────────────────────────────────────

/**
 * Compute the raw Kelly fraction.
 *   f* = (p × b − (1 − p)) / b
 *
 * where p = win probability, b = win/loss ratio.
 *
 * If f* ≤ 0, the system has no mathematical edge and should not trade.
 */
export function computeRawKelly(winProbability: number, winLossRatio: number): number {
  if (winLossRatio <= 0) return 0;
  const p = clamp(winProbability, 0, 1);
  const b = winLossRatio;
  return (p * b - (1 - p)) / b;
}

/**
 * Compute the full Kelly position size with all adjustments.
 */
export function computeKellySize(input: KellySizingInput): KellySizingResult {
  const p = clamp(toFinite(input.winProbability), 0, 1);
  const b = Math.max(0.01, toFinite(input.winLossRatio, 1));
  const bankroll = Math.max(0, toFinite(input.bankrollSol));
  const atrPct = Math.max(0.1, toFinite(input.atrPct, 5));
  const atrMultiplier = toFinite(input.atrMultiplier, 2.0);
  const kellyScale = clamp(toFinite(input.kellyFraction, 0.5), 0.1, 1.0);
  const regimeMult = clamp(toFinite(input.regimeMultiplier, 1.0), 0.1, 2.0);
  const minSize = toFinite(input.minSizeSol, 0.001);
  const maxSize = toFinite(input.maxSizeSol, 0.05);
  const reserve = toFinite(input.reserveSol, 0.05);

  const rawKelly = computeRawKelly(p, b);

  // No edge — skip trade
  if (rawKelly <= 0) {
    return {
      sizeSol: 0,
      rawKellyFraction: rawKelly,
      adjustedKellyFraction: 0,
      stopDistancePct: atrPct * atrMultiplier,
      skipTrade: true,
      skipReason: `No mathematical edge (f*=${rawKelly.toFixed(4)}, p=${p.toFixed(3)}, b=${b.toFixed(2)})`,
      breakdown: { winProb: p, winLossRatio: b, bankroll, atrPct, regimeMultiplier: regimeMult },
    };
  }

  // Apply fractional Kelly and regime adjustment
  const adjustedKelly = rawKelly * kellyScale * regimeMult;

  // Stop distance from ATR
  const stopDistancePct = atrPct * atrMultiplier;

  // Position size: (bankroll × adjusted_kelly) / (stop_distance / 100)
  // This ensures we risk a Kelly-optimal fraction of bankroll per unit of volatility
  const deployable = Math.max(0, bankroll - reserve);
  const rawSize = deployable > 0 && stopDistancePct > 0
    ? (deployable * adjustedKelly) / (stopDistancePct / 100)
    : 0;

  // Clamp to min/max
  const finalSize = clamp(rawSize, 0, maxSize);

  // Too small to trade
  if (finalSize < minSize) {
    return {
      sizeSol: 0,
      rawKellyFraction: rawKelly,
      adjustedKellyFraction: adjustedKelly,
      stopDistancePct,
      skipTrade: true,
      skipReason: `Size ${finalSize.toFixed(6)} SOL below min ${minSize.toFixed(4)} SOL`,
      breakdown: { winProb: p, winLossRatio: b, bankroll, atrPct, regimeMultiplier: regimeMult },
    };
  }

  return {
    sizeSol: Number(finalSize.toFixed(6)),
    rawKellyFraction: rawKelly,
    adjustedKellyFraction: adjustedKelly,
    stopDistancePct,
    skipTrade: false,
    skipReason: null,
    breakdown: { winProb: p, winLossRatio: b, bankroll, atrPct, regimeMultiplier: regimeMult },
  };
}

// ── Trade History Helpers ──────────────────────────────────────────────────

export interface TradeOutcome {
  pnlPct: number;
}

/**
 * Compute the average win/loss ratio from recent trade history.
 * Returns the ratio of average winning trade size to average losing trade size.
 * Falls back to 1.0 (even odds) if insufficient data.
 */
export function computeWinLossRatio(trades: TradeOutcome[], minSampleSize: number = 10): number {
  const wins = trades.filter(t => t.pnlPct > 0).map(t => t.pnlPct);
  const losses = trades.filter(t => t.pnlPct < 0).map(t => Math.abs(t.pnlPct));

  if (wins.length < minSampleSize / 2 || losses.length < minSampleSize / 2) {
    return 1.0; // Insufficient data, assume even odds
  }

  const avgWin = wins.reduce((a, b) => a + b, 0) / wins.length;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / losses.length;

  if (avgLoss <= 0) return 3.0; // Cap at 3x if no losses (unlikely)
  return clamp(avgWin / avgLoss, 0.1, 10.0);
}

/**
 * Compute a synthetic ATR percentage from available price data.
 * Uses the standard deviation of recent 5m price changes as a volatility proxy.
 */
export function computeSyntheticAtrPct(priceChanges5m: number[]): number {
  if (priceChanges5m.length < 3) return 5.0; // Default 5% if no data

  const n = priceChanges5m.length;
  const mean = priceChanges5m.reduce((a, b) => a + b, 0) / n;
  const variance = priceChanges5m.reduce((sum, x) => sum + (x - mean) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);

  // ATR ≈ 1.5× standard deviation of returns (approximation)
  return clamp(stdDev * 1.5, 0.5, 50.0);
}
