import fs from 'fs';
import path from 'path';

const { buildClosedTradeEpisodesFromRows } = require('./ev_ranking_logic.ts');

const ROOT = process.cwd();
const SIGNALS_DIR = path.join(ROOT, 'signals');
const IS_PAPER = process.env.PAPER_MODE === 'true';
const TARGET_QUALITY_LEDGER_FILE = path.join(
  SIGNALS_DIR,
  IS_PAPER ? 'target_quality_ledger_paper.jsonl' : 'target_quality_ledger.jsonl',
);
const TARGET_QUALITY_SUMMARY_FILE = path.join(
  SIGNALS_DIR,
  IS_PAPER ? 'target_quality_governor_paper.json' : 'target_quality_governor.json',
);
const TRADE_JOURNAL_FILE = path.join(
  SIGNALS_DIR,
  IS_PAPER ? 'trade_journal_paper.jsonl' : 'trade_journal.jsonl',
);
const MISSED_TARGETS_FILE = path.join(SIGNALS_DIR, 'missed_targets.jsonl');

const DEFAULT_MAX_LEDGER_LINES = 15_000;
const DEFAULT_CACHE_TTL_MS = 15_000;

type JsonRow = Record<string, any>;

export interface TargetQualityBucketStats {
  impressions: number;
  rejects: number;
  entries: number;
  closedTrades: number;
  wins: number;
  losses: number;
  totalPnlSol: number;
  avgPnlSol: number;
  winRate: number;
  rejectRate: number;
  lastSeenAt: number | null;
  lastEntryAt: number | null;
  lastRejectAt: number | null;
  lastCloseAt: number | null;
  lastSymbol: string | null;
  lastMint: string | null;
  topRejectReasons: Record<string, number>;
}

export interface TargetQualitySummary {
  generatedAt: number;
  ledgerFile: string;
  source: 'target_quality_ledger';
  rows: number;
  totals: TargetQualityBucketStats;
  byLane: Record<string, TargetQualityBucketStats>;
  byEntryFamily: Record<string, TargetQualityBucketStats>;
  byEntryMode: Record<string, TargetQualityBucketStats>;
  byRejectReason: Record<string, TargetQualityBucketStats>;
}

export interface TargetQualityGovernorDecision {
  enabled: boolean;
  lane: string;
  entryFamily: string;
  entryMode: string;
  shouldSkip: boolean;
  skipReason: string | null;
  cooldownSeconds: number;
  positionMultiplier: number;
  rankMultiplier: number;
  rankPenalty: number;
  confidence: number;
  rejectRate: number;
  closedTrades: number;
  avgPnlSol: number;
  totalPnlSol: number;
  laneStats: TargetQualityBucketStats;
  familyStats: TargetQualityBucketStats;
}

export interface TargetQualityGovernorConfig {
  enabled?: boolean;
  minClosedTradesForScale?: number;
  minClosedTradesForBlock?: number;
  minImpressionsForRejectPressure?: number;
  maxRejectRateForScale?: number;
  maxRejectRateForBlock?: number;
  negativeAvgPnlScaleSol?: number;
  negativeAvgPnlBlockSol?: number;
  negativeTotalPnlBlockSol?: number;
  positiveAvgPnlPromoteSol?: number;
  minConfidenceForBlock?: number;
  minExpectedValueForBlockSol?: number;
  cooldownSeconds?: number;
}

const DEFAULT_GOVERNOR_CONFIG: Required<TargetQualityGovernorConfig> = {
  enabled: process.env.TARGET_QUALITY_GOVERNOR_ENABLED !== 'false',
  minClosedTradesForScale: 4,
  minClosedTradesForBlock: 10,
  minImpressionsForRejectPressure: 25,
  maxRejectRateForScale: 0.86,
  maxRejectRateForBlock: 0.94,
  negativeAvgPnlScaleSol: -0.00012,
  negativeAvgPnlBlockSol: -0.00035,
  negativeTotalPnlBlockSol: -0.004,
  positiveAvgPnlPromoteSol: 0.00012,
  minConfidenceForBlock: 0.58,
  minExpectedValueForBlockSol: -0.00003,
  cooldownSeconds: 90,
};

