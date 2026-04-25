import fs from 'fs';
import path from 'path';

const { bucketizeTradeProfile } = require('./trade_profile_logic.ts');

const ROOT = process.cwd();
const SIGNALS_DIR = path.join(ROOT, 'signals');
const JOURNAL_FILE = path.join(
  SIGNALS_DIR,
  process.env.PAPER_MODE === 'true' ? 'trade_journal_paper.jsonl' : 'trade_journal.jsonl',
);

const DEFAULT_MAX_JOURNAL_LINES = 12_000;
const DEFAULT_CACHE_TTL_MS = 15_000;

type JournalRow = Record<string, any>;

export interface ClosedTradeEpisode {
  tradeId: string;
  mint: string;
  symbol: string;
  buy: JournalRow;
  sells: JournalRow[];
  closedAt: number;
  holdMs: number;
  proceedsSol: number;
  entryCostSol: number;
  pnlSol: number;
  partialExitCount: number;
}

export interface ExpectedValueBucketStats {
  trades: number;
  wins: number;
  losses: number;
  totalPnlSol: number;
  totalWinPnlSol: number;
  totalLossAbsPnlSol: number;
  avgPnlSol: number;
  avgWinPnlSol: number;
  avgLossAbsPnlSol: number;
  winRate: number;
  lastTs: number | null;
}

export interface ExpectedValueModel {
  generatedAt: number;
  journalFile: string;
  source: 'trade_journal';
  closedTrades: number;
  latestClosedAt: number | null;
  totals: ExpectedValueBucketStats;
  dimensions: Record<string, Record<string, ExpectedValueBucketStats>>;
}

export interface ExpectedValueCandidateInput {
  mint?: string;
  symbol?: string;
  entryMode?: string;
  entryFamily?: string;
  sourceLane?: string;
  tokenAgeSec?: number | null;
  liquidityUsd?: number | null;
  marketCapUsd?: number | null;
  fdvUsd?: number | null;
  momentum5m?: number | null;
  buyRatio?: number | null;
  volume1hUsd?: number | null;
  buys1h?: number | null;
  sells1h?: number | null;
  quotaAssistLevel?: number | null;
  walletSignalPriority?: string | null;
  walletConsensusScore?: number | null;
  walletCount?: number | null;
  walletPnlScore?: number | null;
  walletWeightedScore?: number | null;
  walletCompositeScore?: number | null;
  kolConfirmed?: boolean | null;
  alphaBoost?: number | null;
  alphaKolCount?: number | null;
  preferredHoldMs?: number | null;
  confidenceScore?: number | null;
  familySizeMultiplier?: number | null;
  velocityBuys60s?: number | null;
  velocityBuyRatio60s?: number | null;
  velocityTxPerMin?: number | null;
  velocitySolVolume60s?: number | null;
}

export interface ExpectedValueDimensionSignal {
  dimension: string;
  bucket: string;
  trades: number;
  winRate: number;
  expectedPnlSol: number;
  weight: number;
}

export interface ExpectedValueDecision {
  expectedPnlSol: number;
  historicalExpectedPnlSol: number;
  priorExpectedPnlSol: number;
  winProbability: number;
  confidence: number;
  liveSetupScore: number;
  positionMultiplier: number;
  rankScore: number;
  matchedDimensions: number;
  posteriorTradeCount: number;
  shouldSkip: boolean;
  skipReason: string | null;
  dimensions: ExpectedValueDimensionSignal[];
}

const DIMENSION_WEIGHTS: Record<string, number> = {
  entryMode: 0.7,
  entryFamily: 1.5,
  sourceLane: 1.4,
  ageBucket: 0.7,
  liquidityBucket: 0.9,
  marketCapBucket: 0.8,
  momentum5mBucket: 0.9,
  buyRatioBucket: 1.0,
  quotaAssistLevel: 0.8,
  walletPriorityBucket: 0.8,
  consensusBucket: 0.9,
  alphaBoostBucket: 0.8,
  kolConfirmed: 0.5,
  preferredHoldBucket: 0.5,
};

