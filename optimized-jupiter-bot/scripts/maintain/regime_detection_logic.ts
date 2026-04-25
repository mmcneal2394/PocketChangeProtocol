/**
 * regime_detection_logic.ts
 *
 * Layer 3 of the Unified Mathematical Trading Framework.
 *
 * Detects the current market volatility regime by comparing short-term
 * ATR to long-term ATR. Outputs a multiplier that scales Kelly sizing:
 *   HIGH_VOL → reduce size (0.5×)
 *   NORMAL   → no change (1.0×)
 *   LOW_VOL  → slight increase (1.2×)
 *
 * This approximates a Hidden Markov Model regime detector using a simple
 * volatility ratio that's computable from existing data.
 */

export type MaybeNumber = number | null | undefined;

function toFinite(v: MaybeNumber, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

// ── Types ──────────────────────────────────────────────────────────────────

export type RegimeLabel = 'HIGH_VOL' | 'NORMAL' | 'LOW_VOL';

export interface RegimeDetectionInput {
  /** Current ATR (short-term, e.g. 14-period) */
  currentAtr: number;

  /** Long-term ATR (e.g. 50-period rolling average) */
  longTermAtr: number;

  /** Threshold above which regime is HIGH_VOL (default: 1.3) */
  highVolThreshold?: number;

  /** Threshold below which regime is LOW_VOL (default: 0.8) */
  lowVolThreshold?: number;

  /** Kelly multiplier for HIGH_VOL regime (default: 0.5) */
  highVolMultiplier?: number;

  /** Kelly multiplier for LOW_VOL regime (default: 1.2) */
  lowVolMultiplier?: number;
}

export interface RegimeDetectionResult {
  /** Regime classification */
  label: RegimeLabel;

  /** Raw ratio: currentAtr / longTermAtr */
  regimeFactor: number;

  /** Multiplier to apply to Kelly sizing */
  kellyMultiplier: number;

  /** Human-readable description */
  description: string;
}

// ── Core Logic ─────────────────────────────────────────────────────────────

/**
 * Detect the current volatility regime.
 *
 *   regimeFactor = currentAtr / longTermAtr
 *
 *   > highVolThreshold (1.3)  → HIGH_VOL  → reduce Kelly by 0.5×
 *   < lowVolThreshold  (0.8)  → LOW_VOL   → increase Kelly by 1.2×
 *   else                      → NORMAL    → 1.0×
 */
export function detectRegime(input: RegimeDetectionInput): RegimeDetectionResult {
  const current = Math.max(0.001, toFinite(input.currentAtr, 5));
  const longTerm = Math.max(0.001, toFinite(input.longTermAtr, 5));
  const highThresh = toFinite(input.highVolThreshold, 1.3);
  const lowThresh = toFinite(input.lowVolThreshold, 0.8);
  const highMult = clamp(toFinite(input.highVolMultiplier, 0.5), 0.1, 1.0);
  const lowMult = clamp(toFinite(input.lowVolMultiplier, 1.2), 1.0, 2.0);

  const regimeFactor = current / longTerm;

  if (regimeFactor > highThresh) {
    return {
      label: 'HIGH_VOL',
      regimeFactor,
      kellyMultiplier: highMult,
      description: `High volatility (${regimeFactor.toFixed(2)}× normal). Reducing position sizes.`,
    };
  }

  if (regimeFactor < lowThresh) {
    return {
      label: 'LOW_VOL',
      regimeFactor,
      kellyMultiplier: lowMult,
      description: `Low volatility (${regimeFactor.toFixed(2)}× normal). Slightly larger positions OK.`,
    };
  }

  return {
    label: 'NORMAL',
    regimeFactor,
    kellyMultiplier: 1.0,
    description: `Normal volatility (${regimeFactor.toFixed(2)}× baseline).`,
  };
}

// ── ATR Rolling Average ────────────────────────────────────────────────────

/**
 * Maintain a rolling ATR buffer and compute both current and long-term ATR.
 *
 * Called every time a new 5m candle completes. Stores the last 50 ATR values.
 */
export interface AtrBuffer {
  /** Last N ATR values (most recent last) */
  values: number[];
  /** Max buffer size */
  maxSize: number;
}

export function createAtrBuffer(maxSize: number = 50): AtrBuffer {
  return { values: [], maxSize };
}

export function pushAtr(buffer: AtrBuffer, atrValue: number): AtrBuffer {
  const newValues = [...buffer.values, atrValue];
  if (newValues.length > buffer.maxSize) {
    newValues.splice(0, newValues.length - buffer.maxSize);
  }
  return { ...buffer, values: newValues };
}

/**
 * Get current (short-term, last 14) and long-term (all) ATR from buffer.
 */
export function getAtrStats(buffer: AtrBuffer, shortPeriod: number = 14): {
  currentAtr: number;
  longTermAtr: number;
  sampleCount: number;
} {
  if (buffer.values.length === 0) {
    return { currentAtr: 5.0, longTermAtr: 5.0, sampleCount: 0 };
  }

  const allMean = buffer.values.reduce((a, b) => a + b, 0) / buffer.values.length;

  const shortSlice = buffer.values.slice(-shortPeriod);
  const shortMean = shortSlice.reduce((a, b) => a + b, 0) / shortSlice.length;

  return {
    currentAtr: shortMean,
    longTermAtr: allMean,
    sampleCount: buffer.values.length,
  };
}

// ── Regime State Persistence ───────────────────────────────────────────────

export interface RegimeState {
  updatedAt: number;
  label: RegimeLabel;
  regimeFactor: number;
  kellyMultiplier: number;
  atrBuffer: number[];
  sampleCount: number;
}