let cachedSummary: { mtimeMs: number; loadedAt: number; summary: TargetQualitySummary } | null = null;

function toFiniteNumber(value: any, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeString(value: any, fallback = 'unknown'): string {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || fallback;
}

export function normalizeTargetQualityLane(input: JsonRow = {}): string {
  const sourceLane = normalizeString(input.sourceLane || input.source_lane, '');
  const entryFamily = normalizeString(input.entryFamily || input.entry_family, '');
  const entryMode = normalizeString(input.entryMode || input.entry_mode, '');
  const entrySource = normalizeString(input.entrySource || input.entry_source || input.source, '');

  const raw = sourceLane || entryFamily || entryMode || entrySource || 'unknown';
  if (raw === 'velocity-first' || raw === 'velocity-first-preflight' || raw === 'velocity') return 'velocity';
  if (raw === 'wallet-signal' || raw === 'wallet') return 'wallet';
  if (raw === 'alpha' || raw === 'alpha-quota') return 'alpha';
  if (raw === 'mature-fallback') return 'mature-fallback';
  if (raw === 'last-stand') return 'last-stand';
  if (raw === 'micro-fast-track' || raw === 'micro-probe' || raw === 'micro-core' || raw === 'micro-scout') return 'micro-scout';
  if (raw === 'velocity-arbitrage') return 'velocity-arbitrage';
  if (raw.includes('gmgn')) return 'gmgn';
  return raw;
}

function createEmptyBucketStats(): TargetQualityBucketStats {
  return {
    impressions: 0,
    rejects: 0,
    entries: 0,
    closedTrades: 0,
    wins: 0,
    losses: 0,
    totalPnlSol: 0,
    avgPnlSol: 0,
    winRate: 0,
    rejectRate: 0,
    lastSeenAt: null,
    lastEntryAt: null,
    lastRejectAt: null,
    lastCloseAt: null,
    lastSymbol: null,
    lastMint: null,
    topRejectReasons: {},
  };
}

function ensureBucket(collection: Record<string, TargetQualityBucketStats>, key: string) {
  const normalized = normalizeString(key);
  if (!collection[normalized]) collection[normalized] = createEmptyBucketStats();
  return collection[normalized];
}

function updateSeen(stats: TargetQualityBucketStats, row: JsonRow, ts: number) {
  stats.lastSeenAt = Math.max(Number(stats.lastSeenAt || 0), ts) || ts;
  stats.lastSymbol = row.symbol || stats.lastSymbol;
  stats.lastMint = row.mint || stats.lastMint;
}

function updateImpression(stats: TargetQualityBucketStats, row: JsonRow, ts: number, isReject: boolean) {
  stats.impressions += 1;
  updateSeen(stats, row, ts);
  if (isReject) {
    stats.rejects += 1;
    stats.lastRejectAt = ts;
    const reason = normalizeString(row.reason || row.rejectReason || 'unknown');
    stats.topRejectReasons[reason] = (stats.topRejectReasons[reason] || 0) + 1;
  } else {
    stats.entries += 1;
    stats.lastEntryAt = ts;
  }
  stats.rejectRate = Number((stats.rejects / Math.max(1, stats.impressions)).toFixed(6));
}

function updateOutcome(stats: TargetQualityBucketStats, pnlSol: number, ts: number, row: JsonRow) {
  stats.closedTrades += 1;
  if (pnlSol > 0) stats.wins += 1;
  else stats.losses += 1;
  stats.totalPnlSol = Number((stats.totalPnlSol + pnlSol).toFixed(9));
  stats.avgPnlSol = Number((stats.totalPnlSol / Math.max(1, stats.closedTrades)).toFixed(9));
  stats.winRate = Number((stats.wins / Math.max(1, stats.closedTrades)).toFixed(6));
  stats.lastCloseAt = ts;
  updateSeen(stats, row, ts);
}

function getRowTs(row: JsonRow): number {
  return Math.max(
    0,
    toFiniteNumber(row.ts, 0) ||
      toFiniteNumber(row.timestamp, 0) ||
      toFiniteNumber(row.closedAt, 0) ||
      toFiniteNumber(row.openedAt, 0),
  ) || Date.now();
}

function getEventType(row: JsonRow): 'entry' | 'outcome' | 'reject' | 'other' {
  const eventType = normalizeString(row.eventType || row.event_type, '');
  if (eventType === 'entry' || eventType === 'buy') return 'entry';
  if (eventType === 'outcome' || eventType === 'sell') return 'outcome';
  if (eventType === 'reject' || eventType === 'missed-target') return 'reject';

  const action = normalizeString(row.action, '');
  if (action === 'buy') return 'entry';
  if (action === 'sell') return 'outcome';
  if (action === 'reject' || action === 'missed_target') return 'reject';
  if (row.reason && !row.sig && !row.tradeId) return 'reject';
  return 'other';
}

function applyToDimensions(summary: TargetQualitySummary, row: JsonRow, callback: (stats: TargetQualityBucketStats) => void) {
  callback(summary.totals);
  callback(ensureBucket(summary.byLane, normalizeTargetQualityLane(row)));
  callback(ensureBucket(summary.byEntryFamily, normalizeString(row.entryFamily || row.entry_family || 'unknown')));
  callback(ensureBucket(summary.byEntryMode, normalizeString(row.entryMode || row.entry_mode || 'unknown')));
  if (getEventType(row) === 'reject') {
    callback(ensureBucket(summary.byRejectReason, normalizeString(row.reason || row.rejectReason || 'unknown')));
  }
}

function createEmptySummary(rowCount = 0): TargetQualitySummary {
  return {
    generatedAt: Date.now(),
    ledgerFile: TARGET_QUALITY_LEDGER_FILE,
    source: 'target_quality_ledger',
    rows: rowCount,
    totals: createEmptyBucketStats(),
    byLane: {},
    byEntryFamily: {},
    byEntryMode: {},
    byRejectReason: {},
  };
}

export function buildTargetQualitySummaryFromRows(rowsInput: JsonRow[]): TargetQualitySummary {
  const rows = Array.isArray(rowsInput) ? rowsInput.filter(Boolean) : [];
  const summary = createEmptySummary(rows.length);

  for (const row of rows) {
    const eventType = getEventType(row);
    if (eventType !== 'entry' && eventType !== 'reject') continue;
    const ts = getRowTs(row);
    applyToDimensions(summary, row, (stats) => {
      updateImpression(stats, row, ts, eventType === 'reject');
    });
  }

  const tradeRows = rows.filter((row) => {
    const eventType = getEventType(row);
    return eventType === 'entry' || eventType === 'outcome';
  });
  const episodes = buildClosedTradeEpisodesFromRows(tradeRows);
  for (const episode of episodes) {
    const buy = episode.buy || {};
    const pnlSol = toFiniteNumber(episode.pnlSol, 0);
    const closedAt = toFiniteNumber(episode.closedAt, Date.now());
    applyToDimensions(summary, buy, (stats) => {
      updateOutcome(stats, pnlSol, closedAt, buy);
    });
  }

  summary.generatedAt = Date.now();
  return summary;
}

function readTailText(filePath: string, targetLineCount: number) {
  const stat = fs.statSync(filePath);
  let bytesToRead = Math.min(stat.size, Math.max(512 * 1024, Math.max(1, targetLineCount) * 2048));

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

    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length >= targetLineCount || start === 0 || bytesToRead >= stat.size) {
      return lines.slice(-Math.max(1, targetLineCount));
    }
    bytesToRead = Math.min(stat.size, bytesToRead * 2);
  }
}