const TOTAL_DIMENSION_WEIGHT = Object.values(DIMENSION_WEIGHTS).reduce((sum, value) => sum + value, 0);

let cachedModel: { mtimeMs: number; loadedAt: number; model: ExpectedValueModel } | null = null;

function toFiniteNumber(value: any, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function createEmptyBucketStats(): ExpectedValueBucketStats {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    totalPnlSol: 0,
    totalWinPnlSol: 0,
    totalLossAbsPnlSol: 0,
    avgPnlSol: 0,
    avgWinPnlSol: 0,
    avgLossAbsPnlSol: 0,
    winRate: 0,
    lastTs: null,
  };
}

function updateBucketStats(stats: ExpectedValueBucketStats, pnlSol: number, ts: number) {
  stats.trades += 1;
  if (pnlSol > 0) {
    stats.wins += 1;
    stats.totalWinPnlSol = Number((stats.totalWinPnlSol + pnlSol).toFixed(9));
  } else {
    stats.losses += 1;
    stats.totalLossAbsPnlSol = Number((stats.totalLossAbsPnlSol + Math.abs(pnlSol)).toFixed(9));
  }
  stats.totalPnlSol = Number((stats.totalPnlSol + pnlSol).toFixed(9));
  stats.avgPnlSol = Number((stats.totalPnlSol / Math.max(1, stats.trades)).toFixed(9));
  stats.avgWinPnlSol = Number((stats.totalWinPnlSol / Math.max(1, stats.wins)).toFixed(9));
  stats.avgLossAbsPnlSol = Number((stats.totalLossAbsPnlSol / Math.max(1, stats.losses)).toFixed(9));
  stats.winRate = Number((stats.wins / Math.max(1, stats.trades)).toFixed(6));
  stats.lastTs = ts;
}

function getRowTs(row: JournalRow | null | undefined): number {
  return Math.max(
    0,
    toFiniteNumber(row?.closedAt, 0) ||
      toFiniteNumber(row?.timestamp, 0) ||
      toFiniteNumber(row?.ts, 0) ||
      toFiniteNumber(row?.openedAt, 0),
  );
}

function readTailText(filePath: string, targetLineCount: number) {
  const stat = fs.statSync(filePath);
  let bytesToRead = Math.min(
    stat.size,
    Math.max(512 * 1024, Math.max(1, targetLineCount) * 2048),
  );

  while (true) {
    const start = Math.max(0, stat.size - bytesToRead);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }

    let text = buffer.toString('utf-8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }

    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length >= targetLineCount || start === 0 || bytesToRead >= stat.size) {
      return lines.slice(-Math.max(1, targetLineCount));
    }

    bytesToRead = Math.min(stat.size, bytesToRead * 2);
  }
}

function readJournalRows(filePath = JOURNAL_FILE, limit = DEFAULT_MAX_JOURNAL_LINES): JournalRow[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = readTailText(filePath, Math.max(1, limit));
    return lines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as JournalRow[];
  } catch {
    return [];
  }
}

