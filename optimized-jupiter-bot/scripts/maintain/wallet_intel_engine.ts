import fs from 'fs';
import path from 'path';
import https from 'https';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';

const {
  computeWalletWeightedScore,
} = require('./wallet_intel_logic.ts');
const {
  computeGmgnBanUntilMs,
  getGmgnBanWaitMs,
  isGmgnRateLimitMessage,
  isGmgnTemporaryBanMessage,
} = require('./gmgn_pressure_logic.ts');
const fetch = require('node-fetch');

dotenv.config({ path: path.join(process.cwd(), '.env') });

const ROOT_DIR = process.cwd();
const SIGNALS_DIR = path.join(ROOT_DIR, 'signals');
const ALPHA_WALLETS_FILE = path.join(SIGNALS_DIR, 'alpha_wallets.json');
const KOL_WALLETS_FILE = path.join(SIGNALS_DIR, 'kol_wallets.json');
const GMGN_SMARTMONEY_FILE = path.join(SIGNALS_DIR, 'gmgn_smartmoney.json');
const WALLET_SIGNALS_FILE = path.join(SIGNALS_DIR, 'wallet_signals.json');
const WALLET_INTEL_FILE = path.join(SIGNALS_DIR, 'wallet_intel.json');
const WALLET_PNL_FILE = path.join(SIGNALS_DIR, 'wallet_pnl.json');

const OPENAPI_HOST = (process.env.GMGN_HOST || 'https://openapi.gmgn.ai').replace(/\/$/, '');
const GMGN_API_KEY = String(process.env.GMGN_API_KEY || '').trim();
const IPV4_AGENT = new https.Agent({ family: 4 });

const POLL_MS = Math.max(60_000, Number(process.env.WALLET_INTEL_POLL_MS || 10 * 60_000));
const REFRESH_BATCH = Math.max(1, Number(process.env.WALLET_INTEL_REFRESH_BATCH || 1));
const CANDIDATE_LIMIT = Math.max(12, Number(process.env.WALLET_INTEL_CANDIDATE_LIMIT || 32));
const TRACK_LIMIT = Math.max(8, Number(process.env.WALLET_INTEL_TRACK_LIMIT || 12));
const TTL_30D_MS = Math.max(30 * 60_000, Number(process.env.WALLET_INTEL_TTL_30D_MS || 12 * 60 * 60_000));
const TTL_7D_MS = Math.max(15 * 60_000, Number(process.env.WALLET_INTEL_TTL_7D_MS || 6 * 60 * 60_000));
const REQUEST_GAP_MS = Math.max(500, Number(process.env.WALLET_INTEL_REQUEST_GAP_MS || 8_000));
const REQUEST_TIMEOUT_MS = Math.max(3_000, Number(process.env.WALLET_INTEL_REQUEST_TIMEOUT_MS || 10_000));
const BAN_COOLDOWN_MS = Math.max(5 * 60_000, Number(process.env.WALLET_INTEL_BAN_COOLDOWN_MS || 60 * 60_000));
const MAX_ATTEMPTS = Math.max(1, Number(process.env.WALLET_INTEL_MAX_ATTEMPTS || 2));

type JsonObject = Record<string, any>;

type WalletStatsResponse = {
  buy?: number | string;
  sell?: number | string;
  realized_profit?: number | string;
  realized_profit_pnl?: number | string;
  native_balance?: number | string;
  last_timestamp?: number | string;
  pnl_stat?: Record<string, any>;
  common?: Record<string, any>;
};

type WalletIntelCacheEntry = {
  wallet: string;
  fetched30dAt?: number;
  fetched7dAt?: number;
  stats30d?: WalletStatsResponse | null;
  stats7d?: WalletStatsResponse | null;
};

type WalletIntelDocument = {
  version: number;
  updated_at: number;
  source: string;
  refreshed_wallets?: string[];
  candidate_count?: number;
  tracked_wallets?: Record<string, any>[];
  wallets?: Record<string, any>[];
  cache?: Record<string, WalletIntelCacheEntry>;
  summary?: Record<string, any>;
};

let gmgnBanUntilMs = 0;

function ensureSignalsDir() {
  fs.mkdirSync(SIGNALS_DIR, { recursive: true });
}