function readJsonlRows(filePath: string, limit = DEFAULT_MAX_LEDGER_LINES): JsonRow[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    return readTailText(filePath, Math.max(1, limit))
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

function dedupeTargetQualityRows(rows: JsonRow[]): JsonRow[] {
  const seen = new Set<string>();
  const out: JsonRow[] = [];

  for (const row of rows || []) {
    if (!row || typeof row !== 'object') continue;
    const action = normalizeString(row.action, '');
    const eventType = getEventType(row);
    const ts = getRowTs(row);
    const mint = String(row.mint || '').trim();
    const reason = normalizeString(row.reason || row.rejectReason || '');
    const sig = String(row.sig || row.signature || '').trim();
    const tradeId = String(row.tradeId || '').trim();
    const parentBuyId = String(row.parentBuyId || '').trim();
    const key = sig
      ? `${eventType}:${action}:${sig}`
      : tradeId || parentBuyId
        ? `${eventType}:${action}:${tradeId}:${parentBuyId}`
        : `${eventType}:${mint}:${reason}:${Math.floor(ts / 1000)}:${normalizeString(row.stage || '')}`;

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }

  return out;
}

function writeSummary(summary: TargetQualitySummary) {
  try {
    if (process.env.TARGET_QUALITY_WRITE_SUMMARY === 'false') return;
    if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });
    fs.writeFileSync(TARGET_QUALITY_SUMMARY_FILE, JSON.stringify(summary, null, 2), 'utf-8');
  } catch {
    // Governor telemetry is best-effort; never interrupt trading.
  }
}

