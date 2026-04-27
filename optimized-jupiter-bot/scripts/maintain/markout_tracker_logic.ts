import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const SIGNALS_DIR = path.join(ROOT, 'signals');
const IS_PAPER = process.env.PAPER_MODE === 'true';
const MARKOUT_PENDING_FILE = path.join(SIGNALS_DIR, IS_PAPER ? 'markout_pending_paper.json' : 'markout_pending.json');
const MARKOUT_RESULTS_FILE = path.join(SIGNALS_DIR, IS_PAPER ? 'markout_results_paper.jsonl' : 'markout_results.jsonl');
const MARKOUT_SUMMARY_FILE = path.join(SIGNALS_DIR, IS_PAPER ? 'markout_summary_paper.json' : 'markout_summary.json');

const DEFAULT_HORIZONS_SEC = [60, 180, 300, 600];
const DEFAULT_MAX_PENDING = 750;
const DEFAULT_MAX_RESULTS_FOR_SUMMARY = 5_000;
const DEFAULT_MISSED_WINNER_RETURN_PCT = 15;

type JsonRow = Record<string, any>;

export interface MarkoutPendingItem {
  key: string;
  mint: string;
  symbol: string | null;
  scheduledAt: number;
  baselineAt: number;
  stage: string;
  reason: string;
  entryMode: string;
  sourceLane: string;
  entryFamily: string;
  baseline: {
    priceUsd: number | null;
    marketCapUsd: number | null;
    fdvUsd: number | null;
    liquidityUsd: number | null;
    volume1hUsd: number | null;
    momentum1m: number | null;
    momentum5m: number | null;
  };
  context: JsonRow;
  horizons: Array<{
    horizonSec: number;
    dueAt: number;
    status: 'pending' | 'done';
    resultAt?: number;
  }>;
}

export interface MarkoutResult {
  eventType: 'reject_markout';
  ts: number;
  key: string;
  mint: string;
  symbol: string | null;
  stage: string;
  reason: string;
  entryMode: string;
  sourceLane: string;
  entryFamily: string;
  horizonSec: number;
  baselineAt: number;
  scheduledAt: number;
  status: 'missed_winner' | 'correct_reject' | 'neutral' | 'no_pair';
  missedWinner: boolean;
  correctReject: boolean;
  returnPct: number | null;
  priceReturnPct: number | null;
  marketCapReturnPct: number | null;
  liquidityDeltaUsd: number | null;
  baselinePriceUsd: number | null;
  currentPriceUsd: number | null;
  baselineMarketCapUsd: number | null;
  currentMarketCapUsd: number | null;
  baselineLiquidityUsd: number | null;
  currentLiquidityUsd: number | null;
  currentMomentum5m: number | null;
  currentVolume1hUsd: number | null;
}

export interface MarkoutSummaryBucket {
  samples: number;
  missedWinners: number;
  correctRejects: number;
  neutral: number;
  noPair: number;
  missedWinnerRate: number;
  correctRejectRate: number;
  avgReturnPct: number;
  maxReturnPct: number;
  avgLiquidityDeltaUsd: number;
  lastSeenAt: number | null;
  lastMint: string | null;
  lastSymbol: string | null;
}

export interface MarkoutSummary {
  generatedAt: number;
  rows: number;
  totals: MarkoutSummaryBucket;
  byLane: Record<string, MarkoutSummaryBucket>;
  byStage: Record<string, MarkoutSummaryBucket>;
  byReason: Record<string, MarkoutSummaryBucket>;
}