function toFiniteNumber(value: any, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function loadJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function asArray<T = any>(value: any): T[] {
  return Array.isArray(value) ? value : [];
}

function writeJson(filePath: string, payload: unknown) {
  ensureSignalsDir();
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueStrings(values: Array<string | null | undefined>) {
  const normalized = Array.isArray(values) ? values : [values as any];
  return Array.from(
    new Set(
      normalized
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    ),
  );
}

async function gmgnGet(pathname: string, params: Record<string, any>) {
  if (!GMGN_API_KEY) throw new Error('GMGN_API_KEY missing');
  if (Date.now() < gmgnBanUntilMs) {
    throw new Error(`GMGN cooldown active until ${new Date(gmgnBanUntilMs).toISOString()}`);
  }

  let attempt = 0;
  let lastMessage = 'unknown';
  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    const url = new URL(`${OPENAPI_HOST}${pathname}`);
    for (const [key, value] of Object.entries(params || {})) {
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item));
      } else if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
    url.searchParams.set('timestamp', String(Math.floor(Date.now() / 1000)));
    url.searchParams.set('client_id', randomUUID());

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'X-APIKEY': GMGN_API_KEY,
          'Content-Type': 'application/json',
        },
        agent: IPV4_AGENT,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    let json: JsonObject = {};
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`GMGN non-JSON response (${response.status})`);
    }

    if (json.code === 0) return json.data;

    const message = String(json.message || json.error || `HTTP ${response.status}`);
    lastMessage = message;
    if (isGmgnTemporaryBanMessage(message)) {
      gmgnBanUntilMs = Math.max(gmgnBanUntilMs, computeGmgnBanUntilMs(message, BAN_COOLDOWN_MS));
      throw new Error(message);
    }
    if (response.status === 429 || json.code === 429 || isGmgnRateLimitMessage(message)) {
      const waitMs = getGmgnBanWaitMs(message, 15_000);
      if (attempt >= MAX_ATTEMPTS) break;
      await sleep(waitMs);
      continue;
    }
    throw new Error(message);
  }

  throw new Error(`GMGN request failed after retries: ${pathname} (${lastMessage})`);
}

function collectCandidateWallets() {
  const alphaDoc = loadJsonSafe<JsonObject>(ALPHA_WALLETS_FILE, {});
  const kolDoc = loadJsonSafe<JsonObject>(KOL_WALLETS_FILE, {});
  const walletSignalsDoc = loadJsonSafe<JsonObject>(WALLET_SIGNALS_FILE, {});
  const smartMoneyDoc = loadJsonSafe<JsonObject>(GMGN_SMARTMONEY_FILE, {});

  const tracked = [
    ...((alphaDoc.tracked_wallets || []) as any[]).map((row) => row?.address),
    ...((kolDoc.tracked_wallets || []) as any[]).map((row) => row?.address),
  ];
  const signalWallets = [
    ...((walletSignalsDoc.buy_signals || []) as any[]).flatMap((row) => row?.wallets || []),
    ...((walletSignalsDoc.sell_signals || []) as any[]).map((row) => row?.walletAddr),
  ];
  const flowWallets = [
    ...((smartMoneyDoc.buys || []) as any[]).map((row) => row?.maker),
    ...((smartMoneyDoc.sells || []) as any[]).map((row) => row?.maker),
  ];

  const unique = uniqueStrings([...tracked, ...signalWallets, ...flowWallets]);
  const trackedSet = new Set(uniqueStrings(tracked));
  const signalSet = new Set(uniqueStrings(signalWallets));
  const flowCounts = new Map<string, number>();
  for (const wallet of uniqueStrings(flowWallets)) {
    flowCounts.set(wallet, (flowCounts.get(wallet) || 0) + 1);
  }

  return unique
    .map((wallet) => ({
      wallet,
      tracked: trackedSet.has(wallet),
      activeSignal: signalSet.has(wallet),
      flowHits: flowCounts.get(wallet) || 0,
    }))
    .sort((left, right) =>
      Number(right.tracked) - Number(left.tracked) ||
      Number(right.activeSignal) - Number(left.activeSignal) ||
      right.flowHits - left.flowHits ||
      left.wallet.localeCompare(right.wallet),
    )
    .slice(0, CANDIDATE_LIMIT);
}