export function loadTargetQualitySummary(options?: {
  filePath?: string;
  maxLedgerLines?: number;
  forceRefresh?: boolean;
  cacheTtlMs?: number;
}): TargetQualitySummary {
  const filePath = options?.filePath || TARGET_QUALITY_LEDGER_FILE;
  const cacheTtlMs = Math.max(1_000, Number(options?.cacheTtlMs || DEFAULT_CACHE_TTL_MS));
  const maxLedgerLines = Math.max(100, Math.round(Number(options?.maxLedgerLines || DEFAULT_MAX_LEDGER_LINES)));

  let mtimeMs = -1;
  try {
    mtimeMs = fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : -1;
  } catch {
    mtimeMs = -1;
  }

  if (
    !options?.forceRefresh &&
    cachedSummary &&
    cachedSummary.mtimeMs === mtimeMs &&
    Date.now() - cachedSummary.loadedAt <= cacheTtlMs
  ) {
    return cachedSummary.summary;
  }

  const ledgerRows = readJsonlRows(filePath, maxLedgerLines);
  const journalRows = readJsonlRows(TRADE_JOURNAL_FILE, maxLedgerLines);
  const missedRows = readJsonlRows(MISSED_TARGETS_FILE, maxLedgerLines);
  const rows = dedupeTargetQualityRows([...journalRows, ...missedRows, ...ledgerRows]);
  const summary = buildTargetQualitySummaryFromRows(rows);
  summary.ledgerFile = filePath;
  cachedSummary = { mtimeMs, loadedAt: Date.now(), summary };
  writeSummary(summary);
  return summary;
}

function normalizeConfig(config?: TargetQualityGovernorConfig): Required<TargetQualityGovernorConfig> {
  return {
    ...DEFAULT_GOVERNOR_CONFIG,
    ...(config || {}),
  };
}