export function buildClosedTradeEpisodesFromRows(rows: JournalRow[]): ClosedTradeEpisode[] {
  const buys = new Map<string, JournalRow>();
  const sellsByParent = new Map<string, JournalRow[]>();

  for (const row of rows || []) {
    const action = String(row?.action || '').toUpperCase();
    if (action === 'BUY' && row?.tradeId) {
      buys.set(String(row.tradeId), row);
      continue;
    }
    if (action === 'SELL' && row?.parentBuyId) {
      const key = String(row.parentBuyId);
      const group = sellsByParent.get(key) || [];
      group.push(row);
      sellsByParent.set(key, group);
    }
  }

  const episodes: ClosedTradeEpisode[] = [];

  for (const [parentBuyId, sellRows] of sellsByParent.entries()) {
    const buy = buys.get(parentBuyId);
    if (!buy) continue;

    const orderedSells = [...sellRows].sort((left, right) => getRowTs(left) - getRowTs(right));
    const finalSellIndex = orderedSells.findIndex((row) =>
      row?.partialExit !== true ||
      toFiniteNumber(row?.remainingAmountRaw, NaN) === 0 ||
      toFiniteNumber(row?.remainingAmount, NaN) === 0,
    );

    if (finalSellIndex < 0) continue;

    const completedSells = orderedSells.slice(0, finalSellIndex + 1);
    const finalSell = completedSells[completedSells.length - 1];
    const proceedsSol = completedSells.reduce((sum, row) => sum + toFiniteNumber(row?.amountSol, 0), 0);
    const entryCostSol = Math.max(0, toFiniteNumber(buy?.entryCostSol, toFiniteNumber(buy?.amountSol, 0)));
    const closedAt = getRowTs(finalSell);
    const openedAt = getRowTs(buy);
    const pnlSol = Number((proceedsSol - entryCostSol).toFixed(9));

    episodes.push({
      tradeId: String(parentBuyId),
      mint: String(buy?.mint || ''),
      symbol: String(buy?.symbol || buy?.mint || 'unknown'),
      buy,
      sells: completedSells,
      closedAt,
      holdMs: Math.max(0, closedAt - openedAt),
      proceedsSol: Number(proceedsSol.toFixed(9)),
      entryCostSol: Number(entryCostSol.toFixed(9)),
      pnlSol,
      partialExitCount: completedSells.filter((row) => row?.partialExit === true).length,
    });
  }

  return episodes.sort((left, right) => left.closedAt - right.closedAt);
}

export function buildExpectedValueModelFromRows(rows: JournalRow[]): ExpectedValueModel {
  const episodes = buildClosedTradeEpisodesFromRows(rows);
  const totals = createEmptyBucketStats();
  const dimensions: Record<string, Record<string, ExpectedValueBucketStats>> = {};

  for (const episode of episodes) {
    updateBucketStats(totals, episode.pnlSol, episode.closedAt);
    const dimensionBuckets = bucketizeTradeProfile({
      ...episode.buy,
      action: 'SELL',
      pnlSol: episode.pnlSol,
      holdMs: episode.holdMs,
      closedAt: episode.closedAt,
      timestamp: episode.closedAt,
      ts: episode.closedAt,
    });

    for (const [dimension, bucket] of Object.entries(dimensionBuckets || {})) {
      const normalizedBucket = String(bucket || 'unknown');
      if (!dimensions[dimension]) dimensions[dimension] = {};
      if (!dimensions[dimension][normalizedBucket]) {
        dimensions[dimension][normalizedBucket] = createEmptyBucketStats();
      }
      updateBucketStats(dimensions[dimension][normalizedBucket], episode.pnlSol, episode.closedAt);
    }
  }

  return {
    generatedAt: Date.now(),
    journalFile: JOURNAL_FILE,
    source: 'trade_journal',
    closedTrades: totals.trades,
    latestClosedAt: totals.lastTs,
    totals,
    dimensions,
  };
}

export function loadExpectedValueModel(options?: {
  filePath?: string;
  maxJournalLines?: number;
  forceRefresh?: boolean;
  cacheTtlMs?: number;
}): ExpectedValueModel {
  const filePath = options?.filePath || JOURNAL_FILE;
  const cacheTtlMs = Math.max(1_000, Number(options?.cacheTtlMs || DEFAULT_CACHE_TTL_MS));
  const maxJournalLines = Math.max(100, Math.round(Number(options?.maxJournalLines || DEFAULT_MAX_JOURNAL_LINES)));

  let mtimeMs = -1;
  try {
    mtimeMs = fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : -1;
  } catch {
    mtimeMs = -1;
  }

  if (
    !options?.forceRefresh &&
    cachedModel &&
    cachedModel.mtimeMs === mtimeMs &&
    Date.now() - cachedModel.loadedAt <= cacheTtlMs
  ) {
    return cachedModel.model;
  }

  const rows = readJournalRows(filePath, maxJournalLines);
  const model = buildExpectedValueModelFromRows(rows);
  model.generatedAt = Date.now();
  model.journalFile = filePath;
  cachedModel = {
    mtimeMs,
    loadedAt: Date.now(),
    model,
  };
  return model;
}