function buildWalletRow(wallet: string, stats30d: WalletStatsResponse, stats7d: WalletStatsResponse | null) {
  const d30Trades = Math.max(0, toFiniteNumber(stats30d?.buy) + toFiniteNumber(stats30d?.sell));
  const d7Trades = Math.max(0, toFiniteNumber(stats7d?.buy) + toFiniteNumber(stats7d?.sell));
  const tags = uniqueStrings(stats30d?.common?.tags || stats7d?.common?.tags || []);
  const twitter = String(stats30d?.common?.twitter_username || stats7d?.common?.twitter_username || '').trim();
  const derived = computeWalletWeightedScore({
    wallet,
    tags,
    twitter,
    d30: {
      trades: d30Trades,
      buy: toFiniteNumber(stats30d?.buy),
      sell: toFiniteNumber(stats30d?.sell),
      winrate: toFiniteNumber(stats30d?.pnl_stat?.winrate),
      realizedProfitUsd: toFiniteNumber(stats30d?.realized_profit),
      realizedProfitPnl: toFiniteNumber(stats30d?.realized_profit_pnl),
      nativeBalance: toFiniteNumber(stats30d?.native_balance),
      avgHoldingPeriodSec: toFiniteNumber(stats30d?.pnl_stat?.avg_holding_period),
      tokenNum: toFiniteNumber(stats30d?.pnl_stat?.token_num),
    },
    d7: stats7d ? {
      trades: d7Trades,
      buy: toFiniteNumber(stats7d?.buy),
      sell: toFiniteNumber(stats7d?.sell),
      winrate: toFiniteNumber(stats7d?.pnl_stat?.winrate),
      realizedProfitUsd: toFiniteNumber(stats7d?.realized_profit),
      realizedProfitPnl: toFiniteNumber(stats7d?.realized_profit_pnl),
      nativeBalance: toFiniteNumber(stats7d?.native_balance),
      avgHoldingPeriodSec: toFiniteNumber(stats7d?.pnl_stat?.avg_holding_period),
      tokenNum: toFiniteNumber(stats7d?.pnl_stat?.token_num),
    } : null,
  });

  return {
    walletAddr: wallet,
    profitabilityScore: derived.profitabilityScore,
    weightedScore: derived.weightedScore,
    winRate: toFiniteNumber(stats30d?.pnl_stat?.winrate),
    realizedProfitUsd: toFiniteNumber(stats30d?.realized_profit),
    realizedProfitPnl: toFiniteNumber(stats30d?.realized_profit_pnl),
    nativeBalance: toFiniteNumber(stats30d?.native_balance),
    lastTimestamp: Math.max(0, toFiniteNumber(stats30d?.last_timestamp)),
    tradeCount: d30Trades,
    buyCount: Math.max(0, toFiniteNumber(stats30d?.buy)),
    sellCount: Math.max(0, toFiniteNumber(stats30d?.sell)),
    avgHoldingPeriodSec: toFiniteNumber(stats30d?.pnl_stat?.avg_holding_period),
    tokenNum: Math.max(0, toFiniteNumber(stats30d?.pnl_stat?.token_num)),
    d7TradeCount: d7Trades,
    d7WinRate: toFiniteNumber(stats7d?.pnl_stat?.winrate),
    d7RealizedProfitUsd: toFiniteNumber(stats7d?.realized_profit),
    d7AvgHoldingPeriodSec: toFiniteNumber(stats7d?.pnl_stat?.avg_holding_period),
    primaryStyle: derived.primaryStyle,
    styleProfile: derived.styleProfile,
    copyabilityRisk: derived.copyabilityRisk,
    preferredHoldMs: derived.preferredHoldMs,
    executable: derived.executable,
    immediateEntry: derived.immediateEntry,
    scoreBreakdown: derived.scoreBreakdown,
    tags,
    twitter,
  };
}