function weightedBucketStats(laneStats: TargetQualityBucketStats, familyStats: TargetQualityBucketStats) {
  const laneWeight = Math.min(1, laneStats.closedTrades / 12) * 0.7;
  const familyWeight = Math.min(1, familyStats.closedTrades / 12) * 0.3;
  const totalWeight = laneWeight + familyWeight;
  if (totalWeight <= 0) {
    return {
      closedTrades: laneStats.closedTrades,
      avgPnlSol: laneStats.avgPnlSol,
      totalPnlSol: laneStats.totalPnlSol,
      winRate: laneStats.winRate,
    };
  }
  return {
    closedTrades: laneStats.closedTrades + familyStats.closedTrades,
    avgPnlSol: Number((((laneStats.avgPnlSol * laneWeight) + (familyStats.avgPnlSol * familyWeight)) / totalWeight).toFixed(9)),
    totalPnlSol: Number((laneStats.totalPnlSol + familyStats.totalPnlSol).toFixed(9)),
    winRate: Number((((laneStats.winRate * laneWeight) + (familyStats.winRate * familyWeight)) / totalWeight).toFixed(6)),
  };
}

export function evaluateTargetQualityGovernor(
  input: JsonRow = {},
  options?: {
    summary?: TargetQualitySummary | null;
    config?: TargetQualityGovernorConfig;
  },
): TargetQualityGovernorDecision {
  const config = normalizeConfig(options?.config);
  const summary = options?.summary || loadTargetQualitySummary();
  const lane = normalizeTargetQualityLane(input);
  const entryFamily = normalizeString(input.entryFamily || input.entry_family || lane);
  const entryMode = normalizeString(input.entryMode || input.entry_mode || 'unknown');
  const empty = createEmptyBucketStats();
  const laneStats = summary?.byLane?.[lane] || empty;
  const familyStats = summary?.byEntryFamily?.[entryFamily] || empty;
  const blended = weightedBucketStats(laneStats, familyStats);
  const rejectRate = laneStats.rejectRate;
  const evidenceConfidence = clamp(
    0.08 +
      Math.min(0.55, blended.closedTrades / 24) +
      Math.min(0.25, laneStats.impressions / 120) +
      Math.min(0.12, laneStats.rejects / 80),
    0.05,
    0.95,
  );
  const expectedValueSol = toFiniteNumber(
    input.expectedValueSol ?? input.expectedPnlSol ?? input.expectedValueDecision?.expectedPnlSol,
    0,
  );

  let positionMultiplier = 1;
  let rankMultiplier = 1;
  let rankPenalty = 0;
  let shouldSkip = false;
  let skipReason: string | null = null;

  if (!config.enabled) {
    return {
      enabled: false,
      lane,
      entryFamily,
      entryMode,
      shouldSkip: false,
      skipReason: null,
      cooldownSeconds: config.cooldownSeconds,
      positionMultiplier,
      rankMultiplier,
      rankPenalty,
      confidence: Number(evidenceConfidence.toFixed(6)),
      rejectRate: Number(rejectRate.toFixed(6)),
      closedTrades: blended.closedTrades,
      avgPnlSol: blended.avgPnlSol,
      totalPnlSol: blended.totalPnlSol,
      laneStats,
      familyStats,
    };
  }

  if (blended.closedTrades >= config.minClosedTradesForScale) {
    if (blended.avgPnlSol <= config.negativeAvgPnlScaleSol) {
      const severity = clamp(Math.abs(blended.avgPnlSol / Math.min(-0.00001, config.negativeAvgPnlScaleSol)), 0, 3);
      positionMultiplier *= clamp(1 - severity * 0.22, 0.42, 0.92);
      rankMultiplier *= clamp(1 - severity * 0.28, 0.22, 0.88);
      rankPenalty += Math.min(0.0000015, Math.abs(blended.avgPnlSol) * 0.001);
    } else if (blended.avgPnlSol >= config.positiveAvgPnlPromoteSol) {
      const strength = clamp(blended.avgPnlSol / Math.max(0.00001, config.positiveAvgPnlPromoteSol), 0, 3);
      positionMultiplier *= clamp(1 + strength * 0.10, 1.02, 1.35);
      rankMultiplier *= clamp(1 + strength * 0.12, 1.02, 1.45);
    }
  }

  if (
    laneStats.impressions >= config.minImpressionsForRejectPressure &&
    rejectRate >= config.maxRejectRateForScale
  ) {
    const pressure = clamp((rejectRate - config.maxRejectRateForScale) / Math.max(0.01, 1 - config.maxRejectRateForScale), 0, 1);
    positionMultiplier *= clamp(1 - pressure * 0.25, 0.65, 1);
    rankMultiplier *= clamp(1 - pressure * 0.45, 0.35, 1);
    rankPenalty += pressure * 0.0000005;
  }

  const hardNegativeLane =
    blended.closedTrades >= config.minClosedTradesForBlock &&
    blended.avgPnlSol <= config.negativeAvgPnlBlockSol &&
    blended.totalPnlSol <= config.negativeTotalPnlBlockSol &&
    evidenceConfidence >= config.minConfidenceForBlock &&
    expectedValueSol <= config.minExpectedValueForBlockSol;
  const highRejectNegativeLane =
    laneStats.impressions >= config.minImpressionsForRejectPressure &&
    rejectRate >= config.maxRejectRateForBlock &&
    blended.closedTrades >= config.minClosedTradesForScale &&
    blended.avgPnlSol < 0 &&
    expectedValueSol <= 0 &&
    evidenceConfidence >= 0.45;

  if (hardNegativeLane || highRejectNegativeLane) {
    shouldSkip = true;
    skipReason = hardNegativeLane
      ? `lane ${lane} has negative realized EV (${blended.avgPnlSol.toFixed(6)} SOL avg over ${blended.closedTrades} closes)`
      : `lane ${lane} has ${(rejectRate * 100).toFixed(1)}% reject pressure and negative realized EV`;
    positionMultiplier = 0;
    rankMultiplier = 0.05;
    rankPenalty += 0.000003;
  }

  return {
    enabled: true,
    lane,
    entryFamily,
    entryMode,
    shouldSkip,
    skipReason,
    cooldownSeconds: config.cooldownSeconds,
    positionMultiplier: Number(clamp(positionMultiplier, 0, 1.5).toFixed(6)),
    rankMultiplier: Number(clamp(rankMultiplier, 0.05, 1.6).toFixed(6)),
    rankPenalty: Number(rankPenalty.toFixed(9)),
    confidence: Number(evidenceConfidence.toFixed(6)),
    rejectRate: Number(rejectRate.toFixed(6)),
    closedTrades: blended.closedTrades,
    avgPnlSol: blended.avgPnlSol,
    totalPnlSol: blended.totalPnlSol,
    laneStats,
    familyStats,
  };
}