function derivePriorStats(stats: ExpectedValueBucketStats) {
  const trades = Math.max(0, Number(stats?.trades || 0));
  const wins = Math.max(0, Number(stats?.wins || 0));
  const losses = Math.max(0, Number(stats?.losses || 0));
  const avgWinPnlSol = Math.max(0.00015, Number(stats?.avgWinPnlSol || 0) || 0.00045);
  const avgLossAbsPnlSol = Math.max(0.00015, Number(stats?.avgLossAbsPnlSol || 0) || 0.0004);
  const betaPriorStrength = 6;
  const winRate = clamp((wins + 0.5 * betaPriorStrength) / (trades + betaPriorStrength), 0.05, 0.95);
  const expectedPnlSol = Number((winRate * avgWinPnlSol - (1 - winRate) * avgLossAbsPnlSol).toFixed(9));
  return {
    trades,
    wins,
    losses,
    winRate,
    avgWinPnlSol,
    avgLossAbsPnlSol,
    expectedPnlSol,
  };
}

function derivePosteriorBucketStats(bucket: ExpectedValueBucketStats, prior: ReturnType<typeof derivePriorStats>) {
  const trades = Math.max(0, Number(bucket?.trades || 0));
  const wins = Math.max(0, Number(bucket?.wins || 0));
  const losses = Math.max(0, Number(bucket?.losses || 0));
  const sampleStrength = 8;
  const winRate = clamp(
    (wins + prior.winRate * sampleStrength) / (trades + sampleStrength),
    0.02,
    0.98,
  );
  const avgWinPnlSol = Number(
    (
      ((bucket?.totalWinPnlSol || 0) + prior.avgWinPnlSol * sampleStrength) /
      Math.max(1, wins + sampleStrength)
    ).toFixed(9),
  );
  const avgLossAbsPnlSol = Number(
    (
      ((bucket?.totalLossAbsPnlSol || 0) + prior.avgLossAbsPnlSol * sampleStrength) /
      Math.max(1, losses + sampleStrength)
    ).toFixed(9),
  );
  const expectedPnlSol = Number((winRate * avgWinPnlSol - (1 - winRate) * avgLossAbsPnlSol).toFixed(9));
  return {
    trades,
    wins,
    losses,
    winRate,
    avgWinPnlSol,
    avgLossAbsPnlSol,
    expectedPnlSol,
  };
}

