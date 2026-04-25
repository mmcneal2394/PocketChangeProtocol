type MaybeNumber = number | null | undefined;

export interface FamilyTradeLike {
  action?: string | null;
  partialExit?: boolean | null;
  entryFamily?: string | null;
  entry_family?: string | null;
  sourceLane?: string | null;
  source_lane?: string | null;
  entryMode?: string | null;
  entry_mode?: string | null;
  probeLikeEntry?: boolean | null;
  routeLiveFastTrack?: boolean | null;
  pnlSol?: MaybeNumber;
  ts?: MaybeNumber;
  timestamp?: MaybeNumber;
  closedAt?: MaybeNumber;
  openedAt?: MaybeNumber;
}

export interface FamilyTradeSample {
  ts: number;
  pnlSol: number;
}

export interface FamilyPerformanceBucket {
  family: string;
  recent: FamilyTradeSample[];
}

export interface FamilyPerformanceMemory {
  [family: string]: FamilyPerformanceBucket;
}

export interface FamilyPerformanceConfig {
  maxHistory: number;
  recentTradeWindow: number;
  minTradeCountForGate: number;
  minWinRate: number;
  reducedSizeMultiplier: number;
  disableNetSolThreshold: number;
}

export interface FamilyPerformanceDecision {
  family: string;
  sampleCount: number;
  recentWinRate: number;
  recentNetSol: number;
  disabled: boolean;
  sizeMultiplier: number;
  reason: string | null;
}

const DEFAULT_CONFIG: FamilyPerformanceConfig = {
  maxHistory: 50,
  recentTradeWindow: 20,
  minTradeCountForGate: 20,
  minWinRate: 0.30,
  reducedSizeMultiplier: 0.5,
  disableNetSolThreshold: -0.01,
};