export function resolveGovernedRankScore(evRankScore: number, decision?: Partial<TargetQualityGovernorDecision> | null): number {
  const base = toFiniteNumber(evRankScore, 0);
  const multiplier = clamp(toFiniteNumber(decision?.rankMultiplier, 1), 0.05, 1.6);
  const penalty = Math.max(0, toFiniteNumber(decision?.rankPenalty, 0));
  const governed = base >= 0
    ? (base * multiplier) - penalty
    : (base / multiplier) - penalty;
  return Number(governed.toFixed(9));
}

export function appendTargetQualityLedgerEvent(record: JsonRow = {}, options?: { filePath?: string }) {
  try {
    if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });
    const action = normalizeString(record.action, '');
    const eventType = action === 'buy'
      ? 'entry'
      : action === 'sell'
        ? 'outcome'
        : 'reject';
    const ts = getRowTs(record);
    const payload = {
      eventType,
      ts,
      timestamp: ts,
      lane: normalizeTargetQualityLane(record),
      ...record,
    };
    fs.appendFileSync(options?.filePath || TARGET_QUALITY_LEDGER_FILE, `${JSON.stringify(payload)}\n`, 'utf-8');
    cachedSummary = null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = {
  appendTargetQualityLedgerEvent,
  buildTargetQualitySummaryFromRows,
  evaluateTargetQualityGovernor,
  loadTargetQualitySummary,
  normalizeTargetQualityLane,
  resolveGovernedRankScore,
};