function toFiniteNumber(value: any, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function finiteOrNull(value: any): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function positiveFiniteOrNull(value: any): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function normalizeString(value: any, fallback = 'unknown'): string {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || fallback;
}

function normalizeMint(value: any): string {
  return String(value || '').trim();
}

function ensureDirFor(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function percentageChange(baseline: number | null, current: number | null): number | null {
  if (!Number.isFinite(Number(baseline)) || !Number.isFinite(Number(current)) || Number(baseline) <= 0) return null;
  return Number((((Number(current) - Number(baseline)) / Number(baseline)) * 100).toFixed(6));
}

function firstPositive(...values: any[]): number | null {
  for (const value of values) {
    const numeric = positiveFiniteOrNull(value);
    if (numeric !== null) return numeric;
  }
  return null;
}

function firstFinite(...values: any[]): number | null {
  for (const value of values) {
    const numeric = finiteOrNull(value);
    if (numeric !== null) return numeric;
  }
  return null;
}

function buildMarkoutKey(record: JsonRow, now: number): string {
  const mint = normalizeMint(record.mint);
  const stage = normalizeString(record.stage, 'unknown');
  const reason = normalizeString(record.reason || record.rejectReason, 'unknown');
  const entryMode = normalizeString(record.entryMode || record.entry_mode, 'normal');
  return `${mint}:${stage}:${reason}:${entryMode}`;
}

function normalizeSourceLane(record: JsonRow): string {
  return normalizeString(record.sourceLane || record.source_lane || record.source || record.entryFamily || record.entryMode, 'unknown');
}

function buildPendingItem(record: JsonRow, now: number, horizonsSec: number[]): MarkoutPendingItem {
  const mint = normalizeMint(record.mint);
  const stage = normalizeString(record.stage, 'unknown');
  const reason = normalizeString(record.reason || record.rejectReason, 'unknown');
  const entryMode = normalizeString(record.entryMode || record.entry_mode, 'normal');
  const sourceLane = normalizeSourceLane(record);
  const entryFamily = normalizeString(record.entryFamily || record.entry_family || sourceLane, sourceLane);
  const baselineMarketCapUsd = firstPositive(record.marketCapUsd, record.marketCap, record.fdvUsd, record.fdv);
  const baselineFdvUsd = firstPositive(record.fdvUsd, record.fdv, record.marketCapUsd, record.marketCap);

  return {
    key: buildMarkoutKey(record, now),
    mint,
    symbol: record.symbol ? String(record.symbol) : null,
    scheduledAt: now,
    baselineAt: Math.max(0, toFiniteNumber(record.ts || record.timestamp || record.fallbackTimestamp, now)) || now,
    stage,
    reason,
    entryMode,
    sourceLane,
    entryFamily,
    baseline: {
      priceUsd: firstPositive(record.priceUsd, record.price, record.currentPriceUsd),
      marketCapUsd: baselineMarketCapUsd,
      fdvUsd: baselineFdvUsd,
      liquidityUsd: firstFinite(record.liquidityUsd, record.poolLiq, record.liquidity),
      volume1hUsd: firstFinite(record.volume1hUsd, record.volume1h),
      momentum1m: firstFinite(record.momentum1m, record.priceChange1m),
      momentum5m: firstFinite(record.momentum5m, record.priceChange5m),
    },
    context: {
      tokenAgeSec: record.tokenAgeSec,
      buyRatio: record.buyRatio,
      buys1h: record.buys1h,
      sells1h: record.sells1h,
      buys60s: record.buys60s,
      sells60s: record.sells60s,
      buyRatio60s: record.buyRatio60s,
      velocity: record.velocity,
      solVolume60s: record.solVolume60s,
    },
    horizons: horizonsSec.map((horizonSec) => ({
      horizonSec,
      dueAt: now + horizonSec * 1000,
      status: 'pending',
    })),
  };
}

function compactPendingItems(items: MarkoutPendingItem[], maxPending: number): MarkoutPendingItem[] {
  return items
    .filter((item) => item && item.mint && Array.isArray(item.horizons) && item.horizons.some((h) => h.status === 'pending'))
    .sort((a, b) => Number(b.scheduledAt || 0) - Number(a.scheduledAt || 0))
    .slice(0, Math.max(1, maxPending));
}

export function loadMarkoutPending(options?: { pendingFilePath?: string }): MarkoutPendingItem[] {
  const pendingFilePath = options?.pendingFilePath || MARKOUT_PENDING_FILE;
  try {
    if (!fs.existsSync(pendingFilePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(pendingFilePath, 'utf-8'));
    const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
    return items.filter(Boolean);
  } catch {
    return [];
  }
}

function writeMarkoutPending(items: MarkoutPendingItem[], options?: { pendingFilePath?: string; maxPending?: number }) {
  const pendingFilePath = options?.pendingFilePath || MARKOUT_PENDING_FILE;
  const maxPending = Math.max(1, Math.round(toFiniteNumber(options?.maxPending, DEFAULT_MAX_PENDING)));
  ensureDirFor(pendingFilePath);
  fs.writeFileSync(
    pendingFilePath,
    JSON.stringify({ generatedAt: Date.now(), items: compactPendingItems(items, maxPending) }, null, 2),
    'utf-8',
  );
}

export function scheduleMarkout(record: JsonRow = {}, options?: {
  now?: number;
  horizonsSec?: number[];
  pendingFilePath?: string;
  maxPending?: number;
}): { scheduled: boolean; reason: string; key?: string; pendingCount: number } {
  const now = Math.max(0, toFiniteNumber(options?.now, Date.now())) || Date.now();
  const mint = normalizeMint(record.mint);
  if (!mint) return { scheduled: false, reason: 'missing_mint', pendingCount: loadMarkoutPending(options).length };
  const action = normalizeString(record.action, '');
  if (action === 'buy' || action === 'sell') {
    return { scheduled: false, reason: 'not_reject', pendingCount: loadMarkoutPending(options).length };
  }

  const horizonsSec = (Array.isArray(options?.horizonsSec) && options?.horizonsSec.length ? options.horizonsSec : DEFAULT_HORIZONS_SEC)
    .map((value) => Math.max(1, Math.round(toFiniteNumber(value, 0))))
    .filter(Boolean)
    .sort((a, b) => a - b);
  const item = buildPendingItem(record, now, horizonsSec);
  const pending = loadMarkoutPending(options);
  if (pending.some((existing) => existing.key === item.key && existing.horizons?.some((h) => h.status === 'pending'))) {
    return { scheduled: false, reason: 'already_pending', key: item.key, pendingCount: pending.length };
  }

  pending.push(item);
  writeMarkoutPending(pending, options);
  return { scheduled: true, reason: 'scheduled', key: item.key, pendingCount: pending.length };
}

function normalizePairSnapshot(pair: JsonRow | null | undefined) {
  if (!pair) return null;
  return {
    priceUsd: firstPositive(pair.priceUsd, pair.price),
    marketCapUsd: firstPositive(pair.marketCapUsd, pair.marketCap, pair.fdvUsd, pair.fdv),
    fdvUsd: firstPositive(pair.fdvUsd, pair.fdv, pair.marketCapUsd, pair.marketCap),
    liquidityUsd: firstFinite(pair.liquidityUsd, pair.liquidity),
    volume1hUsd: firstFinite(pair.volume1hUsd, pair.volume1h),
    momentum5m: firstFinite(pair.momentum5m, pair.priceChange5m),
  };
}

function classifyMarkout(item: MarkoutPendingItem, horizonSec: number, pair: JsonRow | null, now: number): MarkoutResult {
  const current = normalizePairSnapshot(pair);
  const priceReturnPct = percentageChange(item.baseline.priceUsd, current?.priceUsd ?? null);
  const marketCapReturnPct = percentageChange(item.baseline.marketCapUsd || item.baseline.fdvUsd, current?.marketCapUsd || current?.fdvUsd || null);
  const directReturnCandidates = [priceReturnPct, marketCapReturnPct].filter((value) => Number.isFinite(Number(value)));
  const returnCandidates = directReturnCandidates.length > 0
    ? directReturnCandidates
    : [current?.momentum5m ?? null].filter((value) => Number.isFinite(Number(value)));
  const returnPct = returnCandidates.length
    ? Number(Math.max(...returnCandidates.map((value) => Number(value))).toFixed(6))
    : null;
  const currentLiquidityUsd = current?.liquidityUsd ?? null;
  const liquidityDeltaUsd =
    Number.isFinite(Number(currentLiquidityUsd)) && Number.isFinite(Number(item.baseline.liquidityUsd))
      ? Number((Number(currentLiquidityUsd) - Number(item.baseline.liquidityUsd)).toFixed(6))
      : null;
  const hasPair = Boolean(current);
  const missedWinner =
    hasPair &&
    Number.isFinite(Number(returnPct)) &&
    Number(returnPct) >= DEFAULT_MISSED_WINNER_RETURN_PCT &&
    (
      Number(currentLiquidityUsd || 0) > 0 ||
      Number(current?.marketCapUsd || current?.fdvUsd || 0) > 0
    );
  const correctReject =
    !missedWinner &&
    (
      !hasPair ||
      Number(returnPct || 0) <= 0 ||
      (Number(currentLiquidityUsd || 0) <= 0 && Number(current?.marketCapUsd || current?.fdvUsd || 0) <= 0)
    );
  const status: MarkoutResult['status'] = missedWinner
    ? 'missed_winner'
    : correctReject
      ? (hasPair ? 'correct_reject' : 'no_pair')
      : 'neutral';

  return {
    eventType: 'reject_markout',
    ts: now,
    key: item.key,
    mint: item.mint,
    symbol: item.symbol,
    stage: item.stage,
    reason: item.reason,
    entryMode: item.entryMode,
    sourceLane: item.sourceLane,
    entryFamily: item.entryFamily,
    horizonSec,
    baselineAt: item.baselineAt,
    scheduledAt: item.scheduledAt,
    status,
    missedWinner,
    correctReject,
    returnPct,
    priceReturnPct,
    marketCapReturnPct,
    liquidityDeltaUsd,
    baselinePriceUsd: item.baseline.priceUsd,
    currentPriceUsd: current?.priceUsd ?? null,
    baselineMarketCapUsd: item.baseline.marketCapUsd || item.baseline.fdvUsd,
    currentMarketCapUsd: current?.marketCapUsd || current?.fdvUsd || null,
    baselineLiquidityUsd: item.baseline.liquidityUsd,
    currentLiquidityUsd,
    currentMomentum5m: current?.momentum5m ?? null,
    currentVolume1hUsd: current?.volume1hUsd ?? null,
  };
}

function appendResult(row: MarkoutResult, resultsFilePath: string) {
  ensureDirFor(resultsFilePath);
  fs.appendFileSync(resultsFilePath, JSON.stringify(row) + '\n', 'utf-8');
}

function readTailJsonl(filePath: string, maxRows: number): JsonRow[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const text = fs.readFileSync(filePath, 'utf-8');
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-Math.max(1, maxRows))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean) as JsonRow[];
  } catch {
    return [];
  }
}