function toFiniteNumber(value: MaybeNumber, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toBoolean(value: any): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

export function normalizeEntryFamily(row: FamilyTradeLike | null | undefined): string {
  const explicit = String(row?.entryFamily || row?.entry_family || '').trim().toLowerCase();
  if (explicit) return explicit;

  const sourceLane = String(row?.sourceLane || row?.source_lane || '').trim().toLowerCase();
  const entryMode = String(row?.entryMode || row?.entry_mode || '').trim().toLowerCase();
  const probeLike = toBoolean(row?.probeLikeEntry);
  const fastTrack = toBoolean(row?.routeLiveFastTrack);

  if (sourceLane === 'velocity-first' || sourceLane === 'velocity-first-preflight') return 'velocity-first';
  if (sourceLane === 'mature-fallback') return 'mature-fallback';
  if (sourceLane === 'wallet-signal' || sourceLane === 'wallet') return 'wallet';
  if (sourceLane === 'alpha') return 'alpha';
  if (sourceLane === 'last-stand') return 'last-stand';
  if (entryMode === 'last-stand') return 'last-stand';
  if (entryMode === 'micro-scout' && fastTrack) return 'micro-fast-track';
  if (entryMode === 'micro-scout' && probeLike) return 'micro-probe';
  if (entryMode === 'micro-scout') return 'micro-core';
  if (entryMode === 'normal') return 'normal';
  return sourceLane || entryMode || 'unknown';
}

function getTradeTimestamp(row: FamilyTradeLike | null | undefined): number {
  const candidates = [row?.closedAt, row?.timestamp, row?.ts, row?.openedAt];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return Date.now();
}

function normalizeConfig(input?: Partial<FamilyPerformanceConfig> | null): FamilyPerformanceConfig {
  return {
    maxHistory: Math.max(5, Math.min(200, Math.round(Number(input?.maxHistory || DEFAULT_CONFIG.maxHistory)))),
    recentTradeWindow: Math.max(
      5,
      Math.min(100, Math.round(Number(input?.recentTradeWindow || DEFAULT_CONFIG.recentTradeWindow))),
    ),
    minTradeCountForGate: Math.max(
      5,
      Math.min(100, Math.round(Number(input?.minTradeCountForGate || DEFAULT_CONFIG.minTradeCountForGate))),
    ),
    minWinRate: Math.max(0.05, Math.min(1, Number(input?.minWinRate || DEFAULT_CONFIG.minWinRate))),
    reducedSizeMultiplier: Math.max(
      0.1,
      Math.min(1, Number(input?.reducedSizeMultiplier || DEFAULT_CONFIG.reducedSizeMultiplier)),
    ),
    disableNetSolThreshold: Number.isFinite(Number(input?.disableNetSolThreshold))
      ? Number(input?.disableNetSolThreshold)
      : DEFAULT_CONFIG.disableNetSolThreshold,
  };
}

export function createFamilyPerformanceMemory(): FamilyPerformanceMemory {
  return {};
}

export function recordFamilyTrade(
  memory: FamilyPerformanceMemory,
  row: FamilyTradeLike | null | undefined,
  configInput?: Partial<FamilyPerformanceConfig> | null,
): FamilyPerformanceMemory {
  const config = normalizeConfig(configInput);
  if (!row) return memory;
  if (String(row.action || 'SELL').toUpperCase() !== 'SELL') return memory;
  if (row.partialExit === true) return memory;
  const pnlSol = toFiniteNumber(row.pnlSol, NaN);
  if (!Number.isFinite(pnlSol)) return memory;

  const family = normalizeEntryFamily(row);
  const bucket = memory[family] || { family, recent: [] };
  bucket.recent.push({
    ts: getTradeTimestamp(row),
    pnlSol,
  });
  bucket.recent = bucket.recent
    .sort((a, b) => a.ts - b.ts)
    .slice(-config.maxHistory);
  memory[family] = bucket;
  return memory;
}

export function buildFamilyPerformanceMemory(
  rows: FamilyTradeLike[],
  configInput?: Partial<FamilyPerformanceConfig> | null,
): FamilyPerformanceMemory {
  const memory = createFamilyPerformanceMemory();
  for (const row of rows || []) {
    recordFamilyTrade(memory, row, configInput);
  }
  return memory;
}

export function evaluateEntryFamilyPerformance(
  family: string,
  memory: FamilyPerformanceMemory,
  configInput?: Partial<FamilyPerformanceConfig> | null,
): FamilyPerformanceDecision {
  const config = normalizeConfig(configInput);
  const normalizedFamily = String(family || 'unknown').trim().toLowerCase() || 'unknown';
  const bucket = memory[normalizedFamily];
  const recent = Array.isArray(bucket?.recent) ? bucket.recent.slice(-config.recentTradeWindow) : [];
  const sampleCount = recent.length;
  const wins = recent.filter((sample) => sample.pnlSol > 0).length;
  const recentWinRate = sampleCount > 0 ? wins / sampleCount : 0;
  const recentNetSol = recent.reduce((sum, sample) => sum + toFiniteNumber(sample.pnlSol, 0), 0);

  if (sampleCount >= config.minTradeCountForGate && recentNetSol <= config.disableNetSolThreshold) {
    return {
      family: normalizedFamily,
      sampleCount,
      recentWinRate,
      recentNetSol,
      disabled: true,
      sizeMultiplier: 0,
      reason: `recent ${sampleCount}-trade net ${recentNetSol.toFixed(6)} SOL <= ${config.disableNetSolThreshold.toFixed(6)} SOL`,
    };
  }

  if (sampleCount >= config.minTradeCountForGate && recentWinRate < config.minWinRate) {
    return {
      family: normalizedFamily,
      sampleCount,
      recentWinRate,
      recentNetSol,
      disabled: false,
      sizeMultiplier: config.reducedSizeMultiplier,
      reason: `recent ${sampleCount}-trade win rate ${(recentWinRate * 100).toFixed(1)}% < ${(config.minWinRate * 100).toFixed(1)}%`,
    };
  }

  return {
    family: normalizedFamily,
    sampleCount,
    recentWinRate,
    recentNetSol,
    disabled: false,
    sizeMultiplier: 1,
    reason: null,
  };
}

module.exports = {
  createFamilyPerformanceMemory,
  normalizeEntryFamily,
  recordFamilyTrade,
  buildFamilyPerformanceMemory,
  evaluateEntryFamilyPerformance,
};
