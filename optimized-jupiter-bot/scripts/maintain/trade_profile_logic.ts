import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const SIGNALS_DIR = path.join(ROOT, 'signals');
const IS_PAPER = process.env.PAPER_MODE === 'true';
const TRADE_PROFILE_EVENTS_FILE = path.join(
  SIGNALS_DIR,
  IS_PAPER ? 'trade_profile_events_paper.jsonl' : 'trade_profile_events.jsonl',
);
const TRADE_PROFILE_STATS_FILE = path.join(
  SIGNALS_DIR,
  IS_PAPER ? 'trade_profile_stats_paper.json' : 'trade_profile_stats.json',
);

type TradeProfileRecord = Record<string, any>;

function toFiniteNumber(value: any, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function bucketizeRange(value: number | null, ranges: Array<{ max: number; label: string }>, fallbackHigh: string, fallbackNull = 'unknown') {
  if (value === null || !Number.isFinite(value)) return fallbackNull;
  for (const range of ranges) {
    if (value < range.max) return range.label;
  }
  return fallbackHigh;
}

function normalizeString(value: any, fallback = 'unknown') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

export function bucketizeTradeProfile(record: TradeProfileRecord) {
  const ageSec = toFiniteNumber(record.tokenAgeSec, NaN);
  const liquidityUsd = toFiniteNumber(record.liquidityUsd, NaN);
  const marketCapUsd = toFiniteNumber(record.marketCapUsd || record.fdvUsd, NaN);
  const momentum5m = toFiniteNumber(record.momentum5m, NaN);
  const buyRatio = toFiniteNumber(record.buyRatio ?? record.entryBuyRatio, NaN);
  const consensus = toFiniteNumber(record.walletConsensusScore, NaN);
  const walletStrength = toFiniteNumber(
    record.walletCompositeScore ?? record.walletWeightedScore ?? record.walletPnlScore,
    NaN,
  );
  const alphaBoost = toFiniteNumber(record.alphaBoost, NaN);
  const preferredHoldMinutes = toFiniteNumber(record.preferredHoldMs, NaN);

  return {
    entryMode: normalizeString(record.entryMode, 'unknown').toLowerCase(),
    entryFamily: normalizeString(record.entryFamily, 'unknown').toLowerCase(),
    sourceLane: normalizeString(record.sourceLane, 'unknown').toLowerCase(),
    ageBucket: bucketizeRange(ageSec, [
      { max: 300, label: '<5m' },
      { max: 900, label: '5-15m' },
      { max: 3600, label: '15-60m' },
    ], '60m+'),
    liquidityBucket: bucketizeRange(liquidityUsd, [
      { max: 10_000, label: '<10k' },
      { max: 25_000, label: '10k-25k' },
      { max: 50_000, label: '25k-50k' },
      { max: 100_000, label: '50k-100k' },
    ], '100k+'),
    marketCapBucket: bucketizeRange(marketCapUsd, [
      { max: 25_000, label: '<25k' },
      { max: 100_000, label: '25k-100k' },
      { max: 250_000, label: '100k-250k' },
      { max: 500_000, label: '250k-500k' },
    ], '500k+'),
    momentum5mBucket: bucketizeRange(momentum5m, [
      { max: 0, label: '<0%' },
      { max: 5, label: '0-5%' },
      { max: 15, label: '5-15%' },
    ], '15%+'),
    buyRatioBucket: bucketizeRange(buyRatio, [
      { max: 1, label: '<1.0x' },
      { max: 1.5, label: '1.0-1.5x' },
      { max: 2.5, label: '1.5-2.5x' },
      { max: 4, label: '2.5-4.0x' },
    ], '4.0x+'),
    quotaAssistLevel: String(Math.max(0, Math.round(toFiniteNumber(record.quotaAssistLevel, 0)))),
    walletPriorityBucket: normalizeString(record.walletSignalPriority, 'NONE').toUpperCase(),
    consensusBucket: bucketizeRange(consensus, [
      { max: 0.5, label: '<0.50' },
      { max: 0.7, label: '0.50-0.70' },
      { max: 0.85, label: '0.70-0.85' },
    ], '0.85+'),
    walletScoreBucket: bucketizeRange(walletStrength, [
      { max: 0.4, label: '<0.40' },
      { max: 0.6, label: '0.40-0.60' },
      { max: 0.75, label: '0.60-0.75' },
      { max: 0.9, label: '0.75-0.90' },
    ], '0.90+'),
    alphaBoostBucket: bucketizeRange(alphaBoost, [
      { max: 0.0001, label: '<=0.00' },
      { max: 0.05, label: '0.00-0.05' },
      { max: 0.12, label: '0.05-0.12' },
      { max: 0.20, label: '0.12-0.20' },
    ], '0.20+'),
    kolConfirmed: record.kolConfirmed ? 'yes' : 'no',
    preferredHoldBucket: bucketizeRange(
      Number.isFinite(preferredHoldMinutes) ? preferredHoldMinutes / 60_000 : null,
      [
        { max: 2, label: '<2m' },
        { max: 5, label: '2-5m' },
        { max: 10, label: '5-10m' },
      ],
      '10m+',
    ),
  };
}

function ensureSignalsDir() {
  if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function updateBucket(stats: any, dimension: string, bucket: string, pnlSol: number, ts: number) {
  if (!stats.dimensions[dimension]) stats.dimensions[dimension] = {};
  if (!stats.dimensions[dimension][bucket]) {
    stats.dimensions[dimension][bucket] = {
      trades: 0,
      wins: 0,
      losses: 0,
      totalPnlSol: 0,
      avgPnlSol: 0,
      winRate: 0,
      lastTs: null,
    };
  }

  const row = stats.dimensions[dimension][bucket];
  row.trades += 1;
  if (pnlSol > 0) row.wins += 1;
  else row.losses += 1;
  row.totalPnlSol = Number((row.totalPnlSol + pnlSol).toFixed(9));
  row.avgPnlSol = Number((row.totalPnlSol / Math.max(1, row.trades)).toFixed(9));
  row.winRate = Number((row.wins / Math.max(1, row.trades)).toFixed(6));
  row.lastTs = ts;
}

export function createTradeProfileEvent(record: TradeProfileRecord) {
  const ts = toFiniteNumber(record.timestamp ?? record.ts, Date.now());
  const normalized = {
    ...record,
    action: normalizeString(record.action, 'UNKNOWN').toUpperCase(),
    ts,
    timestamp: ts,
    pnlSol: record.pnlSol !== undefined ? toFiniteNumber(record.pnlSol, 0) : undefined,
    partialExit: record.partialExit === true,
    quotaAssist: record.quotaAssist === true,
    quotaAssistLevel: Math.max(0, Math.round(toFiniteNumber(record.quotaAssistLevel, 0))),
    walletCount: Array.isArray(record.wallets)
      ? record.wallets.length
      : Math.max(0, Math.round(toFiniteNumber(record.walletCount, 0))),
    walletConsensusScore: clamp(toFiniteNumber(record.walletConsensusScore, 0), 0, 1),
    walletPnlScore: clamp(toFiniteNumber(record.walletPnlScore, 0), 0, 1),
    walletWeightedScore: clamp(toFiniteNumber(record.walletWeightedScore, 0), 0, 1),
    walletCompositeScore: clamp(toFiniteNumber(record.walletCompositeScore, 0), 0, 1),
    alphaBoost: toFiniteNumber(record.alphaBoost, 0),
    alphaKolCount: Math.max(0, Math.round(toFiniteNumber(record.alphaKolCount, 0))),
  };

  return {
    ...normalized,
    dimensions: bucketizeTradeProfile(normalized),
  };
}

export function updateTradeProfileStats(statsInput: any, event: ReturnType<typeof createTradeProfileEvent>) {
  const stats = statsInput && typeof statsInput === 'object'
    ? statsInput
    : {
        generatedAt: null,
        totals: { trades: 0, wins: 0, losses: 0, totalPnlSol: 0 },
        dimensions: {},
      };

  if (event.action !== 'SELL' || event.partialExit === true || !Number.isFinite(Number(event.pnlSol))) {
    stats.generatedAt = Date.now();
    return stats;
  }

  const pnlSol = Number(event.pnlSol || 0);
  stats.generatedAt = Date.now();
  stats.totals = stats.totals || { trades: 0, wins: 0, losses: 0, totalPnlSol: 0 };
  stats.dimensions = stats.dimensions || {};
  stats.totals.trades += 1;
  if (pnlSol > 0) stats.totals.wins += 1;
  else stats.totals.losses += 1;
  stats.totals.totalPnlSol = Number((toFiniteNumber(stats.totals.totalPnlSol, 0) + pnlSol).toFixed(9));

  const dimensions = event.dimensions || {};
  for (const [dimension, bucket] of Object.entries(dimensions)) {
    updateBucket(stats, dimension, normalizeString(bucket, 'unknown'), pnlSol, event.ts);
  }

  return stats;
}

export function appendTradeProfileArtifacts(record: TradeProfileRecord) {
  try {
    ensureSignalsDir();
    const event = createTradeProfileEvent(record);
    fs.appendFileSync(TRADE_PROFILE_EVENTS_FILE, `${JSON.stringify(event)}\n`, 'utf-8');

    if (event.action === 'SELL' && event.partialExit !== true && Number.isFinite(Number(event.pnlSol))) {
      const currentStats = readJson<any>(TRADE_PROFILE_STATS_FILE, {
        generatedAt: null,
        totals: { trades: 0, wins: 0, losses: 0, totalPnlSol: 0 },
        dimensions: {},
      });
      const updatedStats = updateTradeProfileStats(currentStats, event);
      fs.writeFileSync(TRADE_PROFILE_STATS_FILE, JSON.stringify(updatedStats, null, 2), 'utf-8');
    }

    return event;
  } catch {
    return null;
  }
}

module.exports = {
  bucketizeTradeProfile,
  createTradeProfileEvent,
  updateTradeProfileStats,
  appendTradeProfileArtifacts,
};