function createSummaryBucket(): MarkoutSummaryBucket {
  return {
    samples: 0,
    missedWinners: 0,
    correctRejects: 0,
    neutral: 0,
    noPair: 0,
    missedWinnerRate: 0,
    correctRejectRate: 0,
    avgReturnPct: 0,
    maxReturnPct: 0,
    avgLiquidityDeltaUsd: 0,
    lastSeenAt: null,
    lastMint: null,
    lastSymbol: null,
  };
}

function ensureBucket(collection: Record<string, MarkoutSummaryBucket>, key: string) {
  const normalized = normalizeString(key);
  if (!collection[normalized]) collection[normalized] = createSummaryBucket();
  return collection[normalized];
}

function updateSummaryBucket(bucket: MarkoutSummaryBucket, row: JsonRow) {
  bucket.samples += 1;
  if (row.status === 'no_pair') bucket.noPair += 1;
  if (row.missedWinner === true || row.status === 'missed_winner') bucket.missedWinners += 1;
  else if (row.correctReject === true || row.status === 'correct_reject') bucket.correctRejects += 1;
  else bucket.neutral += 1;

  const returnPct = finiteOrNull(row.returnPct);
  if (returnPct !== null) {
    bucket.avgReturnPct = Number((((bucket.avgReturnPct * (bucket.samples - 1)) + returnPct) / bucket.samples).toFixed(6));
    bucket.maxReturnPct = Number(Math.max(bucket.maxReturnPct, returnPct).toFixed(6));
  }
  const liquidityDeltaUsd = finiteOrNull(row.liquidityDeltaUsd);
  if (liquidityDeltaUsd !== null) {
    bucket.avgLiquidityDeltaUsd = Number((((bucket.avgLiquidityDeltaUsd * (bucket.samples - 1)) + liquidityDeltaUsd) / bucket.samples).toFixed(6));
  }
  bucket.missedWinnerRate = Number((bucket.missedWinners / Math.max(1, bucket.samples)).toFixed(6));
  bucket.correctRejectRate = Number((bucket.correctRejects / Math.max(1, bucket.samples)).toFixed(6));
  bucket.lastSeenAt = Math.max(Number(bucket.lastSeenAt || 0), toFiniteNumber(row.ts, 0)) || bucket.lastSeenAt;
  bucket.lastMint = row.mint || bucket.lastMint;
  bucket.lastSymbol = row.symbol || bucket.lastSymbol;
}