function safeAverage(values: number[]): number {
  if (values.length === 0) return 0.5;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function computeLiveSetupScore(input: ExpectedValueCandidateInput): number {
  const present: number[] = [];

  if (Number.isFinite(Number(input.confidenceScore))) {
    present.push(clamp(Number(input.confidenceScore), 0, 1));
  }
  if (Number.isFinite(Number(input.buyRatio))) {
    present.push(sigmoid((Number(input.buyRatio) - 1.4) / 0.55));
  }
  if (Number.isFinite(Number(input.momentum5m))) {
    present.push(sigmoid((Number(input.momentum5m) - 3) / 6));
  }
  if (Number.isFinite(Number(input.volume1hUsd))) {
    present.push(sigmoid((Math.log10(Math.max(1, Number(input.volume1hUsd))) - 3.9) / 0.35));
  }
  if (Number.isFinite(Number(input.buys1h))) {
    present.push(sigmoid((Number(input.buys1h) - 100) / 80));
  }
  if (Number.isFinite(Number(input.alphaBoost))) {
    present.push(sigmoid((Number(input.alphaBoost) - 0.04) / 0.05));
  }
  if (Number.isFinite(Number(input.walletConsensusScore))) {
    present.push(sigmoid((Number(input.walletConsensusScore) - 0.65) / 0.12));
  }
  if (Number.isFinite(Number(input.walletWeightedScore))) {
    present.push(sigmoid((Number(input.walletWeightedScore) - 0.58) / 0.11));
  }
  if (Number.isFinite(Number(input.walletCompositeScore))) {
    present.push(sigmoid((Number(input.walletCompositeScore) - 0.62) / 0.10));
  }
  if (Number.isFinite(Number(input.velocityBuys60s))) {
    present.push(sigmoid((Number(input.velocityBuys60s) - 4) / 3));
  }
  if (Number.isFinite(Number(input.velocityBuyRatio60s))) {
    present.push(sigmoid((Number(input.velocityBuyRatio60s) - 0.58) / 0.08));
  }
  if (Number.isFinite(Number(input.velocitySolVolume60s))) {
    present.push(sigmoid((Number(input.velocitySolVolume60s) - 1.2) / 0.8));
  }

  return clamp(safeAverage(present), 0.05, 0.98);
}

export function scoreCandidateExpectedValue(
  input: ExpectedValueCandidateInput,
  options?: {
    model?: ExpectedValueModel | null;
    now?: number;
  },
): ExpectedValueDecision {
  const model = options?.model || loadExpectedValueModel();
  const prior = derivePriorStats(model?.totals || createEmptyBucketStats());
  const dimensionBuckets = bucketizeTradeProfile({
    entryMode: input.entryMode,
    entryFamily: input.entryFamily,
    sourceLane: input.sourceLane,
    tokenAgeSec: input.tokenAgeSec,
    liquidityUsd: input.liquidityUsd,
    marketCapUsd: input.marketCapUsd,
    fdvUsd: input.fdvUsd,
    momentum5m: input.momentum5m,
    buyRatio: input.buyRatio,
    quotaAssistLevel: input.quotaAssistLevel,
    walletSignalPriority: input.walletSignalPriority,
    walletConsensusScore: input.walletConsensusScore,
    walletCount: input.walletCount,
    walletPnlScore: input.walletPnlScore,
    walletWeightedScore: input.walletWeightedScore,
    walletCompositeScore: input.walletCompositeScore,
    kolConfirmed: input.kolConfirmed,
    alphaBoost: input.alphaBoost,
    alphaKolCount: input.alphaKolCount,
    preferredHoldMs: input.preferredHoldMs,
  });

  const dimensions: ExpectedValueDimensionSignal[] = [];
  let totalWeight = 0;
  let weightedExpectedLift = 0;
  let weightedWinLift = 0;
  let posteriorTradeCount = 0;

  for (const [dimension, bucket] of Object.entries(dimensionBuckets || {})) {
    const bucketKey = String(bucket || 'unknown');
    const bucketStats = model?.dimensions?.[dimension]?.[bucketKey];
    if (!bucketStats || bucketStats.trades <= 0) continue;

    const bucketPosterior = derivePosteriorBucketStats(bucketStats, prior);
    const baseWeight = DIMENSION_WEIGHTS[dimension] || 0.4;
    const sampleWeight = Math.min(1, bucketPosterior.trades / 14);
    const freshnessWeight = bucketStats.lastTs
      ? clamp(1 - ((Date.now() - Number(bucketStats.lastTs)) / (7 * 24 * 60 * 60 * 1000)) * 0.25, 0.7, 1.05)
      : 1;
    const weight = Number((baseWeight * sampleWeight * freshnessWeight).toFixed(6));

    totalWeight += weight;
    posteriorTradeCount += bucketPosterior.trades;
    weightedExpectedLift += weight * (bucketPosterior.expectedPnlSol - prior.expectedPnlSol);
    weightedWinLift += weight * (bucketPosterior.winRate - prior.winRate);

    dimensions.push({
      dimension,
      bucket: bucketKey,
      trades: bucketPosterior.trades,
      winRate: bucketPosterior.winRate,
      expectedPnlSol: bucketPosterior.expectedPnlSol,
      weight,
    });
  }

  const historicalExpectedPnlSol = Number(
    (
      prior.expectedPnlSol +
      (totalWeight > 0 ? (weightedExpectedLift / totalWeight) : 0)
    ).toFixed(9),
  );
  const winProbability = clamp(
    prior.winRate + (totalWeight > 0 ? (weightedWinLift / totalWeight) : 0),
    0.05,
    0.95,
  );
  const liveSetupScore = computeLiveSetupScore(input);
  const unitScale = Math.max(
    0.00015,
    prior.avgLossAbsPnlSol,
    prior.avgWinPnlSol * 0.5,
    Math.abs(prior.expectedPnlSol) * 4,
  );
  const liveEdgeAdjustment = Number((((liveSetupScore - 0.5) * unitScale * 0.9)).toFixed(9));
  const expectedPnlSol = Number((historicalExpectedPnlSol + liveEdgeAdjustment).toFixed(9));
  const coverage = totalWeight > 0 ? totalWeight / TOTAL_DIMENSION_WEIGHT : 0;
  const confidence = clamp(
    0.12 +
      (coverage * 0.68) +
      Math.min(0.18, Math.log10(Math.max(1, prior.trades) + 1) / 6),
    0.05,
    0.98,
  );
  const familySizeMultiplier = clamp(toFiniteNumber(input.familySizeMultiplier, 1), 0.1, 1);
  const normalizedEdge = expectedPnlSol / unitScale;
  const positionMultiplier = clamp(
    1 + (normalizedEdge * (0.55 + confidence * 0.75)),
    0.35,
    1.65,
  );
  const rankScore = Number(
    (
      expectedPnlSol *
      (0.55 + confidence) *
      (0.9 + liveSetupScore) *
      (0.75 + familySizeMultiplier * 0.25)
    ).toFixed(9),
  );

  const negativeEdgeFloor = Math.max(0.00005, unitScale * 0.18);
  const shouldSkip =
    expectedPnlSol < -negativeEdgeFloor &&
    confidence >= 0.55 &&
    dimensions.length >= 2 &&
    prior.trades >= 12;

  return {
    expectedPnlSol,
    historicalExpectedPnlSol,
    priorExpectedPnlSol: prior.expectedPnlSol,
    winProbability: Number(winProbability.toFixed(6)),
    confidence: Number(confidence.toFixed(6)),
    liveSetupScore: Number(liveSetupScore.toFixed(6)),
    positionMultiplier: Number(positionMultiplier.toFixed(6)),
    rankScore,
    matchedDimensions: dimensions.length,
    posteriorTradeCount,
    shouldSkip,
    skipReason: shouldSkip
      ? `expected pnl ${expectedPnlSol.toFixed(6)} SOL < -${negativeEdgeFloor.toFixed(6)} SOL with ${(confidence * 100).toFixed(0)}% confidence`
      : null,
    dimensions: dimensions.sort((left, right) => right.weight - left.weight),
  };
}

export function summarizeExpectedValueModel(modelInput?: ExpectedValueModel | null) {
  const model = modelInput || loadExpectedValueModel();
  const prior = derivePriorStats(model?.totals || createEmptyBucketStats());
  const dimensionSummaries = Object.entries(model?.dimensions || {})
    .map(([dimension, buckets]) => {
      const ranked = Object.entries(buckets || {})
        .map(([bucket, stats]) => {
          const posterior = derivePosteriorBucketStats(stats, prior);
          return {
            bucket,
            trades: posterior.trades,
            expectedPnlSol: posterior.expectedPnlSol,
            winRate: posterior.winRate,
          };
        })
        .filter((row) => row.trades > 0)
        .sort((left, right) => right.expectedPnlSol - left.expectedPnlSol);

      if (ranked.length === 0) return null;
      return {
        dimension,
        best: ranked[0],
        worst: ranked[ranked.length - 1],
      };
    })
    .filter(Boolean);

  return {
    generatedAt: model?.generatedAt || null,
    closedTrades: model?.closedTrades || 0,
    latestClosedAt: model?.latestClosedAt || null,
    priorExpectedPnlSol: prior.expectedPnlSol,
    priorWinRate: prior.winRate,
    avgWinPnlSol: prior.avgWinPnlSol,
    avgLossAbsPnlSol: prior.avgLossAbsPnlSol,
    bestWorstDimensions: dimensionSummaries.slice(0, 8),
  };
}

module.exports = {
  buildClosedTradeEpisodesFromRows,
  buildExpectedValueModelFromRows,
  loadExpectedValueModel,
  scoreCandidateExpectedValue,
  summarizeExpectedValueModel,
};
