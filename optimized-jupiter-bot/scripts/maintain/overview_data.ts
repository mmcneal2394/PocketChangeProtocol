import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';
import { shouldPersistTradeRecord } from './trade_journal_logic';
import { resolveQuotaAssistLevel } from './quota_assist_logic';
const { summarizeExpectedValueModel } = require('./ev_ranking_logic.ts');

dotenv.config();

const execFileAsync = promisify(execFile);

const ROOT = process.cwd();
const SIGNALS_DIR = path.join(ROOT, 'signals');
const IS_PAPER = process.env.PAPER_MODE === 'true';
const JOURNAL_FILE = path.join(SIGNALS_DIR, IS_PAPER ? 'trade_journal_paper.jsonl' : 'trade_journal.jsonl');
const TRADE_PROFILE_EVENTS_FILE = path.join(SIGNALS_DIR, IS_PAPER ? 'trade_profile_events_paper.jsonl' : 'trade_profile_events.jsonl');
const TRADE_PROFILE_STATS_FILE = path.join(SIGNALS_DIR, IS_PAPER ? 'trade_profile_stats_paper.json' : 'trade_profile_stats.json');
const SNIPER_STATE_FILE = path.join(SIGNALS_DIR, IS_PAPER ? 'sniper_positions_paper.json' : 'sniper_positions.json');
const WALLET_SIGNALS_FILE = path.join(SIGNALS_DIR, 'wallet_signals.json');
const WALLET_HOLDINGS_FILE = path.join(SIGNALS_DIR, 'wallet_holdings.json');
const REALIZED_PROFIT_FILE = path.join(SIGNALS_DIR, IS_PAPER ? 'realized_profit_paper.json' : 'realized_profit.json');
const ALLOCATION_FILE = path.join(SIGNALS_DIR, 'allocation.json');
const ARB_ENGINE_STATUS_FILE = path.join(SIGNALS_DIR, 'arb_engine_status.json');
const MISSED_TARGET_STATS_FILE = path.join(SIGNALS_DIR, 'missed_target_stats.json');
const VELOCITY_HYDRATION_STATS_FILE = path.join(SIGNALS_DIR, 'velocity_hydration_stats.json');
const GEMMA_RECOMMENDATIONS_FILE = path.join(SIGNALS_DIR, 'gemma4_recommendations.json');
const SWARM_HEALTH_FILE = path.join(SIGNALS_DIR, 'swarm_health.json');

const WSOL = 'So11111111111111111111111111111111111111112';
const JUP_BASE = process.env.JUP_BASE || 'https://api.jup.ag/swap/v1';
const JUP_KEY = process.env.JUP_KEY || process.env.JUP_API_KEY || '';
const QUOTE_CACHE_TTL_MS = 5000;
const quoteCache = new Map<string, { ts: number; value: number | null }>();

type Position = {
  tradeId: string;
  mint: string;
  ata: string;
  symbol: string;
  buyPriceSol: number;
  tokenAmount: number;
  openedAt: number;
  entryPriceSol: number;
  signature: string;
  peakPnlPct: number;
  entryMom5m?: number;
  entryBuyRatio?: number;
  maxTPpct: number;
  maxHoldMinutes: number;
  stopLossPct: number;
  entryMode?: string;
  partialSold?: boolean;
  trailingStopPct?: number;
  decimals?: number;
};

type PositionStore = {
  positions?: Position[];
  stats?: {
    wins?: number;
    losses?: number;
    totalPnlSol?: number;
  };
  pausedUntil?: number | null;
  blacklist?: string[];
};

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return fallback;
  }
}