export function buildMarkoutSummaryFromRows(rowsInput: JsonRow[]): MarkoutSummary {
  const rows = Array.isArray(rowsInput) ? rowsInput.filter(Boolean) : [];
  const summary: MarkoutSummary = {
    generatedAt: Date.now(),
    rows: rows.length,
    totals: createSummaryBucket(),
    byLane: {},
    byStage: {},
    byReason: {},
  };
  for (const row of rows) {
    updateSummaryBucket(summary.totals, row);
    updateSummaryBucket(ensureBucket(summary.byLane, row.sourceLane || row.entryFamily || row.entryMode), row);
    updateSummaryBucket(ensureBucket(summary.byStage, row.stage), row);
    updateSummaryBucket(ensureBucket(summary.byReason, row.reason), row);
  }
  return summary;
}

function writeSummaryFromResults(resultsFilePath: string, summaryFilePath: string) {
  const rows = readTailJsonl(resultsFilePath, DEFAULT_MAX_RESULTS_FOR_SUMMARY);
  const summary = buildMarkoutSummaryFromRows(rows);
  ensureDirFor(summaryFilePath);
  fs.writeFileSync(summaryFilePath, JSON.stringify(summary, null, 2), 'utf-8');
  return summary;
}

export async function processDueMarkouts(options: {
  now?: number;
  fetchPair: (mint: string) => Promise<JsonRow | null> | JsonRow | null;
  maxPerRun?: number;
  pendingFilePath?: string;
  resultsFilePath?: string;
  summaryFilePath?: string;
  maxPending?: number;
}): Promise<{ processed: number; remaining: number; missedWinners: number; correctRejects: number }> {
  const now = Math.max(0, toFiniteNumber(options?.now, Date.now())) || Date.now();
  const maxPerRun = Math.max(1, Math.round(toFiniteNumber(options?.maxPerRun, 8)));
  const pendingFilePath = options?.pendingFilePath || MARKOUT_PENDING_FILE;
  const resultsFilePath = options?.resultsFilePath || MARKOUT_RESULTS_FILE;
  const summaryFilePath = options?.summaryFilePath || MARKOUT_SUMMARY_FILE;
  const pending = loadMarkoutPending({ pendingFilePath });
  let processed = 0;
  let missedWinners = 0;
  let correctRejects = 0;

  const due: Array<{ item: MarkoutPendingItem; horizon: MarkoutPendingItem['horizons'][number] }> = [];
  for (const item of pending) {
    for (const horizon of item.horizons || []) {
      if (horizon.status === 'pending' && Number(horizon.dueAt || 0) <= now) {
        due.push({ item, horizon });
      }
    }
  }
  due.sort((a, b) => Number(a.horizon.dueAt || 0) - Number(b.horizon.dueAt || 0));

  for (const { item, horizon } of due.slice(0, maxPerRun)) {
    const pair = await options.fetchPair(item.mint);
    const result = classifyMarkout(item, horizon.horizonSec, pair, now);
    appendResult(result, resultsFilePath);
    horizon.status = 'done';
    horizon.resultAt = now;
    processed += 1;
    if (result.missedWinner) missedWinners += 1;
    if (result.correctReject) correctRejects += 1;
  }

  const remainingItems = compactPendingItems(pending, Math.max(1, Math.round(toFiniteNumber(options?.maxPending, DEFAULT_MAX_PENDING))));
  writeMarkoutPending(remainingItems, { pendingFilePath, maxPending: options?.maxPending });
  if (processed > 0) writeSummaryFromResults(resultsFilePath, summaryFilePath);

  return {
    processed,
    remaining: remainingItems.reduce((sum, item) => sum + (item.horizons || []).filter((h) => h.status === 'pending').length, 0),
    missedWinners,
    correctRejects,
  };
}

module.exports = {
  scheduleMarkout,
  loadMarkoutPending,
  processDueMarkouts,
  buildMarkoutSummaryFromRows,
};