function normalizeLegacyWalletRow(row: Record<string, any> | null | undefined) {
  const wallet = String(row?.walletAddr || row?.address || '').trim();
  if (!wallet) return null;

  const winRate = toFiniteNumber(row?.winRate ?? row?.winrate);
  const realizedProfitUsd = toFiniteNumber(row?.realizedProfitUsd);
  const realizedProfitPnl = toFiniteNumber(row?.realizedProfitPnl);
  const tradeCount = Math.max(
    0,
    toFiniteNumber(row?.tradeCount, toFiniteNumber(row?.buyCount) + toFiniteNumber(row?.sellCount)),
  );
  const buyCount = Math.max(0, toFiniteNumber(row?.buyCount));
  const sellCount = Math.max(0, toFiniteNumber(row?.sellCount));
  const avgHoldingPeriodSec = toFiniteNumber(row?.avgHoldingPeriodSec);
  const tokenNum = Math.max(0, toFiniteNumber(row?.tokenNum));
  const tags = uniqueStrings(row?.tags || []);
  const twitter = String(row?.twitter || '').trim();
  const derived = computeWalletWeightedScore({
    wallet,
    tags,
    twitter,
    d30: {
      trades: tradeCount,
      buy: buyCount,
      sell: sellCount,
      winrate: winRate,
      realizedProfitUsd,
      realizedProfitPnl,
      nativeBalance: toFiniteNumber(row?.nativeBalance),
      avgHoldingPeriodSec,
      tokenNum,
    },
    d7: null,
  });

  return {
    walletAddr: wallet,
    profitabilityScore: toFiniteNumber(row?.profitabilityScore),
    weightedScore: toFiniteNumber(row?.weightedScore, derived.weightedScore),
    winRate,
    realizedProfitUsd,
    realizedProfitPnl,
    nativeBalance: toFiniteNumber(row?.nativeBalance),
    lastTimestamp: Math.max(0, toFiniteNumber(row?.lastTimestamp)),
    tradeCount,
    buyCount,
    sellCount,
    avgHoldingPeriodSec,
    tokenNum,
    d7TradeCount: Math.max(0, toFiniteNumber(row?.d7TradeCount)),
    d7WinRate: toFiniteNumber(row?.d7WinRate),
    d7RealizedProfitUsd: toFiniteNumber(row?.d7RealizedProfitUsd),
    d7AvgHoldingPeriodSec: toFiniteNumber(row?.d7AvgHoldingPeriodSec),
    primaryStyle: String(row?.primaryStyle || derived.primaryStyle || 'PROBATION'),
    styleProfile: Array.isArray(row?.styleProfile) ? row.styleProfile : derived.styleProfile,
    copyabilityRisk: String(row?.copyabilityRisk || derived.copyabilityRisk || 'lower'),
    preferredHoldMs: Math.max(0, toFiniteNumber(row?.preferredHoldMs, derived.preferredHoldMs)),
    executable: row?.executable === undefined ? derived.executable : row?.executable === true,
    immediateEntry: row?.immediateEntry === undefined ? derived.immediateEntry : row?.immediateEntry === true,
    scoreBreakdown: row?.scoreBreakdown || derived.scoreBreakdown,
    tags,
    twitter,
  };
}

function buildWalletRows(
  candidates: Array<{ wallet: string }>,
  cache: Record<string, WalletIntelCacheEntry>,
  previousWalletMap: Map<string, Record<string, any>>,
  legacyWalletMap: Map<string, Record<string, any>>,
) {
  return candidates
    .map((candidate) => {
      const entry = cache[candidate.wallet];
      if (entry?.stats30d) {
        return buildWalletRow(candidate.wallet, entry.stats30d, entry.stats7d || null);
      }
      return normalizeLegacyWalletRow(
        previousWalletMap.get(candidate.wallet) || legacyWalletMap.get(candidate.wallet) || null,
      );
    })
    .filter(Boolean)
    .sort((left: any, right: any) =>
      Number(right.weightedScore || 0) - Number(left.weightedScore || 0) ||
      Number(right.realizedProfitUsd || 0) - Number(left.realizedProfitUsd || 0),
    ) as Record<string, any>[];
}

function buildSummary(wallets: Record<string, any>[], refreshedWallets: string[]) {
  return {
    refreshed_wallet_count: refreshedWallets.length,
    executable_wallet_count: wallets.filter((row) => row.executable === true).length,
    lower_risk_count: wallets.filter((row) => row.copyabilityRisk === 'lower').length,
    medium_risk_count: wallets.filter((row) => row.copyabilityRisk === 'medium').length,
    high_risk_count: wallets.filter((row) => row.copyabilityRisk === 'high').length,
    top_weighted_wallet: wallets[0]?.walletAddr || null,
    top_weighted_score: Number(wallets[0]?.weightedScore || 0),
  };
}

