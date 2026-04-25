import fs from 'fs';
import path from 'path';

const { computeCatalystBoost } = require('./catalyst_signal_logic.ts');

type AlphaSignal = {
  source: string;
  type: string;
  timestamp: number;
  token_address: string;
  sentiment_score: number;
  confidence: number;
  kol_reputation_score: number;
  expires_at: number;
  metadata?: Record<string, any>;
};

const SIGNALS_DIR = path.join(process.cwd(), 'signals');
const CATALYST_ALERTS_FILE = path.join(SIGNALS_DIR, 'catalyst_alerts.json');
const WALLET_SIGNALS_FILE = path.join(SIGNALS_DIR, 'wallet_signals.json');

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function loadJsonSafe(filePath: string, fallback: any): any {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

export function loadCatalystSignalsFromFile(filePath = CATALYST_ALERTS_FILE): AlphaSignal[] {
  const doc = loadJsonSafe(filePath, {});
  if (Array.isArray(doc)) return doc;
  if (Array.isArray(doc?.signals)) return doc.signals;
  if (Array.isArray(doc?.activeSignals)) return doc.activeSignals;
  return [];
}

export function loadWalletSignalsFromFile(filePath = WALLET_SIGNALS_FILE): any {
  return loadJsonSafe(filePath, {});
}

function buildWalletAlphaSignals(tokenAddress: string, walletDoc: any, now = Date.now()): AlphaSignal[] {
  const buySignals = Array.isArray(walletDoc?.buy_signals) ? walletDoc.buy_signals : [];
  const normalizedToken = String(tokenAddress || '').trim();
  if (!normalizedToken) return [];
  return buySignals
    .filter((signal: any) => signal?.mint === normalizedToken && signal?.expired !== true)
    .map((signal: any) => {
      const walletCount = Array.isArray(signal?.wallets) ? signal.wallets.length : 0;
      const kolCount = Math.max(0, Number(signal?.kolCount || 0));
      const sentiment = signal?.executable ? 0.8 : 0.55;
      const confidence = clamp(Number(signal?.consensusScore || signal?.walletPnlScore || 0.35), 0.1, 1);
      const reputation = clamp(
        Math.max(
          Number(signal?.avgWalletWinRate || 0),
          Number(signal?.walletPnlScore || 0),
          kolCount > 0 ? 0.55 : 0,
        ),
        0,
        1,
      );
      const boost = clamp(
        (walletCount * 0.03) +
        (kolCount * 0.04) +
        (confidence * 0.08) +
        (signal?.sizeUp ? 0.05 : 0),
        0.04,
        0.22,
      );
      return {
        source: 'wallet-alpha',
        type: 'WALLET_CONSENSUS',
        timestamp: Number(signal?.lastSeenMs || signal?.firstSeenMs || now),
        token_address: normalizedToken,
        sentiment_score: sentiment,
        confidence,
        kol_reputation_score: reputation,
        expires_at: now + 15 * 60_000,
        metadata: {
          boost,
          walletCount,
          kolCount,
          conviction: signal?.conviction,
          consensusScore: signal?.consensusScore,
          sizeUp: Boolean(signal?.sizeUp),
          signalKey: `wallet:${normalizedToken}:${String(signal?.priority || 'info').toLowerCase()}`,
        },
      } satisfies AlphaSignal;
    });
}

export function computeAlphaBoost(args: {
  tokenAddress: string;
  now?: number;
  catalystSignalsFile?: string;
  walletSignalsFile?: string;
}) {
  const now = Number(args.now || Date.now());
  const tokenAddress = String(args.tokenAddress || '').trim();
  const catalystSignals = loadCatalystSignalsFromFile(args.catalystSignalsFile);
  const catalystDecision = computeCatalystBoost(tokenAddress, catalystSignals, now);
  const walletDoc = loadWalletSignalsFromFile(args.walletSignalsFile);
  const walletSignals = buildWalletAlphaSignals(tokenAddress, walletDoc, now);
  const walletBoost = clamp(
    Number(
      walletSignals.reduce((sum, signal) => sum + Number(signal?.metadata?.boost || 0), 0).toFixed(4),
    ),
    0,
    0.25,
  );
  const combinedSignals = [...catalystDecision.activeSignals, ...walletSignals];
  const averageSentiment = combinedSignals.length
    ? Number(
        (
          combinedSignals.reduce((sum, signal) => sum + Number(signal.sentiment_score || 0), 0) /
          combinedSignals.length
        ).toFixed(4),
      )
    : 0;
  const uniqueKols = walletSignals.reduce(
    (sum, signal) => sum + Math.max(0, Number(signal?.metadata?.kolCount || 0)),
    0,
  );
  const totalBoost = clamp(Number((catalystDecision.totalBoost + walletBoost).toFixed(4)), -0.3, 0.75);
  return {
    totalBoost,
    catalystBoost: catalystDecision.totalBoost,
    walletBoost,
    averageSentiment,
    uniqueKols,
    signalCount: combinedSignals.length,
    catalystSignalCount: catalystDecision.activeSignals.length,
    walletSignalCount: walletSignals.length,
    signals: combinedSignals,
  };
}

// ── Layer 1 Integration: Unified Weighted Ensemble Score ───────────────────

const SIGNAL_WEIGHTS_FILE = path.join(SIGNALS_DIR, 'signal_weights.json');
const REGIME_STATE_FILE = path.join(SIGNALS_DIR, 'regime_state.json');

type SignalSource = 'velocity' | 'wallet' | 'catalyst' | 'trending' | 'gmgn';

interface SignalWeightEntry {
  source: SignalSource;
  correct: number;
  total: number;
  weight: number;
  accuracy: number;
}

interface SignalWeightsFile {
  updatedAt: number;
  windowHours: number;
  totalImpressions: number;
  weights: Record<SignalSource, SignalWeightEntry>;
}

function loadSignalWeightsFile(): SignalWeightsFile | null {
  return loadJsonSafe(SIGNAL_WEIGHTS_FILE, null);
}

function loadRegimeState(): { kellyMultiplier: number; label: string } | null {
  return loadJsonSafe(REGIME_STATE_FILE, null);
}

const DEFAULT_WEIGHTS: Record<SignalSource, SignalWeightEntry> = {
  velocity: { source: 'velocity', correct: 0, total: 0, weight: 0.5, accuracy: 0 },
  wallet:   { source: 'wallet',   correct: 0, total: 0, weight: 0.5, accuracy: 0 },
  catalyst: { source: 'catalyst', correct: 0, total: 0, weight: 0.5, accuracy: 0 },
  trending: { source: 'trending', correct: 0, total: 0, weight: 0.5, accuracy: 0 },
  gmgn:     { source: 'gmgn',     correct: 0, total: 0, weight: 0.5, accuracy: 0 },
};

/**
 * Compute the unified probability score using the weighted ensemble.
 *
 * Fuses velocity, wallet, catalyst, trending, and gmgn signal strengths
 * into a single [0, 1] probability suitable for Kelly sizing.
 *
 *   score = Σ(w_i × s_i) / Σ(w_i)
 */
export function computeUnifiedScore(args: {
  tokenAddress: string;
  /** Velocity signal strength [0, 1] based on buy ratio, tx rate */
  velocityStrength?: number;
  /** Whether the token has a wallet alpha signal */
  hasWalletSignal?: boolean;
  /** DexScreener trending signal strength [0, 1] */
  trendingStrength?: number;
  /** GMGN source signal strength [0, 1] */
  gmgnStrength?: number;
  /** Pre-computed alpha boost result (from computeAlphaBoost) */
  alphaBoost?: ReturnType<typeof computeAlphaBoost>;
  now?: number;
}) {
  const weightsFile = loadSignalWeightsFile();
  const weights = weightsFile?.weights ?? DEFAULT_WEIGHTS;
  const regimeState = loadRegimeState();

  // Build signal strength map [0, 1] for each source
  const signals: Partial<Record<SignalSource, number>> = {};

  if (args.velocityStrength !== undefined && args.velocityStrength !== null) {
    signals.velocity = clamp(args.velocityStrength, 0, 1);
  }

  // Wallet: binary + boost magnitude
  const alpha = args.alphaBoost ?? computeAlphaBoost({
    tokenAddress: args.tokenAddress,
    now: args.now,
  });

  if (args.hasWalletSignal || alpha.walletBoost > 0) {
    signals.wallet = clamp(alpha.walletBoost / 0.25, 0, 1); // normalize 0-0.25 → 0-1
  }

  if (alpha.catalystBoost !== 0) {
    signals.catalyst = clamp((alpha.catalystBoost + 0.3) / 0.6, 0, 1); // normalize -0.3..0.3 → 0..1
  }

  if (args.trendingStrength !== undefined) {
    signals.trending = clamp(args.trendingStrength, 0, 1);
  }

  if (args.gmgnStrength !== undefined) {
    signals.gmgn = clamp(args.gmgnStrength, 0, 1);
  }

  // Compute weighted ensemble
  let weightedSum = 0;
  let totalWeight = 0;
  const breakdown: Record<string, { signal: number; weight: number; contribution: number }> = {};

  const ALL_SOURCES: SignalSource[] = ['velocity', 'wallet', 'catalyst', 'trending', 'gmgn'];
  for (const src of ALL_SOURCES) {
    const signalValue = signals[src];
    if (signalValue === undefined || signalValue === null) continue;

    const w = weights[src]?.weight ?? 0.5;
    weightedSum += w * signalValue;
    totalWeight += w;
    breakdown[src] = { signal: signalValue, weight: w, contribution: w * signalValue };
  }

  const ensembleScore = totalWeight > 0 ? clamp(weightedSum / totalWeight, 0, 1) : 0;

  return {
    /** Unified probability score [0, 1] — use as Kelly win probability */
    ensembleScore,
    /** Per-signal breakdown for logging */
    breakdown,
    /** Number of active signals in the ensemble */
    activeSignalCount: Object.keys(breakdown).length,
    /** Total weight sum (higher = more confident ensemble) */
    totalWeight,
    /** Regime state if available */
    regimeLabel: regimeState?.label ?? 'UNKNOWN',
    regimeMultiplier: regimeState?.kellyMultiplier ?? 1.0,
    /** Pass-through: the original alpha boost data */
    alphaBoost: alpha,
    /** Signal weights file age */
    weightsAge: weightsFile ? Date.now() - weightsFile.updatedAt : null,
  };
}

module.exports = {
  loadCatalystSignalsFromFile,
  loadWalletSignalsFromFile,
  computeAlphaBoost,
  computeUnifiedScore,
};