function readJsonl(file: string): any[] {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function getPm2Summary() {
  try {
    const { stdout } = await execFileAsync('pm2', ['jlist'], { maxBuffer: 4 * 1024 * 1024 });
    const apps = JSON.parse(stdout || '[]');
    const focus = new Set([
      'pcp-sniper-1',
      'pcp-wallet-monitor',
      'pcp-gmgn-bridge',
      'pcp-bags-swarm',
      'pcp-gemma4-refiner',
      'pcp-velocity-stream',
      'pcp-discovery-engine',
      'pcp-ingestion',
      'pcp-hive-mind',
      'pcp-overview',
      'pcp-arb-scout',
      'wiggum-preflight',
      'wiggum-strategy-gate',
      'wiggum-yield-cycle',
      'wiggum-hermes-orchestrator',
    ]);
    return apps
      .filter((app: any) => focus.has(app.name))
      .map((app: any) => ({
        name: app.name,
        status: app.pm2_env?.status || 'unknown',
        restarts: Number(app.pm2_env?.restart_time || 0),
        unstable: Number(app.pm2_env?.unstable_restarts || 0),
        uptimeMs: app.pm2_env?.pm_uptime ? Math.max(0, Date.now() - app.pm2_env.pm_uptime) : null,
        memoryMb: app.monit?.memory ? Number((app.monit.memory / 1024 / 1024).toFixed(1)) : null,
        cpu: typeof app.monit?.cpu === 'number' ? app.monit.cpu : null,
      }));
  } catch {
    return [];
  }
}

async function getQuote(outputMint: string, amountLamports: number): Promise<any | null> {
  try {
    const url = new URL(`${JUP_BASE}/quote`);
    url.searchParams.set('inputMint', outputMint);
    url.searchParams.set('outputMint', WSOL);
    url.searchParams.set('amount', String(amountLamports));
    url.searchParams.set('slippageBps', '500');
    const response = await fetch(url.toString(), {
      headers: JUP_KEY ? { 'x-api-key': JUP_KEY } : {},
      signal: AbortSignal.timeout(10_000),
    });
    const json = await response.json();
    if (json?.error || !json?.outAmount) return null;
    return json;
  } catch {
    return null;
  }
}

async function getCurrentPriceSol(mint: string, tokenLamports: number, decimals?: number): Promise<number | null> {
  const cacheKey = `${mint}:${tokenLamports}:${decimals ?? 'na'}`;
  const cached = quoteCache.get(cacheKey);
  if (cached && Date.now() - cached.ts <= QUOTE_CACHE_TTL_MS) {
    return cached.value;
  }

  let currentValueSol: number | null = null;
  const quote = await getQuote(mint, tokenLamports);
  if (quote?.outAmount) {
    currentValueSol = Number(quote.outAmount) / 1e9;
  } else if (decimals !== undefined) {
    const jupPrice = await fetch(`https://price.jup.ag/v4/price?ids=${mint}`, {
      signal: AbortSignal.timeout(8000),
    }).then((res) => res.json()).catch(() => null);
    const pricePerTokenInSol = Number(jupPrice?.data?.[mint]?.price || 0);
    if (pricePerTokenInSol > 0) {
      const actualTokens = tokenLamports / Math.pow(10, decimals);
      currentValueSol = actualTokens * pricePerTokenInSol;
    }
  }

  quoteCache.set(cacheKey, { ts: Date.now(), value: currentValueSol });
  return currentValueSol;
}

export function summarizeClosedTrades(events: any[], cutoff: number) {
  const closed = events.filter((evt) => evt.action === 'SELL' && Number(evt.ts || 0) >= cutoff);
  const wins = closed.filter((evt) => Number(evt.pnlSol || 0) >= 0).length;
  const losses = closed.filter((evt) => Number(evt.pnlSol || 0) < 0).length;
  const totalPnlSol = closed.reduce((sum, evt) => sum + Number(evt.pnlSol || 0), 0);
  const avgHoldMinutes = closed.length
    ? closed.reduce((sum, evt) => sum + Number(evt.holdMs || 0), 0) / closed.length / 60000
    : 0;
  return {
    trades: closed.length,
    wins,
    losses,
    totalPnlSol,
    winRate: closed.length ? wins / closed.length : 0,
    avgHoldMinutes,
  };
}

export function summarizeRejectReasons(missedStats: any, limit = 8) {
  const reasonBuckets = missedStats?.byReason || missedStats?.reasons || {};
  return Object.entries(reasonBuckets)
    .map(([reason, meta]: [string, any]) => ({
      reason,
      count: Number(meta?.count || 0),
      lastSymbol: meta?.lastSymbol || null,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function summarizeLearningBuckets(tradeProfileStats: any) {
  const dimensions = tradeProfileStats?.dimensions || {};
  const focusDimensions = [
    'entryMode',
    'entryFamily',
    'sourceLane',
    'quotaAssistLevel',
    'ageBucket',
    'liquidityBucket',
    'marketCapBucket',
    'momentum5mBucket',
    'buyRatioBucket',
    'walletPriorityBucket',
    'consensusBucket',
    'alphaBoostBucket',
    'kolConfirmed',
  ];

  return focusDimensions
    .map((dimension) => {
      const ranked = Object.entries(dimensions[dimension] || {})
        .map(([bucket, data]: [string, any]) => ({
          bucket,
          trades: Number(data?.trades || 0),
          winRate: Number(data?.winRate || 0),
          avgPnlSol: Number(data?.avgPnlSol || 0),
        }))
        .filter((item) => item.trades > 0)
        .sort((a, b) => b.avgPnlSol - a.avgPnlSol);

      if (ranked.length === 0) return null;
      return {
        dimension,
        best: ranked[0],
        worst: ranked[ranked.length - 1],
      };
    })
    .filter(Boolean);
}

function formatShortSig(sig?: string) {
  if (!sig) return null;
  if (sig.length <= 14) return sig;
  return `${sig.slice(0, 8)}...${sig.slice(-4)}`;
}

function getFileAgeMs(file: string, now: number) {
  try {
    if (!fs.existsSync(file)) return null;
    return Math.max(0, now - fs.statSync(file).mtimeMs);
  } catch {
    return null;
  }
}

export function summarizeRecentTrades(journal: any[], limit = 12) {
  return journal
    .filter((evt) => (evt.action === 'BUY' || evt.action === 'SELL') && shouldPersistTradeRecord(evt, false))
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
    .slice(0, limit)
    .map((evt) => ({
      ts: Number(evt.ts || 0),
      action: evt.action,
      symbol: evt.symbol || evt.mint || 'unknown',
      mint: evt.mint,
      amountSol: Number(evt.amountSol || 0),
      pnlSol: evt.pnlSol !== undefined ? Number(evt.pnlSol) : null,
      reason: evt.reason || null,
      sig: formatShortSig(evt.sig),
    }));
}

export async function buildOverviewSnapshot() {
  const now = Date.now();
  const cutoff24h = now - 24 * 60 * 60 * 1000;

  const pm2 = await getPm2Summary();
  const store = readJson<PositionStore>(SNIPER_STATE_FILE, {});
  const walletSignals = readJson<any>(WALLET_SIGNALS_FILE, {});
  const walletHoldings = readJson<any>(WALLET_HOLDINGS_FILE, {});
  const realizedProfit = readJson<any>(REALIZED_PROFIT_FILE, {});
  const allocation = readJson<any>(ALLOCATION_FILE, {});
  const arbStatus = readJson<any>(ARB_ENGINE_STATUS_FILE, {});
  const missedTargetStats = readJson<any>(MISSED_TARGET_STATS_FILE, {});
  const velocityHydrationStats = readJson<any>(VELOCITY_HYDRATION_STATS_FILE, {});
  const gemmaRecommendations = readJson<any>(GEMMA_RECOMMENDATIONS_FILE, {});
  const swarmHealth = readJson<any>(SWARM_HEALTH_FILE, {});
  const tradeProfileStats = readJson<any>(TRADE_PROFILE_STATS_FILE, {});
  const tradeEvents = readJsonl(TRADE_PROFILE_EVENTS_FILE);
  const journal = readJsonl(JOURNAL_FILE);

  const positions = Array.isArray(store.positions) ? store.positions : [];
  const positionRows = await Promise.all(
    positions.map(async (pos) => {
      const currentValueSol = await getCurrentPriceSol(pos.mint, pos.tokenAmount, pos.decimals);
      const unrealizedPnlSol = currentValueSol === null ? null : currentValueSol - Number(pos.buyPriceSol || 0);
      const unrealizedPnlPct =
        currentValueSol === null || !pos.buyPriceSol
          ? null
          : ((currentValueSol - pos.buyPriceSol) / pos.buyPriceSol) * 100;
      return {
        symbol: pos.symbol,
        mint: pos.mint,
        entryMode: pos.entryMode || 'normal',
        buyPriceSol: Number(pos.buyPriceSol || 0),
        currentValueSol,
        unrealizedPnlSol,
        unrealizedPnlPct,
        peakPnlPct: Number(pos.peakPnlPct || 0),
        openedAt: pos.openedAt,
        heldMinutes: Math.max(0, (now - Number(pos.openedAt || now)) / 60000),
        stopLossPct: Number(pos.stopLossPct || 0) * 100,
        maxTPpct: Number(pos.maxTPpct || 0) * 100,
        maxHoldMinutes: Number(pos.maxHoldMinutes || 0),
        signature: pos.signature,
      };
    }),
  );

  const openUnrealizedPnlSol = positionRows.reduce((sum, pos) => sum + Number(pos.unrealizedPnlSol || 0), 0);
  const quotaAssistLevel = resolveQuotaAssistLevel(positionRows.length);
  const recentTrades = summarizeRecentTrades(journal, 12);

  const recentLearning = summarizeClosedTrades(tradeEvents, cutoff24h);
  const topRejectReasons = summarizeRejectReasons(missedTargetStats);
  const learningBuckets = summarizeLearningBuckets(tradeProfileStats);
  const expectedValueSummary = summarizeExpectedValueModel();
  const hydrationMisses = Object.entries(velocityHydrationStats?.byKey || {})
    .map(([key, meta]: [string, any]) => ({
      key,
      count: Number(meta?.count || 0),
      lastSymbol: meta?.lastSymbol || null,
      lastSnapshotAgeMs: meta?.lastSnapshotAgeMs ?? null,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const walletBuySignals = Array.isArray(walletSignals?.buy_signals) ? walletSignals.buy_signals : [];
  const walletSignalsUpdatedAt = Number(walletSignals?.updated_at || 0) || null;
  const walletSignalsAgeMs = walletSignalsUpdatedAt ? Math.max(0, now - walletSignalsUpdatedAt) : getFileAgeMs(WALLET_SIGNALS_FILE, now);
  const executableWalletSignals = walletBuySignals.filter((signal: any) => signal?.executable === true && signal?.expired !== true);
  const walletHoldingRows = Array.isArray(walletHoldings?.holdings) ? walletHoldings.holdings : [];
  const profileEventsAgeMs = getFileAgeMs(TRADE_PROFILE_EVENTS_FILE, now);
  const profileStatsAgeMs = getFileAgeMs(TRADE_PROFILE_STATS_FILE, now);

  return {
    generatedAt: now,
    pm2,
    session: {
      wins: Number(store.stats?.wins || 0),
      losses: Number(store.stats?.losses || 0),
      totalPnlSol: Number(store.stats?.totalPnlSol || 0),
      pausedUntil: store.pausedUntil || null,
      openPositions: positionRows.length,
      openUnrealizedPnlSol,
    },
    quota: {
      minPositions: 10,
      targetPositions: 15,
      openPositions: positionRows.length,
      shortfall: Math.max(0, 15 - positionRows.length),
      quotaAssistLevel,
    },
    wallet: {
      walletPublicKey: walletHoldings?.wallet || null,
      nativeBalanceSol: walletHoldings?.nativeBalanceSol ?? null,
      nonzeroHoldingCount: Number(walletHoldings?.nonzeroHoldingCount || walletHoldingRows.length || 0),
      trackedHoldingCount: Number(walletHoldings?.trackedHoldingCount || 0),
      stableHoldingCount: Number(walletHoldings?.stableHoldingCount || 0),
      untrackedHoldingCount: Number(walletHoldings?.untrackedHoldingCount || 0),
      recoverableOrphanCount: Number(walletHoldings?.recoverableOrphanCount || 0),
      prunedTrackedMints: Array.isArray(walletHoldings?.prunedTrackedMints) ? walletHoldings.prunedTrackedMints : [],
      updatedAt: Number(walletHoldings?.generatedAt || 0) || null,
      topTrackedHoldings: walletHoldingRows
        .filter((row: any) => row?.classification === 'tracked')
        .slice(0, 8),
      topUntrackedHoldings: walletHoldingRows
        .filter((row: any) => row?.classification === 'untracked')
        .slice(0, 8),
    },
    capital: {
      realizedProfitSol: Number(realizedProfit?.realizedProfitSol || 0),
      totalRealizedPnlSol: Number(realizedProfit?.totalRealizedPnlSol || 0),
      eligibleProfitSol: Number(realizedProfit?.eligibleProfitSol || 0),
      reinvestmentRatio: Number(realizedProfit?.reinvestmentRatio || 0),
      updatedAt: realizedProfit?.generatedAt || null,
      allocationUpdatedAt: allocation?.generatedAt || null,
      deployableSol: Number(allocation?.deployable_sol || 0),
      reserveSol: Number(allocation?.reserve_sol || 0),
      sniperBudgetSol: Number(allocation?.sniper_budget_sol || 0),
      arbBudgetSol: Number(allocation?.arb_budget_sol || 0),
      sniperWeight: Number(allocation?.sniper_weight || 0),
      arbWeight: Number(allocation?.arb_weight || 0),
      arbLiveEligible: allocation?.arb_live_eligible === true,
      executionModeRecommendation: allocation?.executionModeRecommendation || null,
    },
    arbitrage: {
      updatedAt: arbStatus?.generatedAt || null,
      state: arbStatus?.state || null,
      reason: arbStatus?.reason || null,
      executionMode: arbStatus?.executionMode || null,
      liveEligible: arbStatus?.liveEligible === true,
      walletBudgetSol: Number(arbStatus?.walletBudgetSol || 0),
      best: arbStatus?.best || null,
      opportunities: Array.isArray(arbStatus?.opportunities) ? arbStatus.opportunities : [],
    },
    positions: positionRows,
    recentTrades,
    walletIntel: {
      updatedAt: walletSignalsUpdatedAt,
      ageMs: walletSignalsAgeMs,
      trackedWalletCount: Number(walletSignals?.tracked_wallet_count || 0),
      buySignalCount: walletBuySignals.length,
      sellSignalCount: Array.isArray(walletSignals?.sell_signals) ? walletSignals.sell_signals.length : 0,
      executableBuySignalCount: executableWalletSignals.length,
      topBuySignals: walletBuySignals.slice(0, 5).map((signal: any) => ({
        symbol: signal.symbol || signal.mint?.slice(0, 8) || 'unknown',
        conviction: signal.conviction || null,
        consensusScore: Number(signal.consensus_score || signal.consensusScore || 0),
        sizeUp: !!signal.sizeUp,
      })),
    },
    topRejectReasons,
    velocityHydration: {
      updatedAt: Number(velocityHydrationStats?.updatedAt || 0) || null,
      totalMisses: Number(velocityHydrationStats?.totalMisses || 0),
      topMisses: hydrationMisses,
    },
    learning: {
      last24h: recentLearning,
      profileFreshness: {
        eventsAgeMs: swarmHealth?.learning?.profileEventsAgeMs ?? profileEventsAgeMs,
        statsAgeMs: swarmHealth?.learning?.profileStatsAgeMs ?? profileStatsAgeMs,
      },
      bestWorstBuckets: learningBuckets,
      expectedValue: expectedValueSummary,
      latestGemma: {
        generatedAt: gemmaRecommendations?.generatedAt || null,
        recommendations: Array.isArray(gemmaRecommendations?.recommendations)
          ? gemmaRecommendations.recommendations.slice(0, 5)
          : [],
      },
    },
    guardian: {
      updatedAt: swarmHealth?.timestamp || null,
      anomalyCount: Array.isArray(swarmHealth?.anomalies) ? swarmHealth.anomalies.length : 0,
      anomalies: Array.isArray(swarmHealth?.anomalies) ? swarmHealth.anomalies.slice(0, 8) : [],
      lastRemediation: swarmHealth?.lastRemediation || null,
    },
  };
}