function selectStyleBalancedWallets(rows: Record<string, any>[]) {
  const primaryEligible = rows
    .filter((row) => row.executable === true && row.copyabilityRisk !== 'high')
    .sort((left, right) =>
      Number(right.weightedScore || 0) - Number(left.weightedScore || 0) ||
      Number(right.realizedProfitUsd || 0) - Number(left.realizedProfitUsd || 0),
    );
  const fallbackEligible = rows
    .filter((row) =>
      row.copyabilityRisk !== 'high' &&
      Number(row.weightedScore || row.profitabilityScore || 0) >= 0.55,
    )
    .sort((left, right) =>
      Number(right.weightedScore || right.profitabilityScore || 0) -
        Number(left.weightedScore || left.profitabilityScore || 0) ||
      Number(right.realizedProfitUsd || 0) - Number(left.realizedProfitUsd || 0),
    );
  const seedEligible = rows
    .filter((row) => row.copyabilityRisk !== 'high')
    .sort((left, right) =>
      Number(right.weightedScore || right.profitabilityScore || 0) -
        Number(left.weightedScore || left.profitabilityScore || 0) ||
      Number(right.realizedProfitUsd || 0) - Number(left.realizedProfitUsd || 0),
    );
  const eligible =
    primaryEligible.length > 0 ? primaryEligible :
    fallbackEligible.length > 0 ? fallbackEligible :
    seedEligible;

  const selected: Record<string, any>[] = [];
  const selectedWallets = new Set<string>();
  const styleSlots = ['SCALP', 'SWING', 'FLOW', 'KOL', 'PROBATION'];

  for (const style of styleSlots) {
    for (const row of eligible) {
      if (selected.length >= TRACK_LIMIT) break;
      if (selectedWallets.has(String(row.walletAddr || ''))) continue;
      if (String(row.primaryStyle || '') !== style) continue;
      selected.push(row);
      selectedWallets.add(String(row.walletAddr || ''));
      break;
    }
  }

  for (const row of eligible) {
    if (selected.length >= TRACK_LIMIT) break;
    const wallet = String(row.walletAddr || '');
    if (!wallet || selectedWallets.has(wallet)) continue;
    selected.push(row);
    selectedWallets.add(wallet);
  }

  return selected.map((row) => ({
    address: row.walletAddr,
    style: row.primaryStyle,
    score: row.weightedScore,
    weight: row.weightedScore,
    source: 'wallet-intel',
    immediate_entry: row.immediateEntry,
    executable: row.executable,
    preferred_hold_ms: row.preferredHoldMs,
    win_rate_gmgn: row.winRate,
    notes:
      `risk=${row.copyabilityRisk};` +
      ` trades=${row.tradeCount};` +
      ` profit=${Number(row.realizedProfitUsd || 0).toFixed(2)};` +
      ` styles=${(row.styleProfile || []).join('|')};` +
      ` tags=${(row.tags || []).slice(0, 4).join('|')}`,
  }));
}

async function runCycle() {
  const previous = loadJsonSafe<WalletIntelDocument>(WALLET_INTEL_FILE, {
    version: 1,
    updated_at: 0,
    source: 'wallet-intel-engine',
    cache: {},
    wallets: [],
    tracked_wallets: [],
  });
  const legacyPnl = loadJsonSafe<JsonObject>(WALLET_PNL_FILE, {});
  const cache = { ...(previous.cache || {}) };
  const previousWalletMap = new Map(
    asArray<Record<string, any>>(previous.wallets || []).map((row) => [String(row?.walletAddr || ''), row]),
  );
  const legacyWalletMap = new Map(
    asArray<Record<string, any>>(legacyPnl.wallets || []).map((row) => [String(row?.walletAddr || ''), row]),
  );
  const candidates = collectCandidateWallets();
  const seededWallets = buildWalletRows(candidates, cache, previousWalletMap, legacyWalletMap);
  const previousTrackedCount = asArray(previous.tracked_wallets || []).length;
  if (
    (!fs.existsSync(WALLET_INTEL_FILE) || Number(previous.updated_at || 0) <= 0 || previousTrackedCount === 0) &&
    seededWallets.length > 0
  ) {
    writeJson(WALLET_INTEL_FILE, {
      version: 1,
      updated_at: Date.now(),
      source: 'wallet-intel-engine-seed',
      refreshed_wallets: [],
      candidate_count: candidates.length,
      tracked_wallets: selectStyleBalancedWallets(seededWallets),
      wallets: seededWallets,
      cache,
      summary: buildSummary(seededWallets, []),
    } satisfies WalletIntelDocument);
  }
  const now = Date.now();
  const refreshQueue = now < gmgnBanUntilMs
    ? []
    : [...candidates]
      .sort((left, right) => {
        const leftEntry = (cache[left.wallet] || {}) as WalletIntelCacheEntry;
        const rightEntry = (cache[right.wallet] || {}) as WalletIntelCacheEntry;
        const leftFreshAt = Math.min(leftEntry.fetched30dAt || 0, leftEntry.fetched7dAt || 0) || 0;
        const rightFreshAt = Math.min(rightEntry.fetched30dAt || 0, rightEntry.fetched7dAt || 0) || 0;
        return leftFreshAt - rightFreshAt;
      })
      .slice(0, REFRESH_BATCH);

  const refreshedWallets: string[] = [];
  for (const candidate of refreshQueue) {
    const entry: WalletIntelCacheEntry = cache[candidate.wallet] || { wallet: candidate.wallet };
    try {
      if (!entry.stats30d || now - (entry.fetched30dAt || 0) >= TTL_30D_MS) {
        entry.stats30d = await gmgnGet('/v1/user/wallet_stats', {
          chain: 'sol',
          wallet_address: candidate.wallet,
          period: '30d',
        }) as WalletStatsResponse;
        entry.fetched30dAt = Date.now();
        refreshedWallets.push(candidate.wallet);
        await sleep(REQUEST_GAP_MS);
      }
      if (!entry.stats7d || now - (entry.fetched7dAt || 0) >= TTL_7D_MS) {
        entry.stats7d = await gmgnGet('/v1/user/wallet_stats', {
          chain: 'sol',
          wallet_address: candidate.wallet,
          period: '7d',
        }) as WalletStatsResponse;
        entry.fetched7dAt = Date.now();
        if (!refreshedWallets.includes(candidate.wallet)) refreshedWallets.push(candidate.wallet);
        await sleep(REQUEST_GAP_MS);
      }
    } catch (error: any) {
      const message = String(error?.message || error);
      const label = candidate.wallet.slice(0, 12);
      if (isGmgnTemporaryBanMessage(message)) {
        gmgnBanUntilMs = Math.max(gmgnBanUntilMs, computeGmgnBanUntilMs(message, BAN_COOLDOWN_MS));
      }
      console.error(`[WALLET-INTEL] refresh failed ${label}: ${message}`);
    }
    cache[candidate.wallet] = entry;
  }

  const wallets = buildWalletRows(candidates, cache, previousWalletMap, legacyWalletMap);

  const trackedWallets = selectStyleBalancedWallets(wallets as Record<string, any>[]);
  const summary = buildSummary(wallets as Record<string, any>[], refreshedWallets);

  const payload: WalletIntelDocument = {
    version: 1,
    updated_at: Date.now(),
    source: 'wallet-intel-engine',
    refreshed_wallets: refreshedWallets,
    candidate_count: candidates.length,
    tracked_wallets: trackedWallets,
    wallets: wallets as Record<string, any>[],
    cache,
    summary,
  };

  writeJson(WALLET_INTEL_FILE, payload);
  writeJson(WALLET_PNL_FILE, {
    updated_at: payload.updated_at,
    source: payload.source,
    candidate_count: payload.candidate_count,
    refreshed_wallets: payload.refreshed_wallets,
    summary: payload.summary,
    wallets: payload.wallets,
  });

  console.log(
    `[WALLET-INTEL] candidates=${candidates.length} refreshed=${refreshedWallets.length} ` +
    `wallets=${wallets.length} tracked=${trackedWallets.length}`,
  );
}

async function mainLoop() {
  ensureSignalsDir();
  console.log('[WALLET-INTEL] Starting wallet intelligence engine');
  while (true) {
    try {
      await runCycle();
    } catch (error: any) {
      console.error('[WALLET-INTEL] Cycle failure:', error?.message || error);
    }
    await sleep(POLL_MS);
  }
}

mainLoop().catch(console.error);
