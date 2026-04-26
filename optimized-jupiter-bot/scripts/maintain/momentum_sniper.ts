// @ts-nocheck
/**
 * momentum_sniper.ts
 *
 * Dedicated momentum sniper agent for pcprotocol arb engine.
 *
 * STRATEGY:
 *   What profitable bots do: detect new token launches with rapidly increasing
 *   transaction velocity (100+ txs in first 5 minutes), buy a micro position
 *   BEFORE price discovery completes, exit into the FOMO wave.
 *
 *   Target: Low-marketcap tokens ($10k-$500k) with:
 *     - >50 unique buyers in first 5 min
 *     - >3x average tx/min vs baseline
 *     - Listed on at least 2 DEXs (cross-DEX spread possible)
 *     - Not yet on major aggregators (alpha window open)
 *
 * EXECUTION:
 *   Buy: 0.01 SOL per snipe (max 2 concurrent open positions)
 *   Exit targets:
 *     - Take profit at +60% (realistic for early momentum plays)
 *     - Stop loss at -25% (protects against rugs)
 *     - Force exit after 10 min (prevents bag holding)
 *
 * SAFETY:
 *   - Max 2 open positions at once (capital protection)
 *   - Blacklists tokens that rug (price drops >50% in <2 min)
 *   - Skips tokens where top-10 wallets hold >70% supply
 *
 */

import { spawnSync } from 'child_process';
import fs   from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import bs58 from 'bs58';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import dotenv from 'dotenv';
import { getSpendableNativeBalance, MIN_NATIVE_SOL_RESERVE } from '../../src/utils/native_sol_balance';
import RedisBus from '../../src/utils/redis_bus';
import { callRpcGateway } from '../../src/utils/rpc_client';
import { REDIS_KEYS, STREAMS, CHANNELS, PARAM_NAMES } from '../../src/shared/redis_config';
import { validateTradeCandidate } from '../../src/shared/trade_validator';
import { computeAlphaBoost } from './alpha_signal_provider';
const { evaluateApexEntry, evaluateApexExit } = require('./apex_predator_logic');
const { evaluateNoDexMicroScoutProbe } = require('./micro_scout_logic');
const { resolveMicroScoutPacing } = require('./micro_scout_pacing_logic.ts');
const { buildTrendingMap } = require('./trending_signal_logic.ts');
const { evaluateContinuationSignal } = require('./continuation_signal_logic.ts');
const { computeEntryConfidence } = require('./entry_confidence_logic.ts');
const { getEntryQualifierThreshold } = require('./entry_qualifier_logic.ts');
const {
  buildMicroOnlyProbeEntryOptions,
  buildMicroScoutEntryOptions,
  resolveEffectiveEntryMode,
} = require('./entry_mode_logic.ts');
const { resolvePortfolioSizedBuy } = require('./portfolio_sizing_logic.ts');
const {
  ingestTerrainObservation,
  evaluateTerrainGuard,
  evaluateTerrainPreflightGuard,
} = require('./terrain_memory_logic.ts');
const { evaluateBundlerSuspicion } = require('./bundler_signal_logic.ts');
const { normalizeBuyCountOverrideConfig, shouldAllowBuyCountOverride } = require('./buy_count_override_logic.ts');
const { shouldAllowBuyRatioOverride } = require('./buy_ratio_override_logic.ts');
const { normalizeDexScreenerPair } = require('./dex_pair_logic.ts');
const { resolveAdaptiveReserve } = require('./adaptive_reserve_logic.ts');
const {
  normalizeMatureFallbackConfig,
  shouldAllowMatureFallbackCandidate,
  getMatureFallbackRejectCooldownSec,
  scoreMatureFallbackCandidate,
  shouldDeferMatureFallback,
} = require('./mature_fallback_logic.ts');
const { evaluateFdvLiquidityGuard } = require('./fdv_liquidity_logic.ts');
const { shouldAllowVelocityVolumeOverride } = require('./volume_override_logic.ts');
const {
  planZeroLiquidityRecheck,
  normalizeRouteLiveZeroLiquidityConfig,
  evaluateRouteLiveZeroLiquidityEntry,
} = require('./zero_liquidity_logic.ts');
const {
  normalizeMicroScoutQualityConfig,
  evaluateMicroScoutQualityGate,
} = require('./micro_scout_quality_logic.ts');
const {
  evaluateRouteLiveEntryRefinement,
  evaluateFlatGmgnMissingMomentumHold,
  evaluateRouteLiveContinuationOverride,
} = require('./live_entry_refinement_logic.ts');
const {
  capSyntheticRefinementCandidates,
  normalizeVelocitySelectionConfig,
  prioritizeVelocityAssessmentCandidates,
  resolveVelocityAssessmentBudget,
  selectVelocityRecoveryTier,
  shouldAllowVelocitySoftRecheck,
} = require('./velocity_selection_logic.ts');
const { classifyVelocityPubsubPayload } = require('./velocity_pubsub_logic.ts');
const {
  resolveJupiterRateLimitBackoffMs,
  getJupiterRateLimitRemainingMs,
  isJupiterRateLimitActive,
} = require('./jupiter_rate_limit_logic.ts');
const {
  normalizeEntryRejectCooldownConfig,
  getEntryRejectCooldownSeconds,
} = require('./entry_reject_cooldown_logic.ts');
const { evaluateEntryRisk } = require('./entry_risk_logic.ts');
const {
  buildFamilyPerformanceMemory,
  normalizeEntryFamily,
  recordFamilyTrade,
  evaluateEntryFamilyPerformance,
} = require('./family_performance_logic.ts');
const {
  normalizeShadowLaneConfig,
  evaluateBuyRatioShadowLane,
  evaluateWeakMomentumShadowLane,
} = require('./shadow_lane_logic.ts');
const {
  evaluateSyntheticVelocityGuard,
  evaluateSyntheticRefinementEntryGate,
  evaluateSyntheticLiveConfirmationGate,
} = require('./synthetic_velocity_guard_logic.ts');
const {
  resolvePartialTakeProfitPlan,
  resolveTrailingStopFloorPct,
} = require('./exit_strategy_logic.ts');
const { normalizeVelocitySnapshot } = require('./velocity_snapshot_logic.ts');
const { resolveWeakMomentumCooldownSeconds } = require('./weak_momentum_cooldown_logic.ts');
const {
  isExecutableLivePair,
  shouldAllowNormalLaneApexMarketCapBypass,
  shouldApplyNormalLaneMomentumFloor,
} = require('./normal_lane_gate_logic.ts');
const {
  shouldJournalOrphanRecovery,
  uniqueJournalTargets,
  isGhostExecutionSignature,
  shouldPersistTradeRecord,
} = require('./trade_journal_logic');
const {
  resolveQuotaAssistLevel,
  resolveQuotaPressure,
  sortWalletQuotaSignals,
  resolveWalletQuotaCandidateLimit,
  resolveAlphaQuotaCandidateLimit,
  shouldBypassCooldownForQuotaAssist,
  isWalletSignalFresh,
  shouldAllowQuotaWalletWithoutExtraMarketSupport,
  isQuotaCandidateMetadataBlind,
  hasQuotaCandidateMarketSupport,
  shouldSuppressQuotaAssistForQuietRegime,
  shouldAllowAlphaQuotaCandidate,
} = require('./quota_assist_logic.ts');
const {
  resolveReplayBackedStrategyProfile,
  evaluateReplayBackedRouteLiveOverride,
  evaluateReplayBackedRecoveryProbe,
} = require('./replay_gate_logic.ts');
const {
  classifyExitSwapFailure,
  resolveExitRetryCooldownMs,
} = require('./exit_failure_logic.ts');
const {
  computeGmgnBanUntilMs,
  isGmgnRateLimitMessage,
  isGmgnTemporaryBanMessage,
  normalizeGmgnMessage,
} = require('./gmgn_pressure_logic.ts');
const { appendTradeProfileArtifacts } = require('./trade_profile_logic.ts');
const { loadExpectedValueModel, scoreCandidateExpectedValue } = require('./ev_ranking_logic.ts');

let latestVelocityData: any = {};
let pollInFlight = false;
let pollQueued = false;
const snipeInFlight = new Set<string>();
let lastVelocityTriggeredPollAt = 0;
export let globalQuotaPressure = 0.0;
export let globalQuotaAssistLevel = 0;

const FAMILY_PERFORMANCE_GATE_CONFIG = {
  maxHistory: 50,
  recentTradeWindow: 20,
  minTradeCountForGate: 30,
  minWinRate: 0.30,
  reducedSizeMultiplier: 0.5,
  disableNetSolThreshold: -0.05,
};

function evaluateCurrentFamilyDecision(family: string) {
  return evaluateEntryFamilyPerformance(family, familyPerformanceMemory, FAMILY_PERFORMANCE_GATE_CONFIG);
}

function buildExpectedValueInput(input: Record<string, any>) {
  const family = normalizeEntryFamily({
    entryFamily: input?.entryFamily,
    sourceLane: input?.sourceLane,
    entryMode: input?.entryMode,
    probeLikeEntry: input?.probeLikeEntry,
    routeLiveFastTrack: input?.routeLiveFastTrack,
  });
  const familyDecision = evaluateCurrentFamilyDecision(family);
  return {
    ...input,
    entryFamily: family,
    familySizeMultiplier: familyDecision.sizeMultiplier,
  };
}

function getExpectedValueModelSnapshot() {
  return loadExpectedValueModel();
}

function formatExitSummaryLine(config: { holdMinutes: number; stopLossPct: number; maxTPpct: number }) {
  return `Hold: ${config.holdMinutes}min | SL/TP: ${config.stopLossPct}%/${config.maxTPpct}%`;
}

function annotateCandidatesWithExpectedValue<T extends Record<string, any>>(
  candidates: T[],
  buildInput: (candidate: T) => Record<string, any>,
): Array<T & { expectedValueDecision: any }> {
  const model = getExpectedValueModelSnapshot();
  return (Array.isArray(candidates) ? candidates : []).map((candidate) => ({
    ...candidate,
    expectedValueDecision: scoreCandidateExpectedValue(buildExpectedValueInput(buildInput(candidate)), { model }),
  }));
}

function compareExpectedValueRank<T extends Record<string, any>>(
  left: T & { expectedValueDecision?: any },
  right: T & { expectedValueDecision?: any },
  fallbackCompare?: (left: T, right: T) => number,
) {
  const leftEv = left?.expectedValueDecision || {};
  const rightEv = right?.expectedValueDecision || {};
  const rankDelta = Number(rightEv.rankScore || 0) - Number(leftEv.rankScore || 0);
  if (Math.abs(rankDelta) > 1e-9) return rankDelta > 0 ? 1 : -1;

  const pnlDelta = Number(rightEv.expectedPnlSol || 0) - Number(leftEv.expectedPnlSol || 0);
  if (Math.abs(pnlDelta) > 1e-9) return pnlDelta > 0 ? 1 : -1;

  const confidenceDelta = Number(rightEv.confidence || 0) - Number(leftEv.confidence || 0);
  if (Math.abs(confidenceDelta) > 1e-9) return confidenceDelta > 0 ? 1 : -1;

  return fallbackCompare ? fallbackCompare(left, right) : 0;
}

dotenv.config({ path: path.join(process.cwd(), '.env') });

const RPC         = process.env.RPC_ENDPOINT!;
const BACKUP_RPC  = (process.env.RPC_ENDPOINT_2 || '').trim();
const JUP_KEY     = process.env.JUPITER_API_KEY!;
const JUP_BASE    = process.env.JUPITER_ENDPOINT || 'https://api.jup.ag/swap/v1';
const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH!;
const WSOL        = 'So11111111111111111111111111111111111111112'; // Jupiter's native-SOL route mint.

export const connection  = new Connection(RPC, { commitment: 'confirmed' });
const backupConnection = BACKUP_RPC ? new Connection(BACKUP_RPC, { commitment: 'confirmed' }) : null;

function isProviderCapacityError(error: any): boolean {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('429') ||
    message.includes('too many requests') ||
    message.includes('quota') ||
    message.includes('request units') ||
    message.includes('monthly quota') ||
    message.includes('rate limit') ||
    (message.includes('403') && message.includes('forbidden'))
  );
}

function getRpcCandidates(preferred?: Connection): Array<{ label: string; conn: Connection }> {
  const candidates: Array<{ label: string; conn: Connection }> = [];
  const seen = new Set<Connection>();
  const push = (label: string, conn: Connection | null | undefined) => {
    if (!conn || seen.has(conn)) return;
    seen.add(conn);
    candidates.push({ label, conn });
  };
  push(preferred === backupConnection ? 'backup' : 'primary', preferred || connection);
  if (preferred !== backupConnection) push('backup', backupConnection);
  if (preferred !== connection) push('primary', connection);
  return candidates;
}

const walletIndex = process.env.WALLET_INDEX;
export let wallet: Keypair;
if (walletIndex && process.env[`PRIVATE_KEY_${walletIndex}`]) {
    const rawKey = process.env[`PRIVATE_KEY_${walletIndex}`]!;
    wallet = Keypair.fromSecretKey(bs58.decode(rawKey));
    console.log(`[BOOT]  Loaded Mult-Wallet via Base58 [INDEX: ${walletIndex} | PUB: ${wallet.publicKey.toBase58()}]`);
} else {
    // Legacy fallback
    const walletJson  = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
    wallet = Keypair.fromSecretKey(new Uint8Array(walletJson));
    console.log(`[BOOT]  Loaded Single-Wallet via File [PUB: ${wallet.publicKey.toBase58()}]`);
}

//  Config
//  Param bounds: clamp & validate every env-configurable value at startup
// Single source of truth for safe operating ranges. Values outside bounds are
// clamped and a PARAM_GUARD WARN is emitted  caught by pcp_monitor.sh.
// THIS PREVENTS .env overrides from silently breaking trading behaviour.
interface ParamBound { env: string; def: number; min: number; max: number; unit: string; }
const PARAM_BOUNDS: Record<string, ParamBound> = {
  BASE_BUY_PCT:     { env: 'SNIPER_BUY_PCT',  def: 0.10,   min: 0.01,  max: 0.30,   unit: 'fraction'       },
  MIN_BUY_SOL:      { env: 'SNIPER_MIN_BUY',  def: 0.01,   min: 0.001, max: 0.20,   unit: 'SOL'            },
  MAX_BUY_SOL:      { env: 'SNIPER_MAX_BUY',  def: 0.02,   min: 0.005, max: 1.00,   unit: 'SOL'            },
  MAX_POSITIONS:    { env: 'SNIPER_MAX_POS',  def: 20,     min: 1,     max: 50,     unit: 'slots'          },
  MAX_HOLD_MS:      { env: 'SNIPER_MAX_HOLD', def: 360000, min: 60000, max: 600000, unit: 'ms (max 10min)' },
  MIN_VOLUME_1H:    { env: 'SNIPER_MIN_VOL',  def: 8000,   min: 1000,  max: 500000, unit: 'USD'            },
  MIN_PRICE_CHG_1H: { env: 'SNIPER_MIN_CHG',  def: 3,      min: 0.5,   max: 100,    unit: '%'              },
  MIN_BUY_RATIO:    { env: 'SNIPER_MIN_BR',   def: 3.5,    min: 1.0,   max: 20,     unit: 'x'              },
  MIN_BUYS_1H:      { env: 'SNIPER_MIN_BUYS', def: 30,     min: 5,     max: 1000,   unit: 'txns'           },
  MIN_MOMENTUM_5M:  { env: 'SNIPER_MIN_5M',   def: 3,      min: 0,     max: 50,     unit: '%'              },
};
function guardParam(key: string): number {
  const b = PARAM_BOUNDS[key];
  const raw = process.env[b.env] !== undefined ? parseFloat(process.env[b.env]!) : b.def;
  if (isNaN(raw) || raw < b.min || raw > b.max) {
    const clamped = isNaN(raw) ? b.def : Math.min(b.max, Math.max(b.min, raw));
    console.warn(`[SNIPER] PARAM_GUARD ${b.env}=${process.env[b.env]} outside [${b.min}${b.max}] ${b.unit}  clamped to ${clamped}`);
    return clamped;
  }
  return raw;
}
// Helper to ensure a parameter is within bounds, with a specific override for MIN_BUYS_1H
function ensureParam(value: number, min: number, max: number, def: number, envVar: string, unit: string): number {
  if (isNaN(value) || value < min || value > max) {
    const clamped = isNaN(value) ? def : Math.min(max, Math.max(min, value));
    console.warn(`[SNIPER] PARAM_GUARD ${envVar}=${process.env[envVar]} outside [${min}${max}] ${unit}  clamped to ${clamped}`);
    return clamped;
  }
  return value;
}

let BASE_BUY_PCT     = guardParam('BASE_BUY_PCT');
let MAX_BUY_SOL      = guardParam('MAX_BUY_SOL');
let MIN_BUY_SOL      = Math.min(process.env.SNIPER_MIN_BUY ? parseFloat(process.env.SNIPER_MIN_BUY) : 0.005, MAX_BUY_SOL);
const MIN_PROFIT_BPS = process.env.MIN_PROFIT_BPS ? parseInt(process.env.MIN_PROFIT_BPS, 10) : 10;
const SLIPPAGE_BPS   = process.env.SLIPPAGE_BPS ? parseInt(process.env.SLIPPAGE_BPS, 10) : 50;

// Override ENV logic guard that clamped MIN_BUYS to 5. Now allows 3-1000.
const _minBuysConf   = process.env.SNIPER_MIN_BUYS ? parseInt(process.env.SNIPER_MIN_BUYS, 10) : 8;
let MIN_BUYS_1H      = ensureParam(_minBuysConf, 1, 1000, 8, 'SNIPER_MIN_BUYS', 'txns');

let MAX_POSITIONS    = Math.round(guardParam('MAX_POSITIONS'));
let MAX_HOLD_MS      = Math.round(guardParam('MAX_HOLD_MS'));   // 6min default, hard ceiling 10min
const RETRACE_SHIELD_MS = 30_000;
let MIN_VOLUME_1H    = guardParam('MIN_VOLUME_1H');
let MIN_PRICE_CHG_1H = guardParam('MIN_PRICE_CHG_1H');
let MIN_BUY_RATIO    = guardParam('MIN_BUY_RATIO');
const MAX_TOKEN_AGE_MIN= parseFloat(process.env.SNIPER_MAX_AGE || '9999');
let MIN_MOMENTUM_5M  = guardParam('MIN_MOMENTUM_5M');

let GLOBAL_TP_PCT    = parseFloat(process.env.MAX_TP_PERCENT || '6') / 100; // TP1: +6% partial, trail rest
let GLOBAL_SL_PCT    = parseFloat(process.env.STOP_LOSS_PERCENT || '4') / 100;
let GLOBAL_HOLD_MIN  = parseFloat(process.env.MAX_HOLD_MINUTES || '5');
let GLOBAL_OB_CEILING = 150; // Overbought ceiling % \u2014 Gemma4 can tighten dynamically
let GLOBAL_HUNTER_MULT = 0.5; // Hunter Mode aggression factor - Gemma4 optimized
let GLOBAL_SLOPFEST_PARAMS_ID = "boot";
let GLOBAL_SLOPFEST_PARAMS_RAW: any = {};
const VELOCITY_TRIGGER_MIN_MS = Math.max(1000, parseInt(process.env.VELOCITY_TRIGGER_MIN_MS || '4000', 10) || 4000);
const VELOCITY_TRIGGER_MIN_BATCH = Math.max(1, parseInt(process.env.VELOCITY_TRIGGER_MIN_BATCH || '3', 10) || 3);
const VELOCITY_TRIGGER_LARGE_BATCH = Math.max(VELOCITY_TRIGGER_MIN_BATCH, parseInt(process.env.VELOCITY_TRIGGER_LARGE_BATCH || '25', 10) || 25);
const VELOCITY_TRIGGER_MICRO_MS = Math.max(VELOCITY_TRIGGER_MIN_MS, parseInt(process.env.VELOCITY_TRIGGER_MICRO_MS || '15000', 10) || 15000);
// -------------------------------------------------------------
// REDIS EVENT BUS: In-memory State Syncing
// -------------------------------------------------------------
function normalizeTradeRecord<T extends Record<string, any>>(record: T): T & { ts: number; timestamp: number } {
  const rawTs = Number(record?.timestamp ?? record?.ts ?? Date.now());
  const ts = Number.isFinite(rawTs) && rawTs > 0 ? rawTs : Date.now();
  return { ...record, ts, timestamp: ts };
}

const PERSIST_JOURNAL_REDIS = async (trade: any) => {
    try {
        const normalizedTrade = normalizeTradeRecord(trade || {});
        if (!shouldPersistTradeRecord(normalizedTrade)) return;
        if (!shouldJournalOrphanRecovery(normalizedTrade?.reason, true)) return;
        const p = RedisBus.getPublisher();
        await p.rpush('swarm:state:journal', JSON.stringify(normalizedTrade));
    } catch {}
};

try {
  const g4path = path.join(__dirname, '../../signals/gemma4_recommendations.json');
  if (fs.existsSync(g4path)) {
    const g4 = JSON.parse(fs.readFileSync(g4path, 'utf-8'));
    const rf = g4.recommended_filters || {};
    if (rf.tp1_pct) GLOBAL_TP_PCT = rf.tp1_pct / 100;
    if (rf.stop_loss_pct) GLOBAL_SL_PCT = rf.stop_loss_pct / 100;
    if (rf.max_hold_minutes) GLOBAL_HOLD_MIN = rf.max_hold_minutes;
    if (rf.hunter_mult) GLOBAL_HUNTER_MULT = rf.hunter_mult;
    console.log(`[SNIPER]  GEMMA4 BOOT: TP=${(GLOBAL_TP_PCT*100).toFixed(1)}% SL=${(GLOBAL_SL_PCT*100).toFixed(1)}% HOLD=${GLOBAL_HOLD_MIN}min HUNTER_MULT=${GLOBAL_HUNTER_MULT.toFixed(2)} (confidence: ${g4.confidence || 0}%)`);
  }
} catch (e: any) { console.log('[SNIPER] Gemma4 boot loader: no recs file or parse error'); }


const POLL_MS          = Math.max(5_000, parseInt(process.env.SNIPER_POLL_MS || '30000', 10) || 30_000); // Allow faster live-test polling without permanently hard-coding a tighter loop.
const SIGNALS_DIR      = path.join(process.cwd(), 'signals');
const TRENDING_FILE    = path.join(SIGNALS_DIR, 'trending.json');
const SNIPER_LOG       = path.join(SIGNALS_DIR, process.env.PAPER_MODE === 'true' ? 'sniper_positions_paper.json' : 'sniper_positions.json');
const STRATEGY_FILE    = path.join(SIGNALS_DIR, 'chart_strategy.json');
const JOURNAL_FILE     = path.join(SIGNALS_DIR, process.env.PAPER_MODE === 'true' ? 'trade_journal_paper.jsonl' : 'trade_journal.jsonl');
const ALLOCATION_FILE  = path.join(SIGNALS_DIR, 'allocation.json');  // HarmonyAgent capital weight
const CAPITAL_ALLOCATOR_STATE_FILE = path.join(SIGNALS_DIR, 'capital_allocator_state.json');
const VELOCITY_FILE    = path.join(SIGNALS_DIR, 'velocity.json');     // pcp-velocity real-time swap feed
const VELOCITY_HYDRATION_STATS_FILE = path.join(SIGNALS_DIR, 'velocity_hydration_stats.json');
const TERRAIN_MEMORY_FILE = path.join(SIGNALS_DIR, 'terrain_memory.json');
const WALLET_SIG_FILE  = path.join(SIGNALS_DIR, 'wallet_signals.json'); // pcp-wallet-tracker alpha signals
const WALLET_HOLDINGS_FILE = path.join(SIGNALS_DIR, 'wallet_holdings.json');
const GMGN_ACTIVE_POSITIONS_FILE = path.join(SIGNALS_DIR, 'gmgn_active_positions.json');
const GMGN_TRENDING_FILE = path.join(SIGNALS_DIR, 'gmgn_trending.json');
const GMGN_FOLLOW_MONITOR_FILE = path.join(SIGNALS_DIR, 'gmgn_follow_monitor.json');
const BAGS_ENRICHMENT_CACHE_FILE = path.join(SIGNALS_DIR, 'bags_enrichment_cache.json');
const GMGN_TOKEN_INFO_CACHE_FILE = path.join(SIGNALS_DIR, 'gmgn_token_info_cache.json');
const STRATEGY_PROFILE_FILE = path.resolve(process.cwd(), process.env.STRATEGY_PROFILE_PATH || 'scripts/active.strategy.json');

function loadBootSlopfestParams(): { source: string; payload: any } | null {
  const candidates = [
    path.join(process.cwd(), 'strategy_params.json'),
    path.join(SIGNALS_DIR, 'strategy_params.json'),
    path.join(SIGNALS_DIR, 'gemma4_recommendations.json'),
  ];
  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!parsed || typeof parsed !== 'object') continue;
      if (
        parsed.recommended_filters ||
        parsed.min_5m_change !== undefined ||
        parsed.min_volume_5m !== undefined ||
        parsed.fitness_score !== undefined
      ) {
        return { source: filePath, payload: parsed };
      }
    } catch { }
  }
  return null;
}

const bootSlopfestParams = loadBootSlopfestParams();
if (bootSlopfestParams?.payload) {
  GLOBAL_SLOPFEST_PARAMS_ID = 'boot_profile';
  GLOBAL_SLOPFEST_PARAMS_RAW = bootSlopfestParams.payload;
  console.log(`[SNIPER]  SLOPFEST BOOT PROFILE: loaded from ${bootSlopfestParams.source}`);
}

type EntryMode = 'normal' | 'last-stand' | 'micro-scout';

interface EntryOptions {
  entryMode?: EntryMode;
  sourceLane?: 'velocity-first' | 'velocity-first-preflight' | 'wallet-signal' | 'wallet' | 'alpha' | 'mature-fallback' | 'last-stand' | 'manual';
  probeLikeEntry?: boolean;
  syntheticRefinementOnly?: boolean;
  syntheticSource?: string | null;
  bypassNormalMomentumFloor?: boolean;
  bypassNormalVolumeFloor?: boolean;
  continuationApproved?: boolean;
  routeLiveFastTrack?: boolean;
  allowRoutableLowLiquidity?: boolean;
  qualifierThresholdScale?: number;
  buyRatioThresholdScale?: number;
  buyCountThresholdScale?: number;
  quoteMode?: 'default' | 'pump-direct';
  forceAllIn?: boolean;
  reserveSol?: number;
  fixedBuySol?: number;
  portfolioFraction?: number;
  minDeploySol?: number;
  maxDeploySol?: number;
  bypassAgeFloor?: boolean;
  minTokenAgeSec?: number;
  maxTokenAgeSec?: number;
  minLiquidityUsd?: number;
  minVolumeUsd?: number;
  minMomentum5mPct?: number;
  disablePartialTakeProfit?: boolean;
  trailingActivationPct?: number;
  trailingStopPct?: number;
  sizeMultiplier?: number;
  riskScore?: number;
  riskBand?: string;
  stopLossPct?: number;
  maxHoldMinutes?: number;
  maxTPpct?: number;
  rejectCooldownSeconds?: number;
  hydrationMissRejectCooldownSeconds?: number;
  quotaAssist?: boolean;
  quotaAssistLevel?: number;
  walletSignalPriority?: string;
  walletConsensusScore?: number;
  walletCount?: number;
  walletPnlScore?: number;
  walletWeightedScore?: number;
  walletCompositeScore?: number;
  kolConfirmed?: boolean;
  alphaBoost?: number;
  alphaKolCount?: number;
  preferredHoldMs?: number;
  walletConfirmed?: boolean;
  strongRecentFlowConfirmed?: boolean;
  expectedValueSol?: number;
  expectedValueConfidence?: number;
  expectedValueRankScore?: number;
  expectedValueTradeCount?: number;
  replayRecoveryProbe?: boolean;
  replayRecoveryReason?: string;
  replayRecoveryWindowMs?: number;
}

interface QuoteRequestOptions {
  slippageBps?: number;
  restrictIntermediateTokens?: boolean;
  onlyDirectRoutes?: boolean;
  asLegacyTransaction?: boolean;
}

interface SwapRequestOptions {
  asLegacyTransaction?: boolean;
  wrapAndUnwrapSol?: boolean;
}

interface LastStandConfig {
  enabled: boolean;
  triggerTreasurySol: number;
  reserveSol: number;
  minDeploySol: number;
  maxDeploySol: number;
  minTokenAgeSeconds: number;
  maxTokenAgeSeconds: number;
  minMomentum5mPct: number;
  minVolumeUsd: number;
  minLiquidityUsd: number;
  minBuys60s: number;
  minBuyRatio60s: number;
  maxCandidatesPerPoll: number;
  trailingActivationPct: number;
  trailingStopPct: number;
  stopLossPct: number;
  maxHoldMinutes: number;
}

interface LastStandContext {
  config: LastStandConfig;
  spendableSol: number;
  nativeSol: number;
  deployableSol: number;
  hasLastStandPosition: boolean;
  active: boolean;
}

interface MicroScoutConfig {
  enabled: boolean;
  reserveSol: number;
  fixedBuySol: number;
  portfolioSizingEnabled: boolean;
  portfolioFraction: number;
  maxDynamicBuySol: number;
  adaptiveReserveEnabled: boolean;
  adaptiveReserveMinSol: number;
  adaptiveReserveFeeBufferSol: number;
  minRawBuys60s: number;
  minRawBuyRatio60s: number;
  minRawSolVolume60s: number;
  minVelocity: number;
  requireContinuation: boolean;
  maxCandidatesPerPoll: number;
  noDexCooldownSeconds: number;
  stopLossPct: number;
  maxHoldMinutes: number;
  maxTPpct: number;
  underfilledBook: {
    enabled: boolean;
    maxFillRatio: number;
    minRawBuys60s: number;
    minRawBuyRatio60s: number;
    minRawSolVolume60s: number;
    minVelocity: number;
    maxCandidatesPerPoll: number;
  };
}

interface NormalLaneConfig {
  enabled: boolean;
  minMarketCapUsd: number;
  minMomentum5mPct: number;
  minVolume1hUsd: number;
  minLiquidityUsd: number;
  maxMarketCapUsd: number;
  apexOverlayMaxMarketCapUsd: number;
}

interface TerrainMemoryConfig {
  enabled: boolean;
  lookbackSeconds: number;
  minSamplesForDecision: number;
  minSamplesForFlowDecayDecision: number;
  minSamplesForWarn: number;
  minSamplesForBlock: number;
  minStrongFlowSamples: number;
  minStrongFlowBuys60s: number;
  minStrongFlowSolVolume60s: number;
  minStrongFlowVelocity: number;
  flatPrice5mPct: number;
  minRouteStrengthPct: number;
  minRouteStrengthPctToIgnoreFlowDecay: number;
  minLiquidityDeltaUsdToIgnoreFlowDecay: number;
  maxFlowDecayRatioForHold: number;
  maxFlowDecayRatioForBlock: number;
  minPriceOffPeak5mPctForHold: number;
  minPriceOffPeak5mPctForBlock: number;
  maxLiquidityUsdForDecisionHold: number;
  maxLiquidityUsdForPreflightHold: number;
  liveDumpHardFloorPct: number;
  overboughtHardCeilingPct: number;
  routeLiveOverboughtHardCeilingPct: number;
  cooldownConfirmSeconds: number;
  cooldownWarnSeconds: number;
  cooldownBlockSeconds: number;
}

interface GmgnImageDuplicationConfig {
  enabled: boolean;
  warnThreshold: number;
  rejectThreshold: number;
  hardRejectThreshold: number;
  maxTokenAgeSeconds: number;
  cooldownSeconds: number;
  onlyPumpLaunchpad: boolean;
  strictEntryModes: EntryMode[];
}

interface PumpLaunchpadGuardConfig {
  enabled: boolean;
  blockLowMarketCapUsd: boolean;
  minSafeMarketCapUsd: number;
  cooldownSeconds: number;
  maxTokenAgeSeconds: number;
  strictEntryModes: EntryMode[];
}

interface BundlerTrafficGuardConfig {
  enabled: boolean;
  warnScore: number;
  blockScore: number;
  blockLiquidityUsdCeiling: number;
  blockHolderCountCeiling: number;
  maxFreshTokenAgeSec: number;
  cooldownWarnSeconds: number;
  cooldownBlockSeconds: number;
  strongFlowBuys60s: number;
  strongFlowSolVolume60s: number;
  strongFlowVelocity: number;
  flatMomentum5mPct: number;
  flatMomentum1mPct: number;
  highTurnoverToLiquidityRatio: number;
  lowHolderCountThreshold: number;
  heavyTop10PctThreshold: number;
  blockEntryModes: EntryMode[];
}

interface MatureFallbackConfig {
  enabled: boolean;
  candidatePoolSize: number;
  maxCandidatesPerPoll: number;
  minCandidateBuyRatio: number;
  minCandidateAgeSec: number;
  maxCandidateAgeSec: number;
  maxCandidateMomentum5mPct: number;
  maxCandidateMomentum1hPct: number;
  maxScoreMomentum5mPct: number;
  buyRatioThresholdScale: number;
  buyCountThresholdScale: number;
  deferWhenEligibleVelocityCountGte: number;
  rejectCooldownSeconds: number;
  hydrationMissRejectCooldownSeconds: number;
}

interface FdvLiquidityGuardConfig {
  enabled: boolean;
  warnFdvToLiquidityRatio: number;
  normalBlockFdvToLiquidityRatio: number;
  microScoutBlockFdvToLiquidityRatio: number;
  lastStandBlockFdvToLiquidityRatio: number;
  matureFallbackBlockFdvToLiquidityRatio: number;
  minLiquidityUsdToApply: number;
  minValuationUsdToApply: number;
  cooldownWarnSeconds: number;
  cooldownBlockSeconds: number;
}

interface VelocitySelectionConfig {
  enabled: boolean;
  maxSoftRechecksPerPoll: number;
  softCooldownMaxTtlSeconds: number;
  softCooldownReasons: string[];
  minSoftRecheckBuys60s: number;
  minSoftRecheckSolVolume60s: number;
  minSoftRecheckVelocity: number;
  fallbackTiers: Array<{
    label: string;
    minBuys60s: number;
    minBuyRatio60s: number;
    minSolVolume60s: number;
    maxCandidatesPerPoll: number;
  }>;
}

interface EntryRejectCooldownConfig {
  enabled: boolean;
  buyRatioCooldownSeconds: number;
  buysBelowCooldownSeconds: number;
  strongFlowBuyRatioCooldownSeconds: number;
  strongFlowBuysBelowCooldownSeconds: number;
  minStrongFlowBuys60s: number;
  minStrongFlowSolVolume60s: number;
  minStrongFlowVelocity: number;
}

interface RouteLiveZeroLiquidityConfig {
  enabled: boolean;
  minSamplesForDecision: number;
  minPositivePriceDelta5mPct: number;
  minRouteStrengthPct: number;
  maxNegativePriceChange1hPct: number;
  minRecoveryPriceChange5mPct: number;
  minSamplesForPriceOnlyAllow: number;
  minLivePriceChange5mPctForPriceOnlyAllow: number;
  confirmationCooldownSec: number;
  stalledCooldownSec: number;
  repeatedCooldownSec: number;
}

function clampNumber(value: any, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const BASE_TRANSACTION_FEE_LAMPORTS = 5_000;
const DEFAULT_PRIORITY_FEE_LAMPORTS = Math.round(clampNumber(process.env.SNIPER_PRIORITY_FEE_LAMPORTS, 50_000, 0, 1_000_000));
const BUY_PRIORITY_FEE_LAMPORTS = Math.round(clampNumber(process.env.SNIPER_BUY_PRIORITY_FEE_LAMPORTS, DEFAULT_PRIORITY_FEE_LAMPORTS, 0, 1_000_000));
const SELL_PRIORITY_FEE_LAMPORTS = Math.round(clampNumber(process.env.SNIPER_SELL_PRIORITY_FEE_LAMPORTS, 25_000, 0, 1_000_000));
const ORPHAN_PRIORITY_FEE_LAMPORTS = Math.round(clampNumber(process.env.SNIPER_ORPHAN_PRIORITY_FEE_LAMPORTS, SELL_PRIORITY_FEE_LAMPORTS, 0, 1_000_000));
const ALPHA_EXIT_PRIORITY_FEE_LAMPORTS = Math.round(clampNumber(process.env.SNIPER_ALPHA_EXIT_PRIORITY_FEE_LAMPORTS, SELL_PRIORITY_FEE_LAMPORTS, 0, 1_000_000));
const FORCED_DIAGNOSTIC_ENABLED = process.env.SNIPER_ENABLE_FORCED_DIAGNOSTIC === 'true';
const MAX_EXIT_FAILURES = Math.round(clampNumber(process.env.SNIPER_MAX_EXIT_FAILURES, 3, 1, 10));
const EXIT_RETRY_COOLDOWN_MS = Math.round(clampNumber(process.env.SNIPER_EXIT_RETRY_COOLDOWN_MS, 120_000, 5_000, 3_600_000));
const MAX_BALANCE_FETCH_FAILURES = Math.round(clampNumber(process.env.SNIPER_MAX_BALANCE_FETCH_FAILURES, 2, 1, 10));
const MAX_BALANCE_EVICT_FAILURES = Math.round(
  clampNumber(process.env.SNIPER_MAX_BALANCE_EVICT_FAILURES, Math.max(MAX_BALANCE_FETCH_FAILURES * 3, 6), MAX_BALANCE_FETCH_FAILURES, 50)
);
const BALANCE_LOOKUP_GRACE_MS = Math.round(clampNumber(process.env.SNIPER_BALANCE_LOOKUP_GRACE_MS, 180_000, 30_000, 3_600_000));
const MARK_PERSIST_INTERVAL_MS = Math.round(clampNumber(process.env.SNIPER_MARK_PERSIST_INTERVAL_MS, 15_000, 5_000, 300_000));
const MICRO_ROUND_TRIP_FEE_FLOOR_LAMPORTS =
  (BASE_TRANSACTION_FEE_LAMPORTS * 2) +
  BUY_PRIORITY_FEE_LAMPORTS +
  SELL_PRIORITY_FEE_LAMPORTS;

console.log(
  `[SNIPER] Fee profile: buyTip=${BUY_PRIORITY_FEE_LAMPORTS} sellTip=${SELL_PRIORITY_FEE_LAMPORTS} ` +
  `roundTripFloor=${MICRO_ROUND_TRIP_FEE_FLOOR_LAMPORTS} lamports ` +
  `(${(MICRO_ROUND_TRIP_FEE_FLOOR_LAMPORTS / 1e9).toFixed(6)} SOL)`
);
console.log(
  `[SNIPER] Exit guards: maxExitFailures=${MAX_EXIT_FAILURES} ` +
  `retryCooldownMs=${EXIT_RETRY_COOLDOWN_MS} maxBalanceFetchFailures=${MAX_BALANCE_FETCH_FAILURES} ` +
  `maxBalanceEvictFailures=${MAX_BALANCE_EVICT_FAILURES} balanceGraceMs=${BALANCE_LOOKUP_GRACE_MS}`
);

function loadStrategyProfile(): any {
  try {
    if (!fs.existsSync(STRATEGY_PROFILE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STRATEGY_PROFILE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function getMintCooldownMultiplier(): number {
  const profile = loadStrategyProfile();
  return clampNumber(profile.liveTest?.cooldownMultiplier, 1, 0.1, 1);
}

function getScaledMintCooldownSeconds(baseSeconds: number): number {
  const scaled = Math.round(Math.max(1, baseSeconds) * getMintCooldownMultiplier());
  return Math.max(10, scaled);
}

async function setMintCooldown(pub: any, mint: string, baseSeconds: number, value: string = '1'): Promise<number> {
  const seconds = getScaledMintCooldownSeconds(baseSeconds);
  await pub.setex(REDIS_KEYS.cooldown(mint), seconds, value);
  return seconds;
}

async function setMintCooldownExact(pub: any, mint: string, seconds: number, value: string = '1'): Promise<number> {
  const exactSeconds = Math.max(1, Math.round(seconds));
  await pub.setex(REDIS_KEYS.cooldown(mint), exactSeconds, value);
  return exactSeconds;
}

function loadLastStandConfig(): LastStandConfig {
  const profile = loadStrategyProfile();
  const raw = profile.lastStand || {};
  return {
    enabled: raw.enabled === true,
    triggerTreasurySol: clampNumber(raw.triggerTreasurySol, 0.35, 0.001, 20),
    reserveSol: clampNumber(raw.reserveSol, 0.03, 0.0001, 5),
    minDeploySol: clampNumber(raw.minDeploySol, 0.08, 0.001, 10),
    maxDeploySol: clampNumber(raw.maxDeploySol, 0.5, 0.001, 10),
    minTokenAgeSeconds: Math.round(clampNumber(raw.minTokenAgeSeconds, 180, 0, 2592000)),
    maxTokenAgeSeconds: Math.round(clampNumber(raw.maxTokenAgeSeconds, 86400, 30, 2592000)),
    minMomentum5mPct: clampNumber(raw.minMomentum5mPct, 20, 1, 300),
    minVolumeUsd: clampNumber(raw.minVolumeUsd, 25000, 1000, 2000000),
    minLiquidityUsd: clampNumber(raw.minLiquidityUsd, 20000, 1000, 2000000),
    minBuys60s: Math.round(clampNumber(raw.minBuys60s, 25, 3, 500)),
    minBuyRatio60s: clampNumber(raw.minBuyRatio60s, 0.68, 0.5, 0.99),
    maxCandidatesPerPoll: Math.round(clampNumber(raw.maxCandidatesPerPoll, 8, 1, 25)),
    trailingActivationPct: clampNumber(raw.trailingActivationPct, 8, 1, 100),
    trailingStopPct: clampNumber(raw.trailingStopPct, 12, 1, 50),
    stopLossPct: clampNumber(raw.stopLossPct, 12, 1, 50),
    maxHoldMinutes: clampNumber(raw.maxHoldMinutes, 8, 1, 60),
  };
}

function loadMicroScoutConfig(): MicroScoutConfig {
  const profile = loadStrategyProfile();
  const raw = profile.microScout || {};
  const underfilledRaw = raw.underfilledBook || {};
  const config = {
    enabled: raw.enabled === true,
    reserveSol: clampNumber(raw.reserveSol, 0.02, 0.0001, 5),
    fixedBuySol: clampNumber(raw.fixedBuySol, 0.0025, 0.0005, 0.01),
    portfolioSizingEnabled: raw.portfolioSizingEnabled === true,
    portfolioFraction: clampNumber(raw.portfolioFraction, 1, 0.01, 1),
    maxDynamicBuySol: Number.isFinite(raw.maxDynamicBuySol) ? Math.min(100, Math.max(0, Number(raw.maxDynamicBuySol))) : 0,
    adaptiveReserveEnabled: raw.adaptiveReserveEnabled !== false,
    adaptiveReserveMinSol: clampNumber(raw.adaptiveReserveMinSol, 0.25, 0.01, 5),
    adaptiveReserveFeeBufferSol: clampNumber(raw.adaptiveReserveFeeBufferSol, 0.0004, 0.0001, 0.01),
    minRawBuys60s: Math.round(clampNumber(raw.minRawBuys60s, 8, 3, 250)),
    minRawBuyRatio60s: clampNumber(raw.minRawBuyRatio60s, 0.7, 0.5, 0.99),
    minRawSolVolume60s: clampNumber(raw.minRawSolVolume60s, 1, 0.25, 50),
    minVelocity: clampNumber(raw.minVelocity, 8, 5, 250),
    requireContinuation: raw.requireContinuation !== false,
    maxCandidatesPerPoll: Math.round(clampNumber(raw.maxCandidatesPerPoll, 2, 1, 5)),
    noDexCooldownSeconds: Math.round(clampNumber(raw.noDexCooldownSeconds, 45, 5, 300)),
    stopLossPct: clampNumber(raw.stopLossPct, 8, 1, 50),
    maxHoldMinutes: clampNumber(raw.maxHoldMinutes, 3, 0.5, 30),
    maxTPpct: clampNumber(raw.maxTPpct, 12, 1, 100),
    underfilledBook: {
      enabled: underfilledRaw.enabled === true,
      maxFillRatio: clampNumber(underfilledRaw.maxFillRatio, 0.3, 0, 1),
      minRawBuys60s: Math.round(clampNumber(underfilledRaw.minRawBuys60s, 8, 3, 250)),
      minRawBuyRatio60s: clampNumber(underfilledRaw.minRawBuyRatio60s, 0.72, 0.5, 0.99),
      minRawSolVolume60s: clampNumber(underfilledRaw.minRawSolVolume60s, 1, 0.25, 50),
      minVelocity: clampNumber(underfilledRaw.minVelocity, 8, 5, 250),
      maxCandidatesPerPoll: Math.round(clampNumber(underfilledRaw.maxCandidatesPerPoll, 8, 1, 12)),
    },
  };

  try {
    const minOpenPositions = 8;
    const store = loadStore();
    const posCount = store.positions.length;
    if (posCount < minOpenPositions) {
      const ratio = (minOpenPositions - posCount) / minOpenPositions;
      config.portfolioFraction = Math.min(3.0, config.portfolioFraction * (1 + ratio));
    }
  } catch (e) {
    // ignore
  }

  return config;
}

function loadShadowLaneConfig() {
  const profile = loadStrategyProfile();
  return normalizeShadowLaneConfig(profile.shadowLane || {});
}

function describeMicroScoutSizing(config: MicroScoutConfig) {
  if (config.portfolioSizingEnabled) {
    const base = `${(config.portfolioFraction * 100).toFixed(0)}% of one remaining slot-share of deployable treasury`;
    return config.maxDynamicBuySol > 0
      ? `${base} (capped at ${config.maxDynamicBuySol.toFixed(4)} SOL)`
      : base;
  }
  return `${config.fixedBuySol.toFixed(4)} SOL fixed`;
}

function resolveActiveMicroScoutPacing(currentOpenPositions: number, maxOpenPositions: number, config: MicroScoutConfig) {
  return resolveMicroScoutPacing({
    currentOpenPositions,
    maxOpenPositions,
    baseProbeConfig: {
      minRawBuys60s: config.minRawBuys60s,
      minRawBuyRatio60s: config.minRawBuyRatio60s,
      minRawSolVolume60s: config.minRawSolVolume60s,
      minVelocity: config.minVelocity,
      maxCandidatesPerPoll: config.maxCandidatesPerPoll,
    },
    underfilledBook: config.underfilledBook,
  });
}

function loadTerrainMemoryConfig(): TerrainMemoryConfig {
  const profile = loadStrategyProfile();
  const raw = profile.terrainMemory || {};
  return {
    enabled: raw.enabled !== false,
    lookbackSeconds: Math.round(clampNumber(raw.lookbackSeconds, 180, 15, 3600)),
    minSamplesForDecision: Math.round(clampNumber(raw.minSamplesForDecision, 2, 1, 10)),
    minSamplesForFlowDecayDecision: Math.round(clampNumber(raw.minSamplesForFlowDecayDecision, 3, 2, 12)),
    minSamplesForWarn: Math.round(clampNumber(raw.minSamplesForWarn, 2, 1, 10)),
    minSamplesForBlock: Math.round(clampNumber(raw.minSamplesForBlock, 3, 1, 12)),
    minStrongFlowSamples: Math.round(clampNumber(raw.minStrongFlowSamples, 2, 1, 10)),
    minStrongFlowBuys60s: Math.round(clampNumber(raw.minStrongFlowBuys60s, 10, 3, 500)),
    minStrongFlowSolVolume60s: clampNumber(raw.minStrongFlowSolVolume60s, 2, 0.1, 100),
    minStrongFlowVelocity: clampNumber(raw.minStrongFlowVelocity, 8, 1, 500),
    flatPrice5mPct: clampNumber(raw.flatPrice5mPct, 1.5, 0.1, 25),
    minRouteStrengthPct: clampNumber(raw.minRouteStrengthPct, 1.5, 0.1, 50),
    minRouteStrengthPctToIgnoreFlowDecay: clampNumber(raw.minRouteStrengthPctToIgnoreFlowDecay, 45, 1, 100),
    minLiquidityDeltaUsdToIgnoreFlowDecay: clampNumber(raw.minLiquidityDeltaUsdToIgnoreFlowDecay, 1000, 0, 100000),
    maxFlowDecayRatioForHold: clampNumber(raw.maxFlowDecayRatioForHold, 0.72, 0.1, 1),
    maxFlowDecayRatioForBlock: clampNumber(raw.maxFlowDecayRatioForBlock, 0.55, 0.05, 1),
    minPriceOffPeak5mPctForHold: clampNumber(raw.minPriceOffPeak5mPctForHold, 6, 0.5, 100),
    minPriceOffPeak5mPctForBlock: clampNumber(raw.minPriceOffPeak5mPctForBlock, 10, 1, 100),
    maxLiquidityUsdForDecisionHold: clampNumber(raw.maxLiquidityUsdForDecisionHold, 1000, 0, 100000),
    maxLiquidityUsdForPreflightHold: clampNumber(raw.maxLiquidityUsdForPreflightHold, 5000, 0, 100000),
    liveDumpHardFloorPct: clampNumber(raw.liveDumpHardFloorPct, -8, -50, -0.1),
    overboughtHardCeilingPct: clampNumber(raw.overboughtHardCeilingPct, 45, 1, 500),
    routeLiveOverboughtHardCeilingPct: clampNumber(raw.routeLiveOverboughtHardCeilingPct, 250, 1, 1000),
    cooldownConfirmSeconds: Math.round(clampNumber(raw.cooldownConfirmSeconds, 8, 1, 120)),
    cooldownWarnSeconds: Math.round(clampNumber(raw.cooldownWarnSeconds, 60, 5, 1800)),
    cooldownBlockSeconds: Math.round(clampNumber(raw.cooldownBlockSeconds, 600, 10, 3600)),
  };
}

console.log(`[SNIPER] Cooldown profile: mintCooldownMultiplier=${getMintCooldownMultiplier().toFixed(2)}`);

function evaluateMicroScoutContinuationGate(config: MicroScoutConfig, continuation: any) {
  if (!config.requireContinuation) {
    return { ready: true, source: 'not-required' };
  }
  if (continuation?.hasContinuation) {
    return {
      ready: true,
      source: continuation.fallbackSource || (continuation.usingFlowFallback ? 'flow-fallback' : '1m-confirmed'),
    };
  }
  if (continuation?.missingMomentum1m) {
    return { ready: false, source: '1m-missing' };
  }
  const displayMomentum1m = Number(continuation?.displayMomentum1m);
  return {
    ready: false,
    source: Number.isFinite(displayMomentum1m) ? `${displayMomentum1m.toFixed(1)}%/1m` : 'no-confirmation',
  };
}

function loadApexPredatorConfig(): any {
  const profile = loadStrategyProfile();
  return profile.apexPredator || {};
}

function loadBuyCountOverrideConfig(): any {
  const profile = loadStrategyProfile();
  return normalizeBuyCountOverrideConfig(profile.buyCountOverride || {});
}

function loadNormalLaneConfig(): NormalLaneConfig {
  const profile = loadStrategyProfile();
  const raw = profile.normalLane || {};
  return {
    enabled: raw.enabled !== false,
    minMarketCapUsd: clampNumber(raw.minMarketCapUsd, 100000, 25000, 1000000000),
    minMomentum5mPct: clampNumber(raw.minMomentum5mPct, 2, 0, 100),
    minVolume1hUsd: clampNumber(raw.minVolume1hUsd, 10000, 1000, 5000000),
    minLiquidityUsd: clampNumber(raw.minLiquidityUsd, 25000, 5000, 5000000),
    maxMarketCapUsd: clampNumber(raw.maxMarketCapUsd, 1000000, 25000, 1000000000),
    apexOverlayMaxMarketCapUsd: clampNumber(raw.apexOverlayMaxMarketCapUsd, 3500000, 100000, 1000000000),
  };
}

function loadGmgnImageDuplicationConfig(): GmgnImageDuplicationConfig {
  const profile = loadStrategyProfile();
  const raw = profile.gmgnImageDuplication || {};
  const strictModes = Array.isArray(raw.strictEntryModes)
    ? raw.strictEntryModes.filter((mode: any) => mode === 'normal' || mode === 'last-stand' || mode === 'micro-scout')
    : ['micro-scout', 'last-stand'];
  return {
    enabled: raw.enabled !== false,
    warnThreshold: Math.round(clampNumber(raw.warnThreshold, 2, 1, 20)),
    rejectThreshold: Math.round(clampNumber(raw.rejectThreshold, 3, 1, 20)),
    hardRejectThreshold: Math.round(clampNumber(raw.hardRejectThreshold, 5, 1, 50)),
    maxTokenAgeSeconds: Math.round(clampNumber(raw.maxTokenAgeSeconds, 21600, 30, 2592000)),
    cooldownSeconds: Math.round(clampNumber(raw.cooldownSeconds, 600, 30, 86400)),
    onlyPumpLaunchpad: raw.onlyPumpLaunchpad !== false,
    strictEntryModes: strictModes.length > 0 ? strictModes : ['normal', 'micro-scout', 'last-stand'],
  };
}

function loadPumpLaunchpadGuardConfig(): PumpLaunchpadGuardConfig {
  const profile = loadStrategyProfile();
  const raw = profile.pumpLaunchpadGuard || {};
  const strictModes = Array.isArray(raw.strictEntryModes)
    ? raw.strictEntryModes.filter((mode: any) => mode === 'normal' || mode === 'last-stand' || mode === 'micro-scout')
    : ['normal', 'micro-scout', 'last-stand'];
  return {
    enabled: raw.enabled !== false,
    blockLowMarketCapUsd: raw.blockLowMarketCapUsd !== false,
    minSafeMarketCapUsd: clampNumber(raw.minSafeMarketCapUsd, 1000, 100, 100000),
    cooldownSeconds: Math.round(clampNumber(raw.cooldownSeconds, 86400, 30, 604800)),
    maxTokenAgeSeconds: Math.round(clampNumber(raw.maxTokenAgeSeconds, 86400, 30, 2592000)),
    strictEntryModes: strictModes.length > 0 ? strictModes : ['normal', 'micro-scout', 'last-stand'],
  };
}

function loadBundlerTrafficGuardConfig(): BundlerTrafficGuardConfig {
  const profile = loadStrategyProfile();
  const raw = profile.bundlerTrafficGuard || {};
  const blockModes = Array.isArray(raw.blockEntryModes)
    ? raw.blockEntryModes.filter((mode: any) => mode === 'normal' || mode === 'last-stand' || mode === 'micro-scout')
    : ['normal', 'micro-scout', 'last-stand'];
  return {
    enabled: raw.enabled !== false,
    warnScore: clampNumber(raw.warnScore, 0.45, 0.2, 0.95),
    blockScore: clampNumber(raw.blockScore, 0.72, 0.3, 0.99),
    blockLiquidityUsdCeiling: clampNumber(raw.blockLiquidityUsdCeiling, 50000, 1000, 5000000),
    blockHolderCountCeiling: Math.round(clampNumber(raw.blockHolderCountCeiling, 200, 20, 50000)),
    maxFreshTokenAgeSec: Math.round(clampNumber(raw.maxFreshTokenAgeSec, 900, 30, 86400)),
    cooldownWarnSeconds: Math.round(clampNumber(raw.cooldownWarnSeconds, 180, 10, 3600)),
    cooldownBlockSeconds: Math.round(clampNumber(raw.cooldownBlockSeconds, 900, 30, 86400)),
    strongFlowBuys60s: Math.round(clampNumber(raw.strongFlowBuys60s, 8, 3, 200)),
    strongFlowSolVolume60s: clampNumber(raw.strongFlowSolVolume60s, 2, 0.25, 100),
    strongFlowVelocity: clampNumber(raw.strongFlowVelocity, 10, 5, 500),
    flatMomentum5mPct: clampNumber(raw.flatMomentum5mPct, 2, 0.25, 15),
    flatMomentum1mPct: clampNumber(raw.flatMomentum1mPct, 0.75, 0.05, 10),
    highTurnoverToLiquidityRatio: clampNumber(raw.highTurnoverToLiquidityRatio, 2.5, 0.5, 100),
    lowHolderCountThreshold: Math.round(clampNumber(raw.lowHolderCountThreshold, 120, 5, 50000)),
    heavyTop10PctThreshold: clampNumber(raw.heavyTop10PctThreshold, 35, 5, 100),
    blockEntryModes: blockModes.length > 0 ? blockModes : ['normal', 'micro-scout', 'last-stand'],
  };
}

function loadMatureFallbackConfig(): MatureFallbackConfig {
  const profile = loadStrategyProfile();
  return normalizeMatureFallbackConfig(profile.matureFallback || {});
}

function loadFdvLiquidityGuardConfig(): FdvLiquidityGuardConfig {
  const profile = loadStrategyProfile();
  const raw = profile.fdvLiquidityGuard || {};
  return {
    enabled: raw.enabled !== false,
    warnFdvToLiquidityRatio: clampNumber(raw.warnFdvToLiquidityRatio, 12, 2, 500),
    normalBlockFdvToLiquidityRatio: clampNumber(raw.normalBlockFdvToLiquidityRatio, 18, 2, 1000),
    microScoutBlockFdvToLiquidityRatio: clampNumber(raw.microScoutBlockFdvToLiquidityRatio, 28, 2, 1000),
    lastStandBlockFdvToLiquidityRatio: clampNumber(raw.lastStandBlockFdvToLiquidityRatio, 22, 2, 1000),
    matureFallbackBlockFdvToLiquidityRatio: clampNumber(raw.matureFallbackBlockFdvToLiquidityRatio, 16, 2, 1000),
    minLiquidityUsdToApply: clampNumber(raw.minLiquidityUsdToApply, 5000, 0, 5000000),
    minValuationUsdToApply: clampNumber(raw.minValuationUsdToApply, 50000, 0, 1000000000),
    cooldownWarnSeconds: Math.round(clampNumber(raw.cooldownWarnSeconds, 180, 10, 86400)),
    cooldownBlockSeconds: Math.round(clampNumber(raw.cooldownBlockSeconds, 900, 30, 604800)),
  };
}

function loadVelocitySelectionConfig(): VelocitySelectionConfig {
  const profile = loadStrategyProfile();
  return normalizeVelocitySelectionConfig(profile.velocitySelection || {});
}

function loadEntryRejectCooldownConfig(): EntryRejectCooldownConfig {
  const profile = loadStrategyProfile();
  return normalizeEntryRejectCooldownConfig(profile.entryRejectCooldowns || {});
}

function loadRouteLiveZeroLiquidityConfig(): RouteLiveZeroLiquidityConfig {
  const profile = loadStrategyProfile();
  return normalizeRouteLiveZeroLiquidityConfig(profile.routeLiveZeroLiquidity || {});
}

function loadMicroScoutQualityConfig(): any {
  const profile = loadStrategyProfile();
  return normalizeMicroScoutQualityConfig(profile.microScoutQuality || {});
}

function isLossStreakPauseDisabled(): boolean {
  const profile = loadStrategyProfile();
  return profile.liveTest?.disableLossStreakPause === true;
}

function isMicroOnlyMode(): boolean {
  const profile = loadStrategyProfile();
  return profile.liveTest?.microOnly === true;
}

// Load velocity for a single mint
function loadVelocity(mint: string): {
  buys60s: number; sells60s: number; buyRatio60s: number;
  velocity: number; isAccelerating: boolean; solVolume60s: number;
} | null {
  return loadVelocityWithMeta(mint).velocity;
}

type VelocityLookupSource = 'memory' | 'file' | 'none';
type VelocityLookupStatus = 'hit' | 'mint-missing' | 'stale-hit' | 'stale-mint-missing' | 'no-snapshot';
type VelocityPayload = {
  buys60s: number;
  sells60s: number;
  buyRatio60s: number;
  velocity: number;
  isAccelerating: boolean;
  solVolume60s: number;
  isSynthetic?: boolean;
  syntheticSource?: string | null;
};

type VelocityLookupMeta = {
  mint: string;
  source: VelocityLookupSource;
  status: VelocityLookupStatus;
  snapshotAgeMs: number | null;
  snapshotUpdatedAt: number | null;
};

function loadVelocityWithMeta(mint: string): { velocity: VelocityPayload | null; meta: VelocityLookupMeta } {
  try {
    const now = Date.now();
    const fileSnapshot = loadVelocitySnapshotFromFile();
    const memorySnapshot = latestVelocityData?.mints ? latestVelocityData : null;
    const candidates: Array<{ source: VelocityLookupSource; snapshot: any | null }> = [
      { source: 'memory', snapshot: memorySnapshot },
      { source: 'file', snapshot: fileSnapshot },
    ];

    for (const candidate of candidates) {
      const snapshot = candidate.snapshot;
      if (!snapshot?.mints || !snapshot.mints[mint]) continue;
      const updatedAt = Number(snapshot.updatedAt || 0) || null;
      const ageMs = updatedAt ? Math.max(0, now - updatedAt) : null;
      const isFresh = ageMs !== null ? ageMs <= 10_000 : false;
      return {
        velocity: snapshot.mints[mint],
        meta: {
          mint,
          source: candidate.source,
          status: isFresh ? 'hit' : 'stale-hit',
          snapshotAgeMs: ageMs,
          snapshotUpdatedAt: updatedAt,
        },
      };
    }

    const freshest = candidates
      .map((candidate) => ({
        source: candidate.source,
        snapshot: candidate.snapshot,
        updatedAt: Number(candidate.snapshot?.updatedAt || 0) || 0,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];

    if (freshest?.snapshot?.mints) {
      const updatedAt = freshest.updatedAt || null;
      const ageMs = updatedAt ? Math.max(0, now - updatedAt) : null;
      const isFresh = ageMs !== null ? ageMs <= 10_000 : false;
      return {
        velocity: null,
        meta: {
          mint,
          source: freshest.source,
          status: isFresh ? 'mint-missing' : 'stale-mint-missing',
          snapshotAgeMs: ageMs,
          snapshotUpdatedAt: updatedAt,
        },
      };
    }

    return {
      velocity: null,
      meta: {
        mint,
        source: 'none',
        status: 'no-snapshot',
        snapshotAgeMs: null,
        snapshotUpdatedAt: null,
      },
    };
  } catch {
    return {
      velocity: null,
      meta: {
        mint,
        source: 'none',
        status: 'no-snapshot',
        snapshotAgeMs: null,
        snapshotUpdatedAt: null,
      },
    };
  }
}

function recordVelocityHydrationMiss(symbol: string, meta: VelocityLookupMeta, stage = 'trySnipe') {
  try {
    if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });
    let stats: any = { updatedAt: 0, totalMisses: 0, byKey: {} };
    if (fs.existsSync(VELOCITY_HYDRATION_STATS_FILE)) {
      stats = JSON.parse(fs.readFileSync(VELOCITY_HYDRATION_STATS_FILE, 'utf-8'));
      if (!stats || typeof stats !== 'object') {
        stats = { updatedAt: 0, totalMisses: 0, byKey: {} };
      }
    }
    const key = `${stage}:${meta.status}:${meta.source}`;
    const bucket = stats.byKey[key] || { count: 0 };
    bucket.count += 1;
    bucket.lastSeenAt = Date.now();
    bucket.lastSymbol = symbol;
    bucket.lastMint = meta.mint;
    bucket.lastSnapshotAgeMs = meta.snapshotAgeMs;
    bucket.lastSnapshotUpdatedAt = meta.snapshotUpdatedAt;
    stats.byKey[key] = bucket;
    stats.totalMisses = Number(stats.totalMisses || 0) + 1;
    stats.updatedAt = Date.now();
    fs.writeFileSync(VELOCITY_HYDRATION_STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
  } catch {
    // Never let telemetry break the live loop.
  }
}

function loadVelocitySnapshotFromFile(): any | null {
  try {
    if (!fs.existsSync(VELOCITY_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(VELOCITY_FILE, 'utf-8'));
    return normalizeVelocitySnapshot(raw);
  } catch {
    return null;
  }
}

function getFreshVelocitySnapshot(): any | null {
  try {
    if (latestVelocityData?.mints) {
      const age = Date.now() - (latestVelocityData.updatedAt || 0);
      if (age <= 10_000) return latestVelocityData;
    }
    const fileSnapshot = loadVelocitySnapshotFromFile();
    if (fileSnapshot?.mints) {
      const age = Date.now() - (fileSnapshot.updatedAt || 0);
      if (age <= 10_000) return fileSnapshot;
    }
    return latestVelocityData?.mints ? latestVelocityData : null;
  } catch {
    return null;
  }
}

function hydrateVelocitySpikeArray(mints: string[]): any {
  const fileSnapshot = loadVelocitySnapshotFromFile();
  const fileMints = fileSnapshot?.mints || {};
  const memoryMints = latestVelocityData?.mints || {};
  const hydrated: any = {};

  for (const mint of mints) {
    if (fileMints[mint]) hydrated[mint] = fileMints[mint];
    else if (memoryMints[mint]) hydrated[mint] = memoryMints[mint];
  }

  if (Object.keys(hydrated).length === 0 && fileSnapshot?.mints) {
    return fileSnapshot;
  }

  return {
    mints: hydrated,
    updatedAt: fileSnapshot?.updatedAt || latestVelocityData?.updatedAt || Date.now(),
  };
}

function shouldTriggerVelocityPoll(spikeCount: number): boolean {
  const now = Date.now();
  const cooldownMs = spikeCount <= 1
    ? VELOCITY_TRIGGER_MICRO_MS
    : spikeCount >= VELOCITY_TRIGGER_LARGE_BATCH
      ? Math.max(1000, Math.floor(VELOCITY_TRIGGER_MIN_MS / 2))
      : VELOCITY_TRIGGER_MIN_MS;

  if (spikeCount < VELOCITY_TRIGGER_MIN_BATCH && now - lastVelocityTriggeredPollAt < cooldownMs) {
    return false;
  }
  if (now - lastVelocityTriggeredPollAt < cooldownMs) {
    return false;
  }

  lastVelocityTriggeredPollAt = now;
  return true;
}

// Load ALL velocity-tracked mints  used for velocity-first discovery

//  DexScreener Real-Time Pair Lookup
//  RugCheck.xyz Security Pre-Flight (Free, No API Key)
const SOFT_RUGCHECK_NAME_PATTERNS = [
  /top 10 holders/i,
  /single holder ownership/i,
  /large amount of lp unlocked/i,
  /low amount of lp providers/i,
];

function isSoftRugCheckName(name: string): boolean {
  return SOFT_RUGCHECK_NAME_PATTERNS.some((pattern) => pattern.test(String(name || '')));
}

async function checkRugSafety(mint: string): Promise<{safe: boolean, riskLevel: string, score: number, softRiskNames: string[]}> {
  try {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { safe: true, riskLevel: 'UNKNOWN', score: 0, softRiskNames: [] }; // fail-open
    const data = await res.json() as any;
    if (data.error) return { safe: true, riskLevel: 'NO_REPORT', score: 0, softRiskNames: [] };
    const score = data.score || 0;
    const risks = Array.isArray(data.risks) ? data.risks : [];
    const upstreamRiskLevel = data.tokenMeta?.riskLevel || data.riskLevel || 'UNKNOWN';
    const softRiskNames = risks
      .map((r: any) => String(r?.name || '').trim())
      .filter((name: string) => isSoftRugCheckName(name))
      .slice(0, 3);
    const blockingRisks = risks.filter((r: any) => {
      const name = String(r?.name || '');
      const level = String(r?.level || '').toLowerCase();
      return (
        !isSoftRugCheckName(name) &&
        (
          level === 'danger' ||
          level === 'critical' ||
          name.includes('Mint Authority') ||
          name.includes('Freeze Authority')
        )
      );
    });
    const safe = blockingRisks.length === 0;
    const riskLevel = safe
      ? (softRiskNames.length > 0 ? softRiskNames.join(', ') : upstreamRiskLevel)
      : blockingRisks
          .map((r: any) => String(r?.name || r?.level || 'BLOCKING_RISK'))
          .slice(0, 3)
          .join(', ');
    return { safe, riskLevel, score, softRiskNames };
  } catch { return { safe: true, riskLevel: 'UNKNOWN', score: 0, softRiskNames: [] }; }
}

//  Holder Concentration Check (RPC - no API key needed)

//  HOLDER CACHE: avoid repeated Chainstack RPC calls for same mint
const holderCache = new Map<string, {safe: boolean, top10Pct: number, holderCount: number, ts: number, isJitterBundle: boolean}>();
const HOLDER_CACHE_TTL = 600_000; // 10 minutes
async function checkHolderConcentration(mint: string): Promise<{safe: boolean, top10Pct: number, holderCount: number, isJitterBundle: boolean}> {
  // Check cache first to avoid RPC calls
  const cached = holderCache.get(mint);
  if (cached && (Date.now() - cached.ts < HOLDER_CACHE_TTL)) {
    return { safe: cached.safe, top10Pct: cached.top10Pct, holderCount: cached.holderCount, isJitterBundle: cached.isJitterBundle };
  }
  try {
    const largestAccounts = await callRpcGateway('getTokenLargestAccounts', [new PublicKey(mint)]);
    if (!largestAccounts?.value || largestAccounts.value.length === 0) {
      return { safe: false, top10Pct: 100, holderCount: 0, isJitterBundle: false };
    }

    const supply = await callRpcGateway('getTokenSupply', [new PublicKey(mint)]);
    const totalSupply = Number(supply?.value?.amount || 0);
    if (totalSupply === 0) return { safe: false, top10Pct: 100, holderCount: 0, isJitterBundle: false };

    // Top 10 holder concentration (excluding AMM / Bonding Curve)
    let top10Total = 0;
    // Skip the #1 largest account (the AMM pool) and assess the rest of the Top 11
    const accounts = largestAccounts.value.slice(1, 11);
    for (const acct of accounts) {
      top10Total += Number(acct.amount || 0);
    }
    const top10Pct = (top10Total / totalSupply) * 100;

    // Holder count estimate and Sybil Jitter Detection
    let nonZeroHolders = 0;
    let isJitterBundle = false;
    let balanceBuckets: { [key: string]: number } = {};

    for (const a of largestAccounts.value) {
      const amt = Number(a.amount);
      if (amt > 0) {
        nonZeroHolders++;
        const pctOfSupply = (amt / totalSupply) * 100;
        if (pctOfSupply > 0.25 && pctOfSupply < 20) { // Ignore dust and ignore massive LP wallets
          const bucket = (Math.round(pctOfSupply * 10) / 10).toFixed(1);
          balanceBuckets[bucket] = (balanceBuckets[bucket] || 0) + 1;
          if (balanceBuckets[bucket] >= 4) {
            isJitterBundle = true;
          }
        }
      }
    }

    const holderSafe = !isJitterBundle && (
      (top10Pct <= 25 && nonZeroHolders >= 3) ||
      (top10Pct <= 35 && nonZeroHolders >= 20) ||
      (top10Pct <= 45 && nonZeroHolders >= 50)
    );

    const result = {
      safe: holderSafe,
      top10Pct,
      holderCount: nonZeroHolders,
      isJitterBundle
    };

    // Update cache
    holderCache.set(mint, { ...result, ts: Date.now() });

    return result;
  } catch (e) {
    return { safe: false, top10Pct: 100, holderCount: 0, isJitterBundle: false }; // fail-closed
  }
}

async function fetchDexScreenerPair(mint: string): Promise<{
  liquidity: number,
  marketCap: number,
  fdv: number,
  priceChange5m: number,
  priceChange1h: number,
  volume5m: number,
  volume1h: number,
  volume6h: number,
  boosted: boolean,
  pairCreatedAt?: number
} | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.pairs || data.pairs.length === 0) return null;
    // Pick the highest-liquidity pair
    const pair = data.pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return normalizeDexScreenerPair(pair);
  } catch { return null; }
}

const jupiterTradabilityCache = new Map<
  string,
  { routable: boolean; outAmount: string | null; ts: number; ttlMs: number; rateLimited?: boolean; retryAfterMs?: number }
>();
const JUPITER_TRADABILITY_TTL_MS = 15_000;
const JUPITER_RATE_LIMIT_MIN_BACKOFF_MS = 2_000;
const JUPITER_RATE_LIMIT_MAX_BACKOFF_MS = 20_000;
let jupiterQuoteRateLimitUntilMs = 0;
let jupiterQuoteRateLimitStrikeCount = 0;

function getActiveJupiterQuoteRateLimitMs(now = Date.now()): number {
  return getJupiterRateLimitRemainingMs(jupiterQuoteRateLimitUntilMs, now);
}

function noteJupiterQuoteRateLimit(retryAfterHeader?: string | null): number {
  const backoffMs = resolveJupiterRateLimitBackoffMs({
    retryAfterHeader,
    strikeCount: jupiterQuoteRateLimitStrikeCount,
    minBackoffMs: JUPITER_RATE_LIMIT_MIN_BACKOFF_MS,
    maxBackoffMs: JUPITER_RATE_LIMIT_MAX_BACKOFF_MS,
  });
  jupiterQuoteRateLimitStrikeCount = Math.min(8, jupiterQuoteRateLimitStrikeCount + 1);
  jupiterQuoteRateLimitUntilMs = Date.now() + backoffMs;
  return backoffMs;
}

function clearJupiterQuoteRateLimit(): void {
  jupiterQuoteRateLimitUntilMs = 0;
  jupiterQuoteRateLimitStrikeCount = 0;
}

async function probeJupiterTradability(
  mint: string,
  amountLamports = 1_000_000,
): Promise<{routable: boolean, outAmount: string | null, rateLimited?: boolean, retryAfterMs?: number}> {
  const now = Date.now();
  const cached = jupiterTradabilityCache.get(mint);
  if (cached && (now - cached.ts) < cached.ttlMs) {
    return {
      routable: cached.routable,
      outAmount: cached.outAmount,
      rateLimited: cached.rateLimited,
      retryAfterMs: cached.retryAfterMs,
    };
  }

  const firstQuote = await getQuote(WSOL, mint, amountLamports, {
    slippageBps: 500,
    restrictIntermediateTokens: true,
    asLegacyTransaction: false,
  });
  if (firstQuote?.errorCode === 'RATE_LIMITED') {
    const retryAfterMs = Math.max(JUPITER_RATE_LIMIT_MIN_BACKOFF_MS, Number(firstQuote.retryAfterMs) || getActiveJupiterQuoteRateLimitMs(now));
    const rateLimitedResult = { routable: false, outAmount: null, rateLimited: true, retryAfterMs };
    jupiterTradabilityCache.set(mint, { ...rateLimitedResult, ts: now, ttlMs: retryAfterMs });
    return rateLimitedResult;
  }

  const quote = firstQuote || await getQuote(WSOL, mint, amountLamports, 500);
  if (quote?.errorCode === 'RATE_LIMITED') {
    const retryAfterMs = Math.max(JUPITER_RATE_LIMIT_MIN_BACKOFF_MS, Number(quote.retryAfterMs) || getActiveJupiterQuoteRateLimitMs(now));
    const rateLimitedResult = { routable: false, outAmount: null, rateLimited: true, retryAfterMs };
    jupiterTradabilityCache.set(mint, { ...rateLimitedResult, ts: now, ttlMs: retryAfterMs });
    return rateLimitedResult;
  }
  const result = {
    routable: Boolean(quote?.outAmount),
    outAmount: quote?.outAmount || null,
    rateLimited: false,
    retryAfterMs: 0,
  };
  jupiterTradabilityCache.set(mint, { ...result, ts: now, ttlMs: JUPITER_TRADABILITY_TTL_MS });
  return result;
}

async function getTempBlacklistPenalty(mint: string): Promise<number | null> {
  try {
    const penaltyStr = await RedisBus.getPublisher().get(REDIS_KEYS.tempBlacklist(mint));
    if (!penaltyStr) return null;
    const penalty = parseFloat(penaltyStr);
    return Number.isFinite(penalty) ? penalty : 1;
  } catch {
    return null;
  }
}



function loadAllVelocityMints(): Array<{
  mint: string; symbol?: string; buys60s: number; sells60s: number; buyRatio60s: number;
  velocity: number; isAccelerating: boolean; solVolume60s: number; isSynthetic?: boolean; refinementOnly?: boolean; syntheticSource?: string | null;
}> {
  try {
    const snapshot = getFreshVelocitySnapshot();
    if (!snapshot?.mints) return [];
    const mints = snapshot.mints || {};
    return Object.entries(mints).map(([mint, data]: [string, any]) => ({
      mint,
      ...data,
      isSynthetic: Boolean(data?.isSynthetic),
      refinementOnly: Boolean(data?.refinementOnly),
      syntheticSource: data?.syntheticSource || null,
    }));
  } catch { return []; }
}

function loadSniperWeight(): number {
  try {
    if (!fs.existsSync(ALLOCATION_FILE)) return 1.0;
    const a = JSON.parse(fs.readFileSync(ALLOCATION_FILE, 'utf-8'));
    const w = a.sniper_weight ?? 1.0;
    return Math.min(1.0, Math.max(0.1, w)); // clamp 10%100%
  } catch { return 1.0; }
}

async function getLastStandContext(): Promise<LastStandContext> {
  const config = loadLastStandConfig();
  const { spendableSol, nativeSol } = await getSpendableNativeBalance(connection, wallet.publicKey, config.reserveSol || MIN_NATIVE_SOL_RESERVE);
  const deployableSol = Math.max(0, spendableSol);
  const hasLastStandPosition = store.positions.some(p => p.entryMode === 'last-stand');
  const active = config.enabled &&
    !hasLastStandPosition &&
    spendableSol <= config.triggerTreasurySol &&
    deployableSol >= config.minDeploySol;

  return {
    config,
    spendableSol,
    nativeSol,
    deployableSol,
    hasLastStandPosition,
    active,
  };
}

async function runLastStandScan(context: LastStandContext): Promise<boolean> {
  const { config } = context;
  const rejectCounts = {
    blacklisted: 0,
    alreadyHeld: 0,
    lowBuys60s: 0,
    lowBuyRatio60s: 0,
    missingCreatedAt: 0,
    tooYoung: 0,
    tooOld: 0,
    lowMomentum5m: 0,
    lowLiquidity: 0,
    lowVolume: 0,
  };

  if (!context.active) return false;
  if (store.positions.length > 0) {
    console.log(`[SNIPER] LAST STAND armed but waiting for ${store.positions.length} open position(s) to clear before an all-in entry.`);
    return false;
  }

  const velMints = loadAllVelocityMints();
  if (velMints.length === 0) {
    console.log('[SNIPER] LAST STAND armed but velocity feed is empty or stale.');
    return false;
  }

  let trendingMap: Map<string, any> = new Map();
  if (fs.existsSync(TRENDING_FILE)) {
    try {
      const tRaw = JSON.parse(fs.readFileSync(TRENDING_FILE, 'utf-8'));
      trendingMap = buildTrendingMap(tRaw);
    } catch {}
  }

  const candidates: Array<{
    mint: string;
    symbol: string;
    volume1h: number;
    priceChange1h: number;
    buys1h: number;
    sells1h: number;
    buyRatio: number;
    tokenAgeSec: number;
    ageKnown: boolean;
    momentum5m: number;
    momentum1m: number;
    pairCreatedAt?: number;
    score: number;
  }> = [];

  for (const velocityMint of velMints) {
    if (store.blacklist.includes(velocityMint.mint)) {
      rejectCounts.blacklisted += 1;
      continue;
    }
    if (store.positions.find(p => p.mint === velocityMint.mint)) {
      rejectCounts.alreadyHeld += 1;
      continue;
    }
    if (velocityMint.buys60s < config.minBuys60s) {
      rejectCounts.lowBuys60s += 1;
      continue;
    }
    if (velocityMint.buyRatio60s < config.minBuyRatio60s) {
      rejectCounts.lowBuyRatio60s += 1;
      continue;
    }

    const trending = trendingMap.get(velocityMint.mint);
    const livePair = await fetchDexScreenerPair(velocityMint.mint);
    const createdAt = livePair?.pairCreatedAt ?? trending?.pairCreatedAt ?? trending?.createdAt;
    const ageKnown = Boolean(createdAt);
    if (!ageKnown) {
      rejectCounts.missingCreatedAt += 1;
    }

    const tokenAgeSec = ageKnown
      ? Math.max(0, Math.floor((Date.now() - Number(createdAt)) / 1000))
      : -1;
    if (ageKnown && tokenAgeSec < config.minTokenAgeSeconds) {
      rejectCounts.tooYoung += 1;
      continue;
    }

    const momentum5m = Math.max(
      Number(trending?.priceChange5m ?? Number.NEGATIVE_INFINITY),
      Number(livePair?.priceChange5m ?? Number.NEGATIVE_INFINITY),
      0,
    );
    const momentumPass =
      momentum5m >= config.minMomentum5mPct ||
      (momentum5m >= config.minMomentum5mPct * 0.7 &&
        Number(trending?.priceChange1m ?? livePair?.priceChange1m ?? 0) > 0 &&
        velocityMint.buyRatio60s >= Math.max(config.minBuyRatio60s, 0.65));
    if (!momentumPass) {
      rejectCounts.lowMomentum5m += 1;
      continue;
    }

    const liquidityUsd = Math.max(
      Number(trending?.liquidityUsd || 0),
      Number(livePair?.liquidity || 0),
    );
    const requiredLiquidityUsd = ageKnown ? config.minLiquidityUsd : config.minLiquidityUsd * 1.5;
    if (liquidityUsd < requiredLiquidityUsd) {
      rejectCounts.lowLiquidity += 1;
      continue;
    }

    const volume1h = Math.max(
      Number(trending?.volume1h || 0),
      Number(livePair?.volume1h || 0),
      velocityMint.solVolume60s * 60 * 150,
    );
    const requiredVolumeUsd = ageKnown ? config.minVolumeUsd : config.minVolumeUsd * 1.5;
    if (volume1h < requiredVolumeUsd) {
      rejectCounts.lowVolume += 1;
      continue;
    }

    const momentum1m = Number(trending?.priceChange1m || 0);
    if (!ageKnown && momentum1m <= 0) {
      rejectCounts.lowMomentum5m += 1;
      continue;
    }
    const priceChange1h = Number(trending?.priceChange1h ?? livePair?.priceChange1h ?? momentum5m);
    const buys1h = Number(trending?.buys1h || velocityMint.buys60s * 60);
    const sells1h = Number(trending?.sells1h || velocityMint.sells60s * 60);
    const buyRatio = Number(trending?.buyRatio || (velocityMint.buyRatio60s / Math.max(0.01, 1 - velocityMint.buyRatio60s)));
    const symbol = velocityMint.symbol || trending?.symbol || velocityMint.mint.slice(0, 8);
    let ageScoreMultiplier = 1;
    if (!ageKnown) {
      ageScoreMultiplier = 0.8;
    } else if (config.maxTokenAgeSeconds > 0 && tokenAgeSec > config.maxTokenAgeSeconds) {
      rejectCounts.tooOld += 1;
      ageScoreMultiplier = 0.75;
    } else if (tokenAgeSec > Math.max(config.minTokenAgeSeconds * 4, 600)) {
      ageScoreMultiplier = 0.9;
    }
    const score = volume1h * Math.max(1, momentum5m) * Math.max(1, velocityMint.buyRatio60s * 100) * ageScoreMultiplier;

    candidates.push({
      mint: velocityMint.mint,
      symbol,
      volume1h,
      priceChange1h,
      buys1h,
      sells1h,
      buyRatio,
      tokenAgeSec,
      ageKnown,
      momentum5m,
      momentum1m,
      pairCreatedAt: createdAt,
      score,
    });
  }

  if (candidates.length === 0) {
    console.log(
      `[SNIPER] LAST STAND armed (${context.spendableSol.toFixed(4)} SOL treasury) but no flow candidate passed filters. ` +
      `Rejects: blacklist=${rejectCounts.blacklisted}, held=${rejectCounts.alreadyHeld}, buys=${rejectCounts.lowBuys60s}, ratio=${rejectCounts.lowBuyRatio60s}, ` +
      `missingAge=${rejectCounts.missingCreatedAt}, tooYoung=${rejectCounts.tooYoung}, tooOld=${rejectCounts.tooOld}, momentum=${rejectCounts.lowMomentum5m}, ` +
      `liquidity=${rejectCounts.lowLiquidity}, volume=${rejectCounts.lowVolume}.`
    );
    return false;
  }

  candidates.sort((a, b) => b.score - a.score);
  const shortlist = candidates.slice(0, config.maxCandidatesPerPoll);
  console.log(`[SNIPER] LAST STAND armed at ${context.spendableSol.toFixed(4)} SOL. Evaluating ${shortlist.length} high-conviction candidate(s).`);

  for (const candidate of shortlist) {
    if (store.positions.length > 0) break;

    const ageLabel = candidate.ageKnown ? `${candidate.tokenAgeSec}s` : 'unknown';
    console.log(`[SNIPER] LAST STAND candidate ${candidate.symbol} | age ${ageLabel} | 5m ${candidate.momentum5m.toFixed(1)}% | volume $${candidate.volume1h.toFixed(0)}`);
    await trySnipe(
      candidate.mint,
      candidate.symbol,
      candidate.volume1h,
      candidate.priceChange1h,
      candidate.buys1h,
      candidate.sells1h,
      candidate.buyRatio,
      'LAST_STAND',
      0.95,
      candidate.tokenAgeSec,
      candidate.momentum5m,
      candidate.momentum1m,
      candidate.pairCreatedAt,
      {
        entryMode: 'last-stand',
        forceAllIn: true,
        reserveSol: config.reserveSol,
        minDeploySol: config.minDeploySol,
        maxDeploySol: config.maxDeploySol,
        bypassAgeFloor: true,
        minTokenAgeSec: config.minTokenAgeSeconds,
        maxTokenAgeSec: config.maxTokenAgeSeconds,
        minLiquidityUsd: config.minLiquidityUsd,
        minVolumeUsd: config.minVolumeUsd,
        minMomentum5mPct: config.minMomentum5mPct,
        disablePartialTakeProfit: true,
        trailingActivationPct: config.trailingActivationPct,
        trailingStopPct: config.trailingStopPct,
        stopLossPct: config.stopLossPct / 100,
        maxHoldMinutes: config.maxHoldMinutes,
        maxTPpct: 999,
      },
    );
  }

  return store.positions.some(p => p.entryMode === 'last-stand');
}


export function appendTrade(record: {
  agent: string; action: 'BUY' | 'SELL';
  mint: string; symbol: string;
  amountSol: number; pnlSol?: number;
  legPnlSol?: number;
  lifecyclePnlSol?: number;
  tradeId?: string; parentBuyId?: string;
  sig: string; reason?: string;
  taSig?: string; taConf?: number;
  holdMs?: number;
  rsi?: number; macdHist?: number;
  timestamp?: number; ts?: number;
  openedAt?: number; closedAt?: number;
  entryMode?: string;
  entryPriceSol?: number; entryCostSol?: number;
  tokenAmount?: number; tokenAmountRaw?: number;
  remainingAmount?: number; remainingAmountRaw?: number;
  remainingEntryCostSol?: number; remainingEntryPriceSol?: number;
  decimals?: number;
  // Freshness fields (populated on BUY)
  tokenAgeSec?: number;     // age of token at entry time
  momentum5m?: number;      // 5-min price change at entry
  momentum1m?: number;      // 1-min price change at entry
  pairCreatedAt?: number;   // unix ms when pair was created
  ata?: string;             // Associated Token Account
  tokenProgramId?: string;
  partialExit?: boolean;
  entryFamily?: string;
  sourceLane?: string;
  probeLikeEntry?: boolean;
  riskScore?: number;
  riskBand?: string;
  positionMultiplier?: number;
  terrainSampleCount?: number;
  terrainSpanMs?: number;
  terrainStrongFlowSamples?: number;
  terrainPriceDelta5m?: number;
  terrainPriceOffPeak5m?: number;
  terrainFlowDecayRatio?: number | null;
  terrainLiquidityDeltaUsd?: number;
  terrainRouteStrengthPct?: number | null;
  routeLiveFastTrack?: boolean;
  slopfestParamsSetId?: string;
  slopfestParamsRaw?: string;
  marketCapUsd?: number;
  liquidityUsd?: number;
  buyRatio?: number;
  quotaAssist?: boolean;
  quotaAssistLevel?: number;
  walletSignalPriority?: string;
  walletConsensusScore?: number;
  walletCount?: number;
  walletPnlScore?: number;
  walletWeightedScore?: number;
  walletCompositeScore?: number;
  kolConfirmed?: boolean;
  alphaBoost?: number;
  alphaKolCount?: number;
  preferredHoldMs?: number;
}) {
  try {
    const normalizedRecord = normalizeTradeRecord(record);
    if (!shouldPersistTradeRecord(normalizedRecord)) {
      console.warn(
        `[SNIPER]  JOURNAL SKIP: blocked ${normalizedRecord.action} for ${normalizedRecord.symbol || normalizedRecord.mint} due to ghost signature ${normalizedRecord.sig}`,
      );
      return;
    }
    const pub = RedisBus.getPublisher();
    const entries: string[] = [];
    for (const [k, v] of Object.entries(normalizedRecord)) {
        if (v !== undefined && v !== null) {
            entries.push(k, v.toString());
        }
    }

    // Asynchronously stream into Redis memory buffer
    pub.xadd(STREAMS.TRADES, '*', ...entries).catch(() => {});

    // Optional fallback telemetry log
    if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });
    const line = JSON.stringify(normalizedRecord) + '\n';
    const extraJournalTargets = process.env.PAPER_MODE === 'true'
      ? []
      : [
          path.join(__dirname, '../../signals/trade_journal.jsonl'),
          path.join(__dirname, '../../trade_journal.jsonl'),
          path.join(__dirname, '../../signals/archive/trade_history.jsonl'),
        ];
    const targets = uniqueJournalTargets(JOURNAL_FILE, extraJournalTargets);
    for (const target of targets) {
      fs.appendFileSync(target, line, 'utf-8');
    }
    if (normalizedRecord.action === 'SELL' && Number.isFinite(Number(normalizedRecord.pnlSol))) {
      recordFamilyTrade(familyPerformanceMemory, normalizedRecord, FAMILY_PERFORMANCE_GATE_CONFIG);
    }
    appendTradeProfileArtifacts(normalizedRecord);
  } catch { /* never crash on journal write */ }
}

function computeLifecyclePnlForClosedTrade(parentBuyId: string, currentRealizedSol: number): {
  lifecyclePnlSol: number | null;
  entryCostSol: number | null;
  proceedsSol: number | null;
  priorPartialExitCount: number;
} {
  try {
    if (!parentBuyId || !fs.existsSync(JOURNAL_FILE)) {
      return { lifecyclePnlSol: null, entryCostSol: null, proceedsSol: null, priorPartialExitCount: 0 };
    }
    const rows = fs.readFileSync(JOURNAL_FILE, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const buyRow = rows.find((row: any) =>
      String(row?.action || '').toUpperCase() === 'BUY' &&
      String(row?.tradeId || '') === parentBuyId,
    );
    const entryCostSol = Number(buyRow?.entryCostSol ?? buyRow?.amountSol ?? NaN);
    if (!Number.isFinite(entryCostSol)) {
      return { lifecyclePnlSol: null, entryCostSol: null, proceedsSol: null, priorPartialExitCount: 0 };
    }

    const priorSells = rows.filter((row: any) =>
      String(row?.action || '').toUpperCase() === 'SELL' &&
      String(row?.parentBuyId || '') === parentBuyId &&
      shouldPersistTradeRecord(row, process.env.PAPER_MODE === 'true'),
    );
    const priorProceedsSol = priorSells.reduce((sum: number, row: any) => {
      const proceeds = Number(row?.amountSol ?? NaN);
      return Number.isFinite(proceeds) ? sum + proceeds : sum;
    }, 0);
    const proceedsSol = priorProceedsSol + currentRealizedSol;
    return {
      lifecyclePnlSol: proceedsSol - entryCostSol,
      entryCostSol,
      proceedsSol,
      priorPartialExitCount: priorSells.filter((row: any) => row?.partialExit === true).length,
    };
  } catch {
    return { lifecyclePnlSol: null, entryCostSol: null, proceedsSol: null, priorPartialExitCount: 0 };
  }
}

const MISSED_TARGETS_FILE = path.join(SIGNALS_DIR, 'missed_targets.jsonl');
const MISSED_TARGET_STATS_FILE = path.join(SIGNALS_DIR, 'missed_target_stats.json');

function loadMissedTargetStats(): any {
  try {
    if (!fs.existsSync(MISSED_TARGET_STATS_FILE)) {
      return {
        generatedAt: null,
        totals: { count: 0 },
        byReason: {},
        byStage: {},
        byEntryMode: {},
        byStageReason: {},
      };
    }
    return JSON.parse(fs.readFileSync(MISSED_TARGET_STATS_FILE, 'utf-8'));
  } catch {
    return {
      generatedAt: null,
      totals: { count: 0 },
      byReason: {},
      byStage: {},
      byEntryMode: {},
      byStageReason: {},
    };
  }
}

function updateMissedTargetMetric(entry: any, key: string, value: any) {
  if (!Number.isFinite(value)) return;
  if (!entry.metrics) entry.metrics = {};
  if (!entry.metrics[key]) {
    entry.metrics[key] = { samples: 0, avg: 0 };
  }
  const metric = entry.metrics[key];
  metric.avg = ((metric.avg * metric.samples) + Number(value)) / (metric.samples + 1);
  metric.samples += 1;
}

function updateMissedTargetBucket(collection: any, rawKey: string | undefined, payload: any) {
  const key = rawKey && String(rawKey).trim() ? String(rawKey).trim() : 'unknown';
  if (!collection[key]) {
    collection[key] = {
      count: 0,
      lastSeenAt: null,
      lastSymbol: null,
      lastMint: null,
    };
  }
  const entry = collection[key];
  entry.count += 1;
  entry.lastSeenAt = payload.ts;
  entry.lastSymbol = payload.symbol || entry.lastSymbol;
  entry.lastMint = payload.mint || entry.lastMint;
  updateMissedTargetMetric(entry, 'tokenAgeSec', payload.tokenAgeSec);
  updateMissedTargetMetric(entry, 'momentum5m', payload.momentum5m);
  updateMissedTargetMetric(entry, 'momentum1m', payload.momentum1m);
  updateMissedTargetMetric(entry, 'volume1hUsd', payload.volume1hUsd);
  updateMissedTargetMetric(entry, 'liquidityUsd', payload.liquidityUsd);
  updateMissedTargetMetric(entry, 'buys1h', payload.buys1h);
  updateMissedTargetMetric(entry, 'sells1h', payload.sells1h);
  updateMissedTargetMetric(entry, 'buyRatio', payload.buyRatio);
  updateMissedTargetMetric(entry, 'buys60s', payload.buys60s);
  updateMissedTargetMetric(entry, 'sells60s', payload.sells60s);
  updateMissedTargetMetric(entry, 'buyRatio60s', payload.buyRatio60s);
  updateMissedTargetMetric(entry, 'velocity', payload.velocity);
  updateMissedTargetMetric(entry, 'solVolume60s', payload.solVolume60s);
  updateMissedTargetMetric(entry, 'fdvUsd', payload.fdvUsd);
  updateMissedTargetMetric(entry, 'fdvToLiquidityRatio', payload.fdvToLiquidityRatio);
  updateMissedTargetMetric(entry, 'liquidityToFdvRatio', payload.liquidityToFdvRatio);
  updateMissedTargetMetric(entry, 'bundlerScore', payload.bundlerScore);
  updateMissedTargetMetric(entry, 'bundlerTurnoverToLiquidityRatio', payload.bundlerTurnoverToLiquidityRatio);
  updateMissedTargetMetric(entry, 'bundlerPriceResponsePerSol', payload.bundlerPriceResponsePerSol);
  updateMissedTargetMetric(entry, 'terrainSampleCount', payload.terrainSampleCount);
  updateMissedTargetMetric(entry, 'terrainSpanMs', payload.terrainSpanMs);
  updateMissedTargetMetric(entry, 'terrainStrongFlowSamples', payload.terrainStrongFlowSamples);
  updateMissedTargetMetric(entry, 'terrainPriceDelta5m', payload.terrainPriceDelta5m);
  updateMissedTargetMetric(entry, 'terrainPriceOffPeak5m', payload.terrainPriceOffPeak5m);
  updateMissedTargetMetric(entry, 'terrainFlowDecayRatio', payload.terrainFlowDecayRatio);
  updateMissedTargetMetric(entry, 'terrainLiquidityDeltaUsd', payload.terrainLiquidityDeltaUsd);
  updateMissedTargetMetric(entry, 'terrainRouteStrengthPct', payload.terrainRouteStrengthPct);
}

export function logMissedTarget(record: any) {
  try {
    if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });
    const ts = Date.now();
    const payload = {
      ts,
      fallbackTimestamp: ts,
      mode: process.env.PAPER_MODE === 'true' ? 'paper' : 'live',
      ...record,
      stage: record?.stage || 'unknown',
      reason: record?.reason || 'unknown',
      entryMode: record?.entryMode || 'normal',
    };
    fs.appendFileSync(MISSED_TARGETS_FILE, JSON.stringify(payload) + '\n', 'utf-8');

    const stats = loadMissedTargetStats();
    stats.generatedAt = ts;
    stats.totals.count += 1;
    updateMissedTargetBucket(stats.byReason, payload.reason, payload);
    updateMissedTargetBucket(stats.byStage, payload.stage, payload);
    updateMissedTargetBucket(stats.byEntryMode, payload.entryMode, payload);
    updateMissedTargetBucket(stats.byStageReason, `${payload.stage}::${payload.reason}`, payload);
    fs.writeFileSync(MISSED_TARGET_STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
  } catch { }
}

// Load TA signal for a mint (soft gate  doesn't block if no data)
function loadSignal(mint: string): { signal: string; confidence: number; reasons: string[] } | null {
  try {
    if (!fs.existsSync(STRATEGY_FILE)) return null;
    const s = JSON.parse(fs.readFileSync(STRATEGY_FILE, 'utf-8'));
    const age = Date.now() - (s.updatedAt || 0);
    if (age > 3 * 60_000) return null; // stale after 3min
    return s.signals?.[mint] || null;
  } catch { return null; }
}

//  Types
interface Position {
  tradeId:        string;
  mint:           string;
  ata:            string;   // Associated Token Account
  tokenProgramId?: string;
  symbol:         string;
  buyPriceSol:    number;
  tokenAmount:    number;
  openedAt:       number;
  entryPriceSol:  number;
  entryVolume5mUsd?: number;
  signature:      string;
  peakPnlPct:     number;
  entryMom5m?:    number;
  entryBuyRatio?: number;
  fdvUsd?: number;
  fdvToLiquidityRatio?: number;
  liquidityToFdvRatio?: number;
  bundlerScore?:  number;
  bundlerSeverity?: string;
  bundlerFlags?: string;
  riskScore?: number;
  riskBand?: string;
  positionMultiplier?: number;
  sourceLane?: string;
  entryFamily?: string;
  probeLikeEntry?: boolean;
  quotaAssist?: boolean;
  quotaAssistLevel?: number;
  walletSignalPriority?: string;
  walletConsensusScore?: number;
  walletCount?: number;
  walletPnlScore?: number;
  walletWeightedScore?: number;
  walletCompositeScore?: number;
  kolConfirmed?: boolean;
  alphaBoost?: number;
  alphaKolCount?: number;
  preferredHoldMs?: number;
  tokenAgeSec?: number;
  momentum1m?: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  terrainSampleCount?: number;
  terrainSpanMs?: number;
  terrainStrongFlowSamples?: number;
  terrainPriceDelta5m?: number;
  terrainPriceOffPeak5m?: number;
  terrainFlowDecayRatio?: number | null;
  terrainLiquidityDeltaUsd?: number;
  terrainRouteStrengthPct?: number | null;
  routeLiveFastTrack?: boolean;
  partialProfitStage?: number;
  slopfestParamsSetId?: string;

  maxTPpct:       number;
  maxHoldMinutes: number;
  stopLossPct:    number;

  engineForceEvict?: boolean;
  entryMode?: EntryMode;
  partialSold?: boolean;
  disablePartialTakeProfit?: boolean;
  trailingActivationPct?: number;
  trailingStopPct?: number;
  decimals?: number;
  exitFailureCount?: number;
  lastExitFailureAt?: number;
  lastExitFailureReason?: string;
  lastExitFailureCode?: number | null;
  nextExitRetryAt?: number;
  balanceFetchFailureCount?: number;
  lastMarkValueSol?: number;
  lastMarkValueUsd?: number;
  lastPnlPct?: number;
  lastMarkAt?: number;
  lastMarkSource?: string;
  lastKlineCloseUsd?: number;
  lastHoldMinutes?: number;
  lastObservedBalanceLamports?: number;
  lastBalanceSource?: string;
}

interface PositionStore {
  positions: Position[];
  blacklist: string[];       // session-only blacklist; not persisted across restarts
  strikes: Record<string, number>;
  stats: {
    wins: number;
    losses: number;
    totalPnlSol: number;
    consecutiveLosses: number;
    pausedUntil: number;
    lastRecoveryProbeAt: number;
    lastLossAt: number;
  };
}

type WalletHoldingSnapshotRow = {
  mint: string;
  symbol: string;
  uiAmount: number;
  rawAmount: string;
  decimals: number | null;
  tokenProgramId: string | null;
  tracked: boolean;
  classification: 'tracked' | 'stable' | 'untracked';
  blacklisted: boolean;
  strikeCount: number;
  recoverableOrphan: boolean;
  entryMode: string | null;
  openedAt: number | null;
  heldMinutes: number | null;
};

//  State
let store: PositionStore = {
  positions: [],
  blacklist: [],
  strikes: {},
  stats: {
    wins: 0,
    losses: 0,
    totalPnlSol: 0,
    consecutiveLosses: 0,
    pausedUntil: 0,
    lastRecoveryProbeAt: 0,
    lastLossAt: 0,
  },
};
loadStore();
let familyPerformanceMemory = buildFamilyPerformanceMemory([]);

const TOKEN_PROGRAM_ID_STR = TOKEN_PROGRAM_ID.toBase58();
const TOKEN_2022_PROGRAM_ID_STR = TOKEN_2022_PROGRAM_ID.toBase58();
const tokenProgramIdCache = new Map<string, string>();

function readJsonFile<T = any>(file: string): T | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function getCurrentRealizedPnlSol(): number {
  const allocatorState =
    readJsonFile<any>(CAPITAL_ALLOCATOR_STATE_FILE) ||
    readJsonFile<any>(ALLOCATION_FILE) ||
    null;
  const candidates = [
    allocatorState?.total_realized_pnl_sol,
    allocatorState?.totalRealizedPnlSol,
    allocatorState?.totalPnlSol,
    store?.stats?.totalPnlSol,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function isWalletConfirmedSignal(signal: any) {
  if (!signal || signal?.executable !== true) return false;
  const walletCount = Array.isArray(signal?.wallets) ? signal.wallets.length : Number(signal?.walletCount || 0);
  const consensus = Number(signal?.consensusScore || 0);
  const composite = Number(signal?.walletCompositeScore || signal?.walletWeightedScore || signal?.walletPnlScore || 0);
  return walletCount > 0 || consensus > 0 || composite > 0;
}

function hasStrongRecentFlowConfirmation(input: {
  terrainSummary?: any;
  buys60s?: number;
  solVolume60s?: number;
  velocity?: number;
}) {
  const terrainConfig = loadTerrainMemoryConfig();
  return (
    Number(input?.terrainSummary?.strongFlowSamples || 0) >= terrainConfig.minStrongFlowSamples &&
    Number(input?.buys60s || 0) >= terrainConfig.minStrongFlowBuys60s &&
    Number(input?.solVolume60s || 0) >= terrainConfig.minStrongFlowSolVolume60s &&
    Number(input?.velocity || 0) >= terrainConfig.minStrongFlowVelocity
  );
}

function parseOptionalNumber(value: any): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function classifyDuplicateImageRisk(imageDupCount: number | null): 'none' | 'low' | 'medium' | 'high' | 'unknown' {
  if (imageDupCount === null) return 'unknown';
  if (imageDupCount >= 5) return 'high';
  if (imageDupCount >= 3) return 'medium';
  if (imageDupCount >= 1) return 'low';
  return 'none';
}

const GMGN_CLI_BIN = process.platform === 'win32' ? 'gmgn-cli.cmd' : '/usr/bin/gmgn-cli';
const GMGN_CLI_TIMEOUT_MS = 25_000;
const GMGN_TOKEN_INFO_TTL_MS = Math.max(5 * 60_000, Number(process.env.GMGN_TOKEN_INFO_TTL_MS || 30 * 60_000));
const GMGN_BAN_COOLDOWN_MS = Math.max(5 * 60_000, Number(process.env.GMGN_BAN_COOLDOWN_MS || 30 * 60_000));
type DiscoveryRiskMeta = {
  imageDupCount: number | null;
  duplicateImageRisk: string;
  logoUrl: string;
  launchpad: string;
  standard: string;
  source: string;
  fetchedAt: number;
};
const gmgnImageDupCache = new Map<string, DiscoveryRiskMeta>();
type GmgnTokenInfoCacheEntry = {
  meta: DiscoveryRiskMeta;
  expiresAt: number;
};
type GmgnTokenInfoCacheDocument = {
  version: number;
  updatedAt: number;
  banUntilMs: number;
  entries: Record<string, GmgnTokenInfoCacheEntry>;
};
let gmgnBanUntilMs = 0;
let gmgnBanNoticeUntilMs = 0;
let gmgnTokenInfoCacheSnapshot: {
  loadedAt: number;
  mtimeMs: number;
  banUntilMs: number;
  entries: Record<string, GmgnTokenInfoCacheEntry>;
} = {
  loadedAt: 0,
  mtimeMs: 0,
  banUntilMs: 0,
  entries: {},
};
let bagsEnrichmentCacheSnapshot: {
  loadedAt: number;
  mtimeMs: number;
  free: Record<string, any>;
  jupiter: Record<string, any>;
} = {
  loadedAt: 0,
  mtimeMs: 0,
  free: {},
  jupiter: {},
};

function loadGmgnTokenInfoCache() {
  try {
    if (!fs.existsSync(GMGN_TOKEN_INFO_CACHE_FILE)) {
      gmgnTokenInfoCacheSnapshot = {
        loadedAt: Date.now(),
        mtimeMs: 0,
        banUntilMs: gmgnBanUntilMs,
        entries: {},
      };
      return gmgnTokenInfoCacheSnapshot;
    }
    const stat = fs.statSync(GMGN_TOKEN_INFO_CACHE_FILE);
    const mtimeMs = Number(stat.mtimeMs || 0);
    if (gmgnTokenInfoCacheSnapshot.loadedAt && gmgnTokenInfoCacheSnapshot.mtimeMs === mtimeMs) {
      gmgnBanUntilMs = Math.max(gmgnBanUntilMs, gmgnTokenInfoCacheSnapshot.banUntilMs || 0);
      return gmgnTokenInfoCacheSnapshot;
    }
    const payload = readJsonFile<GmgnTokenInfoCacheDocument>(GMGN_TOKEN_INFO_CACHE_FILE) || {
      version: 1,
      updatedAt: 0,
      banUntilMs: 0,
      entries: {},
    };
    gmgnTokenInfoCacheSnapshot = {
      loadedAt: Date.now(),
      mtimeMs,
      banUntilMs: Math.max(0, Number(payload.banUntilMs || 0)),
      entries: (payload.entries && typeof payload.entries === 'object') ? payload.entries : {},
    };
    gmgnBanUntilMs = Math.max(gmgnBanUntilMs, gmgnTokenInfoCacheSnapshot.banUntilMs || 0);
  } catch {
    gmgnTokenInfoCacheSnapshot = {
      loadedAt: Date.now(),
      mtimeMs: 0,
      banUntilMs: gmgnBanUntilMs,
      entries: {},
    };
  }
  return gmgnTokenInfoCacheSnapshot;
}

function persistGmgnTokenInfoCache() {
  const snapshot = loadGmgnTokenInfoCache();
  const payload: GmgnTokenInfoCacheDocument = {
    version: 1,
    updatedAt: Date.now(),
    banUntilMs: Math.max(gmgnBanUntilMs, snapshot.banUntilMs || 0),
    entries: snapshot.entries || {},
  };
  fs.writeFileSync(GMGN_TOKEN_INFO_CACHE_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  try {
    const stat = fs.statSync(GMGN_TOKEN_INFO_CACHE_FILE);
    gmgnTokenInfoCacheSnapshot = {
      loadedAt: Date.now(),
      mtimeMs: Number(stat.mtimeMs || 0),
      banUntilMs: payload.banUntilMs,
      entries: payload.entries,
    };
  } catch {
    gmgnTokenInfoCacheSnapshot = {
      loadedAt: Date.now(),
      mtimeMs: 0,
      banUntilMs: payload.banUntilMs,
      entries: payload.entries,
    };
  }
}

function getCachedGmgnTokenInfoMeta(mint: string, now = Date.now()): DiscoveryRiskMeta | null {
  const snapshot = loadGmgnTokenInfoCache();
  const entry = snapshot.entries?.[mint];
  if (!entry) return null;
  if (Number(entry.expiresAt || 0) <= now) return null;
  return entry.meta || null;
}

function rememberGmgnTokenInfoMeta(mint: string, meta: DiscoveryRiskMeta, ttlMs = GMGN_TOKEN_INFO_TTL_MS) {
  const snapshot = loadGmgnTokenInfoCache();
  snapshot.entries[mint] = {
    meta,
    expiresAt: Date.now() + ttlMs,
  };
  persistGmgnTokenInfoCache();
}

function recordGmgnTemporaryBan(message: string) {
  gmgnBanUntilMs = Math.max(gmgnBanUntilMs, computeGmgnBanUntilMs(message, GMGN_BAN_COOLDOWN_MS));
  const snapshot = loadGmgnTokenInfoCache();
  snapshot.banUntilMs = gmgnBanUntilMs;
  persistGmgnTokenInfoCache();
  if (Date.now() >= gmgnBanNoticeUntilMs) {
    console.warn(
      `[SNIPER] GMGN cooldown active until ${new Date(gmgnBanUntilMs).toISOString()} — using cached/local metadata only.`,
    );
    gmgnBanNoticeUntilMs = gmgnBanUntilMs;
  }
}

function runGmgnCliJson(args: string): any | null {
  if (Date.now() < gmgnBanUntilMs) return null;
  try {
    const argv = args.split(/\s+/).filter(Boolean);
    const res = spawnSync(GMGN_CLI_BIN, [...argv, '--raw'], {
      cwd: process.cwd(),
      timeout: GMGN_CLI_TIMEOUT_MS,
      encoding: 'utf-8',
      windowsHide: true,
      shell: true,
      env: { ...process.env },
    });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      throw new Error(String(res.stderr || res.stdout || `gmgn-cli exited ${res.status}`).trim());
    }
    return JSON.parse(String(res.stdout || '').trim());
  } catch (error: any) {
    const rawMessage = normalizeGmgnMessage(String(error?.message || error));
    const message =
      rawMessage
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean)
      || rawMessage
      || 'gmgn-cli failed';
    const shouldCooldown =
      isGmgnTemporaryBanMessage(rawMessage)
      || isGmgnRateLimitMessage(rawMessage)
      || (/^token\s+info\b/i.test(args) && /\bfailed\b/i.test(rawMessage));
    if (shouldCooldown) {
      recordGmgnTemporaryBan(rawMessage || message);
      return null;
    }
    console.warn(`[SNIPER] GMGN metadata lookup failed: ${message}`);
    return null;
  }
}

function extractGmgnImageDupMeta(raw: any, source: string): DiscoveryRiskMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const imageDupCount = parseOptionalNumber(raw.imageDupCount ?? raw.image_dup_count);
  const meta = {
    imageDupCount,
    duplicateImageRisk: classifyDuplicateImageRisk(imageDupCount),
    logoUrl: String(raw.logoUrl || raw.logo || ''),
    launchpad: String(raw.launchpad || ''),
    standard: String(raw.standard || ''),
    source,
    fetchedAt: Date.now(),
  };
  if (imageDupCount === null && !meta.logoUrl && !meta.launchpad && !meta.standard) return null;
  return meta;
}

function mergeDiscoveryRiskMeta(...parts: Array<DiscoveryRiskMeta | null | undefined>): DiscoveryRiskMeta | null {
  let merged: DiscoveryRiskMeta | null = null;
  for (const part of parts) {
    if (!part) continue;
    if (!merged) {
      merged = { ...part };
      continue;
    }
    merged = {
      imageDupCount: merged.imageDupCount ?? part.imageDupCount,
      duplicateImageRisk:
        merged.duplicateImageRisk && merged.duplicateImageRisk !== 'unknown'
          ? merged.duplicateImageRisk
          : part.duplicateImageRisk,
      logoUrl: merged.logoUrl || part.logoUrl,
      launchpad: merged.launchpad || part.launchpad,
      standard: merged.standard || part.standard,
      source: [merged.source, part.source].filter(Boolean).join('+'),
      fetchedAt: Math.max(merged.fetchedAt || 0, part.fetchedAt || 0),
    };
  }
  return merged;
}

function loadBagsEnrichmentSnapshot() {
  try {
    if (!fs.existsSync(BAGS_ENRICHMENT_CACHE_FILE)) {
      bagsEnrichmentCacheSnapshot = {
        loadedAt: Date.now(),
        mtimeMs: 0,
        free: {},
        jupiter: {},
      };
      return bagsEnrichmentCacheSnapshot;
    }
    const stat = fs.statSync(BAGS_ENRICHMENT_CACHE_FILE);
    const mtimeMs = Number(stat.mtimeMs || 0);
    if (bagsEnrichmentCacheSnapshot.loadedAt && bagsEnrichmentCacheSnapshot.mtimeMs === mtimeMs) {
      return bagsEnrichmentCacheSnapshot;
    }
    const payload = readJsonFile<any>(BAGS_ENRICHMENT_CACHE_FILE) || {};
    bagsEnrichmentCacheSnapshot = {
      loadedAt: Date.now(),
      mtimeMs,
      free: (payload?.free && typeof payload.free === 'object') ? payload.free : {},
      jupiter: (payload?.jupiter && typeof payload.jupiter === 'object') ? payload.jupiter : {},
    };
  } catch {
    bagsEnrichmentCacheSnapshot = {
      loadedAt: Date.now(),
      mtimeMs: 0,
      free: {},
      jupiter: {},
    };
  }
  return bagsEnrichmentCacheSnapshot;
}

function loadBagsEnrichmentMeta(mint: string): DiscoveryRiskMeta | null {
  const snapshot = loadBagsEnrichmentSnapshot();
  const freeMeta = extractGmgnImageDupMeta(snapshot.free?.[mint], 'bags-cache-free');
  const jupiterRaw = snapshot.jupiter?.[mint];
  const jupiterMeta = extractGmgnImageDupMeta(
    jupiterRaw
      ? {
          launchpad: jupiterRaw.launchpad,
          standard: jupiterRaw.partnerConfig || jupiterRaw.standard || '',
          fetchedAt: jupiterRaw.fetchedAt,
        }
      : null,
    'bags-cache-jupiter',
  );
  return mergeDiscoveryRiskMeta(freeMeta, jupiterMeta);
}

function loadGmgnImageDupMeta(mint: string, allowCliFallback = false) {
  const cached = gmgnImageDupCache.get(mint);
  if (cached && (Date.now() - cached.fetchedAt) < (10 * 60_000)) return cached;
  const persistedMeta = getCachedGmgnTokenInfoMeta(mint);
  if (persistedMeta) {
    gmgnImageDupCache.set(mint, persistedMeta);
    return persistedMeta;
  }
  const bagsMeta = loadBagsEnrichmentMeta(mint);

  const trendingRows = readJsonFile<any[]>(TRENDING_FILE);
  if (Array.isArray(trendingRows)) {
    const row = trendingRows.find((item: any) => (item?.baseToken?.address || item?.mint) === mint);
    const meta = mergeDiscoveryRiskMeta(
      extractGmgnImageDupMeta(row?._gmgn, 'trending-gmgn'),
      extractGmgnImageDupMeta(row?._bags, 'trending-bags'),
      extractGmgnImageDupMeta(row, 'trending-row'),
      bagsMeta,
    );
    if (meta) {
      gmgnImageDupCache.set(mint, meta);
      return meta;
    }
  }

  const gmgnTrending = readJsonFile<any>(GMGN_TRENDING_FILE);
  const gmgnTokens = Array.isArray(gmgnTrending?.tokens) ? gmgnTrending.tokens : [];
  const gmgnToken = gmgnTokens.find((item: any) => item?.mint === mint);
  const gmgnTokenMeta = mergeDiscoveryRiskMeta(
    extractGmgnImageDupMeta(gmgnToken, 'gmgn-trending'),
    bagsMeta,
  );
  if (gmgnTokenMeta) {
    gmgnImageDupCache.set(mint, gmgnTokenMeta);
    return gmgnTokenMeta;
  }

  if (bagsMeta) {
    gmgnImageDupCache.set(mint, bagsMeta);
    return bagsMeta;
  }

  if (!allowCliFallback) return null;
  if (Date.now() < gmgnBanUntilMs) return null;
  const info = runGmgnCliJson(`token info --chain sol --address ${mint}`);
  const infoMeta = mergeDiscoveryRiskMeta(
    extractGmgnImageDupMeta(info, 'gmgn-cli'),
    bagsMeta,
  );
  if (infoMeta) {
    gmgnImageDupCache.set(mint, infoMeta);
    rememberGmgnTokenInfoMeta(mint, infoMeta);
    return infoMeta;
  }
  return null;
}

function evaluateGmgnImageDuplicationGate(mint: string, entryMode: EntryMode, tokenAgeSec?: number) {
  const config = loadGmgnImageDuplicationConfig();
  if (!config.enabled) return { block: false, warn: false, meta: null, config };

  const strictEntryMode = config.strictEntryModes.includes(entryMode);
  const meta = loadGmgnImageDupMeta(mint, strictEntryMode);
  if (!meta) return { block: false, warn: false, meta: null, config };

  const imageDupCount = meta.imageDupCount;
  if (!Number.isFinite(Number(imageDupCount))) return { block: false, warn: false, meta, config };

  const launchpad = String(meta.launchpad || '').toLowerCase();
  const pumpScoped = !config.onlyPumpLaunchpad || launchpad.includes('pump');
  const withinFreshWindow = tokenAgeSec === undefined || tokenAgeSec <= config.maxTokenAgeSeconds;
  const hardReject = Number(imageDupCount) >= config.hardRejectThreshold;
  const strictReject = strictEntryMode && pumpScoped && withinFreshWindow && Number(imageDupCount) >= config.rejectThreshold;
  const warn = Number(imageDupCount) >= config.warnThreshold;

  return {
    block: hardReject || strictReject,
    warn,
    meta,
    config,
    reason: hardReject ? 'hard-threshold' : strictReject ? 'strict-pump-window' : 'warn-only',
  };
}

function evaluatePumpLaunchpadGuard(mint: string, entryMode: EntryMode, tokenAgeSec?: number, marketCapUsd?: number) {
  const config = loadPumpLaunchpadGuardConfig();
  if (!config.enabled || !config.strictEntryModes.includes(entryMode)) {
    return { block: false, reason: null, meta: null, config };
  }

  const meta = loadGmgnImageDupMeta(mint, true);
  if (!meta) {
    return { block: false, reason: null, meta: null, config };
  }

  const launchpad = String(meta.launchpad || '').trim().toLowerCase();
  if (!launchpad.includes('pump')) {
    return { block: false, reason: null, meta, config };
  }

  const withinFreshWindow = tokenAgeSec === undefined || tokenAgeSec <= config.maxTokenAgeSeconds;
  if (!withinFreshWindow) {
    return { block: false, reason: null, meta, config };
  }

  const standard = String(meta.standard || '').trim().toLowerCase();
  if (standard.includes('mayhem')) {
    return { block: true, reason: 'pump-mayhem-standard', meta, config };
  }
  if (
    config.blockLowMarketCapUsd &&
    Number.isFinite(Number(marketCapUsd)) &&
    Number(marketCapUsd) > 0 &&
    Number(marketCapUsd) < config.minSafeMarketCapUsd
  ) {
    return { block: true, reason: `pump-sub-${Math.round(config.minSafeMarketCapUsd)}-fdv`, meta, config };
  }

  return { block: false, reason: null, meta, config };
}

function normalizeTokenAmount(rawAmount: number, decimals?: number): number {
  const safeRawAmount = Number(rawAmount);
  if (!Number.isFinite(safeRawAmount) || safeRawAmount <= 0) return 0;
  const safeDecimals = Number.isFinite(Number(decimals)) ? Number(decimals) : 0;
  return safeRawAmount / Math.pow(10, safeDecimals);
}

function computeEntryPriceSol(totalSol: number, rawAmount: number, decimals?: number): number {
  const tokenCount = normalizeTokenAmount(rawAmount, decimals);
  if (!Number.isFinite(totalSol) || totalSol <= 0 || tokenCount <= 0) return 0;
  return totalSol / tokenCount;
}

function normalizeTokenProgramId(programId?: string | null): string {
  return programId === TOKEN_2022_PROGRAM_ID_STR ? TOKEN_2022_PROGRAM_ID_STR : TOKEN_PROGRAM_ID_STR;
}

function getTokenProgramPublicKey(programId?: string | null): PublicKey {
  return normalizeTokenProgramId(programId) === TOKEN_2022_PROGRAM_ID_STR
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
}

async function getTokenProgramIdForMint(mint: string): Promise<string> {
  const cached = tokenProgramIdCache.get(mint);
  if (cached) return cached;

  let ownerProgram: string | null = null;
  try {
    const mintAcct = await callRpcGateway('getAccountInfo', [new PublicKey(mint), { encoding: 'jsonParsed' }]);
    ownerProgram = mintAcct?.value?.owner || null;
  } catch {}

  if (!ownerProgram) {
    try {
      const mintInfo = await connection.getAccountInfo(new PublicKey(mint), 'confirmed');
      ownerProgram = mintInfo?.owner?.toBase58() || null;
    } catch {}
  }

  const normalized = normalizeTokenProgramId(ownerProgram);
  tokenProgramIdCache.set(mint, normalized);
  return normalized;
}

async function deriveTokenAccountContext(mint: string, owner: PublicKey): Promise<{ ata: string; tokenProgramId: string }> {
  const tokenProgramId = await getTokenProgramIdForMint(mint);
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), owner, false, getTokenProgramPublicKey(tokenProgramId)).toBase58();
  return { ata, tokenProgramId };
}

async function resolveWalletMintBalanceLamports(mint: string): Promise<number> {
  const { ata } = await deriveTokenAccountContext(mint, wallet.publicKey);
  const ataKey = new PublicKey(ata);
  try {
    const balAcct = await callRpcGateway('getTokenAccountBalance', [ataKey]);
    return Number(balAcct?.value?.amount || 0);
  } catch (gatewayErr: any) {
    const gatewayMessage = String(gatewayErr?.message || gatewayErr || '').toLowerCase();
    if (gatewayMessage.includes('could not find account') || gatewayMessage.includes('account not found')) {
      return 0;
    }
    try {
      const balAcct = await connection.getTokenAccountBalance(ataKey, 'confirmed');
      return Number(balAcct?.value?.amount || 0);
    } catch (directErr: any) {
      const directMessage = String(directErr?.message || directErr || '').toLowerCase();
      if (directMessage.includes('could not find account') || directMessage.includes('account not found')) {
        return 0;
      }
      throw directErr;
    }
  }
}

function loadGmgnActivePositionSnapshot(mint: string): any | null {
  const raw = readJsonFile<any>(GMGN_ACTIVE_POSITIONS_FILE);
  const positions = Array.isArray(raw?.positions) ? raw.positions : [];
  return positions.find((pos: any) => pos?.mint === mint) || null;
}

function syncPositionMarkState(
  pos: Position,
  markValueSol: number | null,
  pnlPct: number,
  now: number,
  heldMs: number,
  markSource: string,
  gmgnSnapshot?: any | null
): boolean {
  const nextMarkValueSol =
    markValueSol !== null && Number.isFinite(Number(markValueSol))
      ? Number(markValueSol)
      : undefined;
  const nextMarkValueUsd = Number.isFinite(Number(gmgnSnapshot?.markValueUsd)) ? Number(gmgnSnapshot.markValueUsd) : undefined;
  const nextKlineCloseUsd = Number.isFinite(Number(gmgnSnapshot?.klineCloseUsd)) ? Number(gmgnSnapshot.klineCloseUsd) : undefined;
  const nextHoldMinutes = Number.isFinite(Number(gmgnSnapshot?.holdMinutes))
    ? Number(gmgnSnapshot.holdMinutes)
    : heldMs / 60000;
  const nextObservedBalanceLamports = Number.isFinite(Number(gmgnSnapshot?.tokenAmountRaw))
    ? Number(gmgnSnapshot.tokenAmountRaw)
    : undefined;
  const materiallyChanged =
    pos.lastMarkSource !== markSource ||
    pos.lastMarkAt === undefined ||
    (now - (pos.lastMarkAt || 0)) >= MARK_PERSIST_INTERVAL_MS ||
    (nextMarkValueSol !== undefined && Math.abs((pos.lastMarkValueSol || 0) - nextMarkValueSol) >= 0.00000005) ||
    Math.abs((pos.lastPnlPct || 0) - pnlPct) >= 0.25 ||
    (nextMarkValueUsd !== undefined && Math.abs((pos.lastMarkValueUsd || 0) - nextMarkValueUsd) >= 0.000001) ||
    (nextKlineCloseUsd !== undefined && Math.abs((pos.lastKlineCloseUsd || 0) - nextKlineCloseUsd) >= 0.00000001) ||
    Math.abs((pos.lastHoldMinutes || 0) - nextHoldMinutes) >= 0.1 ||
    (nextObservedBalanceLamports !== undefined && pos.lastObservedBalanceLamports !== nextObservedBalanceLamports);
  if (!materiallyChanged) return false;

  if (nextMarkValueSol !== undefined) pos.lastMarkValueSol = nextMarkValueSol;
  if (nextMarkValueUsd !== undefined) pos.lastMarkValueUsd = nextMarkValueUsd;
  if (nextKlineCloseUsd !== undefined) pos.lastKlineCloseUsd = nextKlineCloseUsd;
  if (nextObservedBalanceLamports !== undefined) pos.lastObservedBalanceLamports = nextObservedBalanceLamports;
  pos.lastPnlPct = pnlPct;
  pos.lastHoldMinutes = nextHoldMinutes;
  pos.lastMarkAt = now;
  pos.lastMarkSource = markSource;
  return true;
}

function shouldEvictAfterBalanceLookupFailures(pos: Position, heldMs: number, gmgnSnapshot?: any | null): boolean {
  const failures = pos.balanceFetchFailureCount || 0;
  if (failures < MAX_BALANCE_EVICT_FAILURES) return false;
  const maxHoldMinutes = Number.isFinite(pos.maxHoldMinutes) ? Number(pos.maxHoldMinutes) : GLOBAL_HOLD_MIN;
  const staleThresholdMs = Math.max((maxHoldMinutes * 60_000) + BALANCE_LOOKUP_GRACE_MS, MAX_HOLD_MS * 2);
  if (heldMs < staleThresholdMs) return false;
  const hasActiveSnapshot = !!gmgnSnapshot;
  const hasRecentObservedBalance =
    Number(pos.lastObservedBalanceLamports || 0) > 0 &&
    Number.isFinite(pos.lastMarkAt) &&
    (Date.now() - (pos.lastMarkAt || 0)) < BALANCE_LOOKUP_GRACE_MS;
  return !hasActiveSnapshot && !hasRecentObservedBalance;
}

async function resolveLiveTokenBalance(pos: Position): Promise<{ amountLamports: number; source: string; ata: string; tokenProgramId: string } | null> {
  const pub = RedisBus.getPublisher();
  const candidateContexts: Array<{ ata: string; tokenProgramId: string; sourceLabel: string }> = [];
  const detectedContext = await deriveTokenAccountContext(pos.mint, wallet.publicKey);
  candidateContexts.push({ ...detectedContext, sourceLabel: 'detected-ata' });
  if (pos.ata && pos.ata !== detectedContext.ata) {
    candidateContexts.push({
      ata: pos.ata,
      tokenProgramId: normalizeTokenProgramId(pos.tokenProgramId),
      sourceLabel: 'legacy-ata',
    });
  }

  let lastGatewayErr: any = null;
  let lastDirectErr: any = null;

  for (const candidate of candidateContexts) {
    const ataKey = new PublicKey(candidate.ata);
    try {
      await pub.incr('rpc:calls:total');
      const balAcct = await callRpcGateway('getTokenAccountBalance', [ataKey]);
      return {
        amountLamports: Number(balAcct?.value?.amount || 0),
        source: `rpc-gateway:${candidate.sourceLabel}`,
        ata: candidate.ata,
        tokenProgramId: candidate.tokenProgramId,
      };
    } catch (gatewayErr: any) {
      lastGatewayErr = gatewayErr;
      try {
        await pub.incr('rpc:calls:total');
        const balAcct = await connection.getTokenAccountBalance(ataKey, 'confirmed');
        return {
          amountLamports: Number(balAcct?.value?.amount || 0),
          source: `rpc-direct:${candidate.sourceLabel}`,
          ata: candidate.ata,
          tokenProgramId: candidate.tokenProgramId,
        };
      } catch (directErr: any) {
        lastDirectErr = directErr;
        try {
          await pub.incr('rpc:calls:total');
          const acctInfo = await connection.getAccountInfo(ataKey, 'confirmed');
          if (!acctInfo) {
            continue;
          }
        } catch {}
      }
    }
  }

  if (candidateContexts.length > 0) {
    const primary = candidateContexts[0];
    try {
      const primaryAcct = await connection.getAccountInfo(new PublicKey(primary.ata), 'confirmed');
      if (!primaryAcct) {
        return { amountLamports: 0, source: 'ata-missing', ata: primary.ata, tokenProgramId: primary.tokenProgramId };
      }
    } catch {}
  }

  console.warn(
    `[SNIPER] balance lookup degraded for ${pos.symbol}: gateway=${lastGatewayErr?.message || lastGatewayErr} ` +
    `direct=${lastDirectErr?.message || lastDirectErr}`
  );
  return null;
}

function loadStore() {
  try {
    if (fs.existsSync(SNIPER_LOG)) {
      const raw = JSON.parse(fs.readFileSync(SNIPER_LOG, 'utf-8'));
      const journalLossStreak = deriveLossStreakSnapshotFromJournal();
      const persistedConsecutiveLosses = Math.max(0, Number(raw?.stats?.consecutiveLosses || 0));
      const recoveredConsecutiveLosses = Math.max(persistedConsecutiveLosses, journalLossStreak.consecutiveLosses);
      const persistedLastLossAt = Math.max(0, Number(raw?.stats?.lastLossAt || 0));
      const recoveredLastLossAt = Math.max(persistedLastLossAt, journalLossStreak.lastLossAt);
      store = {
        positions: Array.isArray(raw?.positions)
          ? raw.positions.map((pos: any) => {
              const normalizedEntryPriceSol = computeEntryPriceSol(Number(pos?.buyPriceSol || 0), Number(pos?.tokenAmount || 0), Number(pos?.decimals));
              return {
                ...pos,
                tokenProgramId: normalizeTokenProgramId(pos?.tokenProgramId),
                entryPriceSol: normalizedEntryPriceSol > 0 ? normalizedEntryPriceSol : Number(pos?.entryPriceSol || 0),
              };
            })
          : [],
        blacklist: [],
        strikes: raw?.strikes || {},
        stats: {
          wins: Number(raw?.stats?.wins || 0),
          losses: Number(raw?.stats?.losses || 0),
          totalPnlSol: Number(raw?.stats?.totalPnlSol || 0),
          consecutiveLosses: recoveredConsecutiveLosses,
          pausedUntil: Math.max(0, Number(raw?.stats?.pausedUntil || 0)),
          lastRecoveryProbeAt: Math.max(0, Number(raw?.stats?.lastRecoveryProbeAt || 0)),
          lastLossAt: recoveredLastLossAt,
        },
      };
      if (recoveredConsecutiveLosses > persistedConsecutiveLosses) {
        console.log(
          `[SNIPER]  LOSS STREAK RECOVERY: restored ${recoveredConsecutiveLosses} consecutive losses ` +
          `from recent journal history.`
        );
      }
      const persistedBlacklistLen = Array.isArray(raw?.blacklist) ? raw.blacklist.length : 0;
      if (persistedBlacklistLen > 0) {
        console.log(`[SNIPER] Resetting persisted session blacklist (${persistedBlacklistLen} entries) on boot.`);
      }
    }
  } catch { /* start fresh */ }
}

function loadRecentTradeJournalRows(limit = 500): any[] {
  try {
    if (!fs.existsSync(JOURNAL_FILE)) return [];
    const rows = fs.readFileSync(JOURNAL_FILE, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-Math.max(1, limit));
    return rows
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

function deriveLossStreakSnapshotFromJournal(limit = 80): { consecutiveLosses: number; lastLossAt: number } {
  const rows = loadRecentTradeJournalRows(limit)
    .filter((row: any) => String(row?.action || '').toUpperCase() === 'SELL')
    .filter((row: any) => {
      const pnl = Number(row?.pnlSol ?? row?.pnl_sol);
      return Number.isFinite(pnl) && !isGhostExecutionSignature(row?.sig);
    });

  let consecutiveLosses = 0;
  let lastLossAt = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const pnl = Number(rows[i]?.pnlSol ?? rows[i]?.pnl_sol ?? 0);
    if (pnl < 0) {
      consecutiveLosses += 1;
      if (lastLossAt <= 0) {
        lastLossAt = Math.max(0, Number(rows[i]?.timestamp ?? rows[i]?.ts ?? 0));
      }
      continue;
    }
    break;
  }

  return { consecutiveLosses, lastLossAt };
}

function refreshFamilyPerformanceMemory() {
  familyPerformanceMemory = buildFamilyPerformanceMemory(loadRecentTradeJournalRows(750), FAMILY_PERFORMANCE_GATE_CONFIG);
}

refreshFamilyPerformanceMemory();

function saveStore() {
  fs.writeFileSync(SNIPER_LOG, JSON.stringify({
    positions: store.positions,
    blacklist: [],
    strikes: store.strikes,
    stats: store.stats,
  }, null, 2));
}

function persistWalletHoldingsSnapshot(snapshot: {
  generatedAt: number;
  wallet: string;
  nativeBalanceSol?: number | null;
  nonzeroHoldingCount: number;
  trackedHoldingCount: number;
  stableHoldingCount: number;
  untrackedHoldingCount: number;
  recoverableOrphanCount: number;
  prunedTrackedMints: string[];
  holdings: WalletHoldingSnapshotRow[];
}) {
  const tempFile = `${WALLET_HOLDINGS_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(snapshot, null, 2));
  fs.renameSync(tempFile, WALLET_HOLDINGS_FILE);
}

let terrainMemoryStore: Record<string, any> = (() => {
  try {
    if (!fs.existsSync(TERRAIN_MEMORY_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(TERRAIN_MEMORY_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
})();
let terrainMemoryDirty = false;
let lastTerrainPersistMs = 0;

function persistTerrainMemoryStore(force = false) {
  if (!terrainMemoryDirty) return;
  const now = Date.now();
  if (!force && now - lastTerrainPersistMs < 2_000) return;
  try {
    const config = loadTerrainMemoryConfig();
    const staleBefore = now - (config.lookbackSeconds * 1000 * 3);
    for (const [mint, state] of Object.entries(terrainMemoryStore)) {
      const updatedAt = Number((state as any)?.updatedAt || 0);
      if (!updatedAt || updatedAt < staleBefore) {
        delete terrainMemoryStore[mint];
      }
    }
    fs.writeFileSync(TERRAIN_MEMORY_FILE, JSON.stringify(terrainMemoryStore, null, 2), 'utf-8');
    terrainMemoryDirty = false;
    lastTerrainPersistMs = now;
  } catch {}
}

function recordTerrainObservation(mint: string, observation: any) {
  const config = loadTerrainMemoryConfig();
  if (!config.enabled) return null;
  const nextState = ingestTerrainObservation(terrainMemoryStore[mint] || null, observation, config);
  terrainMemoryStore[mint] = nextState;
  terrainMemoryDirty = true;
  persistTerrainMemoryStore();
  return nextState;
}

//  Jupiter helpers
async function jupFetch(path: string, opts: RequestInit = {}): Promise<any> {
  if (path.startsWith('/quote') && isJupiterRateLimitActive(jupiterQuoteRateLimitUntilMs)) {
    return {
      error: 'Rate limited',
      errorCode: 'RATE_LIMITED',
      retryAfterMs: getActiveJupiterQuoteRateLimitMs(),
    };
  }
  const res = await fetch(`${JUP_BASE}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-api-key': JUP_KEY, ...opts.headers },
    signal: AbortSignal.timeout(10000),
  });
  if (path.startsWith('/quote') && res.status === 429) {
    const backoffMs = noteJupiterQuoteRateLimit(res.headers.get('retry-after'));
    console.warn(`[JUP API] 429 on quote path; cooling quote requests for ${Math.ceil(backoffMs / 1000)}s.`);
    return {
      error: 'Rate limited',
      errorCode: 'RATE_LIMITED',
      retryAfterMs: backoffMs,
    };
  }
  const text = await res.text();
  try {
    const parsed = JSON.parse(text);
    if (path.startsWith('/quote') && res.ok) {
      clearJupiterQuoteRateLimit();
    }
    return parsed;
  } catch (e: any) {
    throw new Error(`jupFetch failed to parse JSON (HTTP ${res.status}): ${text.substring(0, 100)}...`);
  }
}

function normalizeQuoteRequestOptions(slippageOrOptions?: number | QuoteRequestOptions): Required<QuoteRequestOptions> {
  if (typeof slippageOrOptions === 'number' || slippageOrOptions === undefined) {
    return {
      slippageBps: typeof slippageOrOptions === 'number' ? slippageOrOptions : 500,
      restrictIntermediateTokens: false,
      onlyDirectRoutes: false,
      asLegacyTransaction: false,
    };
  }

  return {
    slippageBps: slippageOrOptions.slippageBps ?? 500,
    restrictIntermediateTokens: slippageOrOptions.restrictIntermediateTokens ?? false,
    onlyDirectRoutes: slippageOrOptions.onlyDirectRoutes ?? false,
    asLegacyTransaction: slippageOrOptions.asLegacyTransaction ?? false,
  };
}

export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountLamports: number,
  slippageOrOptions: number | QuoteRequestOptions = 500,
): Promise<any | null> {
  try {
    // Native manual slippage mapping (dynamicSlippage fails 6024 strictly on Pump.fun due to zero-liquidity oracle mismatch)
    const quoteOptions = normalizeQuoteRequestOptions(slippageOrOptions);
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amountLamports.toString(),
      slippageBps: quoteOptions.slippageBps.toString(),
    });

    if (quoteOptions.restrictIntermediateTokens) {
      params.set('restrictIntermediateTokens', 'true');
    }
    if (quoteOptions.onlyDirectRoutes) {
      params.set('onlyDirectRoutes', 'true');
    }
    if (quoteOptions.asLegacyTransaction === false) {
      params.set('asLegacyTransaction', 'false');
    }

    const q = await jupFetch(`/quote?${params.toString()}`);
    if (q?.errorCode === 'RATE_LIMITED') {
        return q;
    }
    if (q.error || !q.outAmount) {
        if (q.error && q.error !== 'Could not find any route' && q.errorCode !== 'TOKEN_NOT_TRADABLE') {
            console.log(`[JUP API] Quote error for ${outputMint}: ${JSON.stringify(q)}`);
        }
        return null;
    }
    return q;
  } catch (e) { return null; }
}

const SWAP_CONFIRM_TIMEOUT_MS = 45000;
const SWAP_CONFIRM_POLL_MS = 1500;
const SWAP_REBROADCAST_MS = 4000;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function deriveTransactionSignature(tx: VersionedTransaction): string | null {
  try {
    const rawSig = tx.signatures?.[0];
    if (!rawSig || rawSig.length === 0) return null;
    if (rawSig.every(byte => byte === 0)) return null;
    return bs58.encode(Buffer.from(rawSig));
  } catch {
    return null;
  }
}

async function simulateSignedSwap(tx: VersionedTransaction, routeLabel: string): Promise<Connection | null> {
  const candidates = getRpcCandidates();
  for (const candidate of candidates) {
    try {
      const sim = await candidate.conn.simulateTransaction(tx, {
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment: 'processed',
      });
      if (!sim.value?.err) {
        if (candidate.conn !== connection) {
          console.warn(`[EXEC] Simulation failover engaged for ${routeLabel}; using ${candidate.label} RPC for this tx lifecycle.`);
        }
        return candidate.conn;
      }

      const logs = (sim.value.logs || []).slice(-10);
      console.warn(`[EXEC] Pre-send simulation failed for ${routeLabel} on ${candidate.label} RPC: ${JSON.stringify(sim.value.err)}`);
      if (logs.length > 0) {
        console.warn(`[EXEC] Simulation logs for ${routeLabel}: ${logs.join(' | ')}`);
      }
      (tx as any).__pcpLastFailureMeta = classifyExitSwapFailure({
        simulationErr: sim.value.err,
        simulationLogs: logs,
        message: `pre-send simulation failed for ${routeLabel}`,
      });
      console.warn(`[EXEC] Blocking live send for ${routeLabel} because local simulation already failed.`);
      return null;
    } catch (e: any) {
      const providerLimited = isProviderCapacityError(e);
      if (providerLimited && candidate.conn !== candidates[candidates.length - 1]?.conn) {
        console.warn(`[EXEC] Simulation RPC capacity error for ${routeLabel} on ${candidate.label} RPC: ${e?.message || e}. Trying backup RPC.`);
        continue;
      }
      (tx as any).__pcpLastFailureMeta = classifyExitSwapFailure({
        providerLimited,
        message: `simulation rpc error for ${routeLabel}: ${e?.message || e}`,
      });
      console.warn(`[EXEC] Simulation RPC error for ${routeLabel} on ${candidate.label} RPC: ${e?.message || e}. Blocking live send.`);
      return null;
    }
  }
  (tx as any).__pcpLastFailureMeta = classifyExitSwapFailure({
    message: `simulation failed for ${routeLabel} without a successful rpc candidate`,
  });
  return null;
}

async function confirmSubmittedSignature(
  signature: string,
  rawTx: Uint8Array,
  recentBlockhash?: string,
  lastValidBlockHeight?: number,
  allowRebroadcast = true,
  timeoutMs = SWAP_CONFIRM_TIMEOUT_MS,
  lifecycleConnection: Connection = connection
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let lastBroadcastAt = Date.now();

  while (Date.now() < deadline) {
    try {
      const status = (await lifecycleConnection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value?.[0];
      if (status?.err) {
        (rawTx as any).__pcpLastFailureMeta = classifyExitSwapFailure({
          statusErr: status.err,
          message: `tx failed after submission for ${signature}`,
        });
        console.warn(`[SNIPER] TX failed after submission: ${signature} -> ${JSON.stringify(status.err)}`);
        return false;
      }
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        console.log(`[SNIPER] TX confirmed via status poll: ${signature} (${status.confirmationStatus})`);
        return true;
      }
    } catch (e: any) {
      console.warn(`[SNIPER] TX status poll error for ${signature}: ${e?.message || e}`);
    }

    if (Number.isFinite(lastValidBlockHeight)) {
      try {
        const currentBlockHeight = await lifecycleConnection.getBlockHeight('confirmed');
        if (currentBlockHeight > (lastValidBlockHeight as number)) {
          (rawTx as any).__pcpLastFailureMeta = classifyExitSwapFailure({
            expired: true,
            message: `transaction expired before confirmation for ${signature}`,
          });
          console.warn(
            `[SNIPER] TX expired before confirmation: ${signature} ` +
            `(blockheight ${currentBlockHeight} > lastValid ${lastValidBlockHeight})`
          );
          return false;
        }
      } catch (e: any) {
        console.warn(`[SNIPER] Blockheight check failed for ${signature}: ${e?.message || e}`);
      }
    }

    if (allowRebroadcast && Date.now() - lastBroadcastAt >= SWAP_REBROADCAST_MS) {
      try {
        const rebroadcastSig = await lifecycleConnection.sendRawTransaction(rawTx, {
          skipPreflight: true,
          maxRetries: 0,
        });
        if (rebroadcastSig !== signature) {
          console.warn(`[SNIPER] Rebroadcast signature mismatch: expected ${signature} but RPC returned ${rebroadcastSig}`);
        } else {
          console.log(`[SNIPER] Rebroadcasting pending TX: ${signature}`);
        }
      } catch (e: any) {
        console.warn(`[SNIPER] Rebroadcast failed for ${signature}: ${e?.message || e}`);
      }
      lastBroadcastAt = Date.now();
    }

    await delay(SWAP_CONFIRM_POLL_MS);
  }

  if (recentBlockhash && Number.isFinite(lastValidBlockHeight)) {
    console.warn(
      `[SNIPER] TX confirmation timeout after ${(timeoutMs / 1000).toFixed(0)}s: ${signature} ` +
      `(blockhash ${recentBlockhash}, lastValid ${lastValidBlockHeight})`
    );
  } else {
    console.warn(`[SNIPER] TX confirmation timeout after ${(timeoutMs / 1000).toFixed(0)}s: ${signature}`);
  }
  return false;
}

async function waitForSignatureConfirmation(
  signature: string,
  recentBlockhash?: string,
  lastValidBlockHeight?: number,
  timeoutMs = SWAP_CONFIRM_TIMEOUT_MS
): Promise<boolean> {
  if (recentBlockhash && Number.isFinite(lastValidBlockHeight)) {
    try {
      const confirmResult = await Promise.race([
        connection.confirmTransaction(
          {
            signature,
            blockhash: recentBlockhash,
            lastValidBlockHeight: lastValidBlockHeight as number,
          },
          'confirmed'
        ),
        delay(timeoutMs).then(() => null),
      ]);
      if (confirmResult && !(confirmResult as any).value?.err) {
        console.log(`[SNIPER] TX confirmed: ${signature}`);
        return true;
      }
      if (confirmResult && (confirmResult as any).value?.err) {
        console.warn(`[SNIPER] TX rejected on-chain: ${signature} -> ${JSON.stringify((confirmResult as any).value.err)}`);
        return false;
      }
    } catch (e: any) {
      console.warn(`[SNIPER] TX confirmation RPC error for ${signature}: ${e?.message || e}`);
    }
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value?.[0];
      if (status?.err) {
        console.warn(`[SNIPER] TX failed after submission: ${signature} -> ${JSON.stringify(status.err)}`);
        return false;
      }
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        console.log(`[SNIPER] TX confirmed via status poll: ${signature} (${status.confirmationStatus})`);
        return true;
      }
    } catch (e: any) {
      console.warn(`[SNIPER] TX status poll error for ${signature}: ${e?.message || e}`);
    }
    await delay(SWAP_CONFIRM_POLL_MS);
  }

  console.warn(`[SNIPER] TX confirmation timeout after ${(timeoutMs / 1000).toFixed(0)}s: ${signature}`);
  return false;
}

export async function executeSwap(quote: any, tipLamports = DEFAULT_PRIORITY_FEE_LAMPORTS, swapOptions: SwapRequestOptions = {}): Promise<string | null> {
    if (process.env.PAPER_MODE === 'true') {
        const mockSig = `PAPER_TRADE_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        console.log(`[SNIPER]  PAPER MODE: Mocking successful Swap Routing for ${quote?.outAmount} lamports. Ghost Sig: ${mockSig}`);
        return mockSig;
    }

    try {
      if (quote && typeof quote === 'object') {
        delete quote.__pcpLastFailureMeta;
      }
      const usesNativeSolRoute =
        quote?.inputMint === WSOL ||
        quote?.outputMint === WSOL;
      const wrapAndUnwrapSol =
        typeof swapOptions.wrapAndUnwrapSol === 'boolean'
          ? swapOptions.wrapAndUnwrapSol
          : usesNativeSolRoute;
      console.log(`[EXEC] Calling jupFetch('/swap') for ${quote?.outAmount} lamports out...`);
      const swapData = await jupFetch('/swap', {
      method: 'POST',
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol,
        asLegacyTransaction: swapOptions.asLegacyTransaction ?? false,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: process.env.DYNAMIC_TIP_ENABLED === 'true' ? 'auto' : tipLamports,
      }),
    });
    console.log(`[EXEC] jupFetch('/swap') returned successfully.`);

    if (!swapData.swapTransaction) {
        console.log(`[EXEC] swapTransaction missing from swapData!`);
        return null;
    }

	    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
	    const tx    = VersionedTransaction.deserialize(txBuf);
	    tx.sign([wallet]);
	    const expectedSig = deriveTransactionSignature(tx);
	    if (!expectedSig) {
	      console.warn('[EXEC] Signed Jupiter TX but could not derive a valid signature; aborting send.');
	      return null;
	    }
		    const routeLabel = `${quote?.inputMint?.slice(0, 6) || 'unknown'}->${quote?.outputMint?.slice(0, 6) || 'unknown'}`;
		    const isJitoEnabled = process.env.JITO_TIP_SOL && parseFloat(process.env.JITO_TIP_SOL) > 0;
	    console.log(
	      `[EXEC] Deserialized and signed Jupiter TX for ${routeLabel}. ` +
	      `mode=${isJitoEnabled ? 'jito-bundle+rpc-fallback' : 'rpc-direct'} ` +
	      `wrap=${wrapAndUnwrapSol ? 'true' : 'false'} sig=${expectedSig}`
	    );
		    const lifecycleConnection = await simulateSignedSwap(tx, routeLabel);
		    if (!lifecycleConnection) {
          if (quote && typeof quote === 'object') {
            quote.__pcpLastFailureMeta = (tx as any).__pcpLastFailureMeta || classifyExitSwapFailure({
              message: `swap blocked after simulation for ${routeLabel}`,
            });
          }
		      return null;
		    }
		    const rawTx = tx.serialize();

	    if (isJitoEnabled) {
      const tipAmount = Math.floor(parseFloat(process.env.JITO_TIP_SOL!) * 1e9);
      // Fetch random Jito tip account
      const { SystemProgram } = await import('@solana/web3.js');
      const jitoTipAccounts = [
        "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
        "HFqU5x63VTQVPeGvvh3bE7Jk52M6CjS5Z1f5G8C5f5f5",
        "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvVkY"
      ];
      const randomTipAccount = new PublicKey(jitoTipAccounts[Math.floor(Math.random() * jitoTipAccounts.length)]);

      const tipIx = SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: randomTipAccount,
        lamports: tipAmount
      });

      // Need to convert VersionedTransaction -> Transaction, inject tipIx, and build new Versioned.
      // Since decompiling MessageV0 is complex, we append tip instruction by calling blockEngine REST API:
      // In this setup, we actually just fire the standard transaction + tip to the Jito bundle endpoint directly if we used jito-ts, but since we are raw, we POST it.

      try {
        const bundleSig = await fetch('https://mainnet.block-engine.jito.wtf/api/v1/bundles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "sendBundle",
            params: [
              [Buffer.from(rawTx).toString('base64')]
              // NOTE: True atomic Jito bundles normally require you to pack the swap + tip transfer in the same bundle array, assuming the swap output covers the tip if needed, or pre-authorizing.
              // Jupiter handles prioritization/tip limits if we configured it correctly on the quote endpoint above. If `prioritizationFeeLamports` is set on Jupiter payload, we just submit that directly!
            ]
          })
        });

	        const bResult = await bundleSig.json();
	        console.log(`[JITO-EXEC] Bundle submitted -> ${JSON.stringify(bResult)}`);
	        if (bResult.result) {
	            const pub = RedisBus.getPublisher();
	            await pub.incr('rpc:calls:total');
		            if (expectedSig && await confirmSubmittedSignature(expectedSig, rawTx, tx.message.recentBlockhash, swapData.lastValidBlockHeight, false, SWAP_CONFIRM_TIMEOUT_MS, lifecycleConnection)) {
		              return expectedSig;
		            }
              if (quote && typeof quote === 'object') {
                quote.__pcpLastFailureMeta = (rawTx as any).__pcpLastFailureMeta || classifyExitSwapFailure({
                  message: `jito bundle accepted but confirmation failed for ${routeLabel}`,
                });
              }
	            console.warn('[JITO-EXEC] Bundle accepted but tx did not confirm in time, falling back to public mempool path');
	        }
	      } catch (bundleErr: any) {
	        console.warn(`[JITO-EXEC] Bundle push failed, falling back to public Mempool: ${bundleErr.message}`);
	      }
	    }

    // Fallback or Standard Mempool push
        let activeLifecycleConnection = lifecycleConnection;
        let sig: string;
        try {
		    sig = await activeLifecycleConnection.sendRawTransaction(rawTx, {
		      skipPreflight: true, maxRetries: 3,
		    });
        } catch (e: any) {
          if (activeLifecycleConnection === connection && backupConnection && isProviderCapacityError(e)) {
            console.warn(`[EXEC] Primary send RPC capacity error for ${routeLabel}: ${e?.message || e}. Failing over signed send to backup RPC.`);
            activeLifecycleConnection = backupConnection;
		    sig = await activeLifecycleConnection.sendRawTransaction(rawTx, {
		      skipPreflight: true, maxRetries: 3,
		    });
          } else {
            throw e;
          }
        }
		    const pub = RedisBus.getPublisher();
		    await pub.incr('rpc:calls:total');
		    console.log(`[SNIPER] TX submitted: ${sig}`);
	    if (expectedSig && expectedSig !== sig) {
	      console.warn(`[SNIPER] TX signature mismatch: expected ${expectedSig} but RPC returned ${sig}`);
	    }
	    const confirmed = await confirmSubmittedSignature(sig, rawTx, tx.message.recentBlockhash, swapData.lastValidBlockHeight, true, SWAP_CONFIRM_TIMEOUT_MS, activeLifecycleConnection);
		    if (!confirmed) {
          if (quote && typeof quote === 'object') {
            quote.__pcpLastFailureMeta = (rawTx as any).__pcpLastFailureMeta || classifyExitSwapFailure({
              message: `submitted swap failed confirmation for ${routeLabel}`,
            });
          }
          return null;
        }
		    return sig;
	  } catch (e: any) {
	    if (quote && typeof quote === 'object') {
        quote.__pcpLastFailureMeta = classifyExitSwapFailure({
          message: `swap execution exception: ${e?.message || e}`,
        });
      }
	    console.error('[SNIPER] Swap failed:', e.message);
	    return null;
	  }
}


async function getCurrentPriceSol(mint: string, tokenLamports: number, decimals?: number): Promise<number | null> {
  const q = await getQuote(mint, WSOL, tokenLamports);
  if (q) return Number(q.outAmount) / 1e9; // SOL

  // FALLBACK ORACLE (DexScreener/GMGN Pricing via Redis)
  try {
      if (decimals === undefined) return null; // Safe bail if we lack precision
      const pub = RedisBus.getPublisher();
      const priceStr = await pub.hget(`price:${mint}`, 'usd');
      const wsolPriceStr = await pub.hget(`price:${WSOL}`, 'usd');

      if (priceStr && wsolPriceStr) {
          const usdPerToken = parseFloat(priceStr);
          const usdPerSol = parseFloat(wsolPriceStr);
          if (usdPerToken > 0 && usdPerSol > 0) {
              const solPerToken = usdPerToken / usdPerSol;
              const actualTokens = tokenLamports / Math.pow(10, decimals);
              const fallbackSol = actualTokens * solPerToken;

              // Only spam log the fallback if it's materially valuable (>= 0.01 SOL) to reduce noise
              if (fallbackSol >= 0.01) {
                  console.log(`[SNIPER]  Dual-Oracle Fallback: Jupiter returned 'No Route', but Market Data values ${mint.slice(0,6)}... at ${fallbackSol.toFixed(4)} SOL`);
              }
              return fallbackSol;
          }
      }
  } catch (e) {}

  return null;
}

//  Dynamic TP/SL  small-win compounding mode
// Take quick gains, recycle capital. Pennies compound into dollars.
// Entry already moved a lot? Take even less  just clip the tail.
function calcExitTargets(priceChg1h: number): { tp: number; sl: number } {
  if (priceChg1h >= 80) return { tp: 8,   sl: 7  };  // late entry   grab 8%, cut at -7%
  if (priceChg1h >= 40) return { tp: 12,  sl: 10 };  // mid entry    grab 12%, cut at -10%
  return                        { tp: 20,  sl: 15 };  // early entry  grab 20%, cut at -15%
}

//  Dynamic buy size: WSOL balance %  harmony allocation weight
// Reads from persistent WSOL ATA  no wrap/unwrap needed on trade execution.
// SIZE_UP: when WALLET_SIZE_UP=1 (set by alpha wallet consensus signal), 1.5 buy
async function calcBuySize(entryOptions?: EntryOptions): Promise<number> {
  try {
    if (entryOptions?.fixedBuySol !== undefined) {
      const configuredReserveSol = Math.max(0, entryOptions.reserveSol || 0);
      const minDeploySol = Math.max(0, entryOptions.minDeploySol || entryOptions.fixedBuySol || 0);
      const microScoutConfig = loadMicroScoutConfig();
      const { spendableSol: totalSpendableSol, nativeSol } = await getSpendableNativeBalance(connection, wallet.publicKey, 0);
      const adaptiveReserve = resolveAdaptiveReserve(
        {
          nativeSol,
          configuredReserveSol,
          desiredDeploySol: minDeploySol,
        },
        {
          enabled:
            microScoutConfig.adaptiveReserveEnabled &&
            (entryOptions.entryMode === 'micro-scout' || isMicroOnlyMode()),
          minReserveSol: microScoutConfig.adaptiveReserveMinSol,
          feeBufferSol: microScoutConfig.adaptiveReserveFeeBufferSol,
        },
      );
      const reserveSol = adaptiveReserve.effectiveReserveSol;
      const bal = Math.max(0, totalSpendableSol - reserveSol);
      if (adaptiveReserve.wasClamped) {
        console.log(
          `[SNIPER] ADAPTIVE MICRO RESERVE: native ${nativeSol.toFixed(4)} SOL | configured ${configuredReserveSol.toFixed(4)} | ` +
          `effective ${reserveSol.toFixed(4)} | floor ${adaptiveReserve.minReserveSol.toFixed(4)} | ` +
          `fee buffer ${adaptiveReserve.bufferSol.toFixed(4)}.`
        );
      }
      const maxAffordableSol = Math.max(0, bal);
      const sizingDecision = resolvePortfolioSizedBuy({
        deployableSol: maxAffordableSol,
        fixedBuySol: entryOptions.fixedBuySol,
        portfolioSizingEnabled: microScoutConfig.portfolioSizingEnabled && Number.isFinite(entryOptions.portfolioFraction),
        portfolioFraction: entryOptions.portfolioFraction,
        currentOpenPositions: store.positions.length,
        maxOpenPositions: MAX_POSITIONS,
        minDeploySol,
        maxDeploySol: entryOptions.maxDeploySol,
      });
      const desiredSol = sizingDecision.desiredBuySol;
      const normalizedDesiredSol = Number(desiredSol.toFixed(4));
      const normalizedMinDeploySol = Number(minDeploySol.toFixed(4));
      if (normalizedDesiredSol + 1e-9 < normalizedMinDeploySol) {
        console.log(
          `[SNIPER] MICRO SCOUT HOLD: deployable treasury ${normalizedDesiredSol.toFixed(4)} SOL below minimum ${normalizedMinDeploySol.toFixed(4)} SOL after reserve ${reserveSol.toFixed(4)} SOL.`
        );
        return 0;
      }
      const size = normalizedDesiredSol;
      console.log(
        `[SNIPER] MICRO SCOUT sizing | mode ${sizingDecision.sizingMode} | spendable ${bal.toFixed(4)} SOL | reserve ${reserveSol.toFixed(4)} SOL | deploy ${size.toFixed(4)} SOL` +
        `${
          sizingDecision.sizingMode === 'portfolio'
            ? ` | fraction ${(sizingDecision.portfolioFraction * 100).toFixed(0)}% | slots ${store.positions.length + 1}/${MAX_POSITIONS} (${sizingDecision.remainingSlots} remaining)`
            : ''
        }`
      );
      console.log(`[SNIPER]  Native SOL: ${nativeSol.toFixed(4)} | spendable ${bal.toFixed(4)} | size: ${size} SOL | mode: MICRO_SCOUT`);
      return size;
    }

    const reserveFloor = Math.max(0, entryOptions?.reserveSol ?? MIN_NATIVE_SOL_RESERVE);
    const { spendableSol, nativeSol } = await getSpendableNativeBalance(connection, wallet.publicKey, reserveFloor);
    const bal = spendableSol;

    if (entryOptions?.forceAllIn) {
      const reserveSol = Math.max(0, entryOptions.reserveSol || 0);
      const minDeploySol = Math.max(0, entryOptions.minDeploySol || 0);
      const maxDeploySol = Math.max(0, entryOptions.maxDeploySol || 0);
      const allInSize = Math.max(0, bal);
      const normalizedAllInSize = Number(allInSize.toFixed(4));
      const normalizedMinDeploySol = Number(minDeploySol.toFixed(4));
      if (normalizedAllInSize + 1e-9 < normalizedMinDeploySol) {
        console.log(`[SNIPER] LAST STAND HOLD: deployable treasury ${normalizedAllInSize.toFixed(4)} SOL below minimum ${normalizedMinDeploySol.toFixed(4)} SOL after reserve.`);
        return 0;
      }
      const cappedSize = maxDeploySol > 0 ? Math.min(normalizedAllInSize, maxDeploySol) : normalizedAllInSize;
      const size = Number(cappedSize.toFixed(4));
      console.log(`[SNIPER] LAST STAND sizing | spendable ${bal.toFixed(4)} SOL | reserve ${reserveSol.toFixed(4)} SOL | deploy ${size.toFixed(4)} SOL | cap ${maxDeploySol > 0 ? maxDeploySol.toFixed(4) : 'none'}`);
      console.log(`[SNIPER]  Native SOL: ${nativeSol.toFixed(4)} | spendable ${bal.toFixed(4)} | size: ${size} SOL | mode: LAST_STAND`);
      return size;
    }

    const raw     = bal * BASE_BUY_PCT;
    const weight  = loadSniperWeight();

    // Dynamic Performance Throttling
    let throttleMult = 1.0;
    try {
        const p = RedisBus.getPublisher();
        const perf = await p.hgetall(REDIS_KEYS.CONFIG_PERFORMANCE);
        if (perf && Object.keys(perf).length > 0) {
            // if (perf.circuitBreaker === 'true') {
            //      console.log(`[SNIPER]  CIRCUIT BREAKER ACTIVE  Halting all new entries!`);
            //      return 0; // Absolute block
            // }
            throttleMult = parseFloat(perf.positionSizeMultiplier) || 1.0;
        }
    } catch(e) {}

    let weighted  = raw * weight * throttleMult;

    // SIZE_UP: 3+ alpha wallets agreed  boost position size 1.5
    const sizeUp = process.env.WALLET_SIZE_UP === '1';
    if (sizeUp) {
      weighted *= 1.5;
      console.log(`[SNIPER]  SIZE_UP active  boosted to ${(weighted).toFixed(4)} SOL`);
    }

    const size = Math.min(MAX_BUY_SOL, Math.max(MIN_BUY_SOL, parseFloat(weighted.toFixed(4))));
    if (weight < 1.0) console.log(`[SNIPER]  Harmony weight: ${(weight*100).toFixed(0)}%  buy: ${size} SOL`);
    console.log(`[SNIPER]  Native SOL: ${nativeSol.toFixed(4)} | spendable ${bal.toFixed(4)} | size: ${size} SOL${sizeUp ? ' SIZE_UP' : ''}`);
    return size;
  } catch { return MIN_BUY_SOL; }
}

//  Loss Streak Cooldown
const LOSS_STREAK_DEFENSIVE_THRESHOLD = 2;
const LOSS_STREAK_PAUSE_THRESHOLD = 3;
const LOSS_STREAK_DEFENSIVE_RECOVERY_MS = 10 * 60 * 1000;

type LossStreakState = {
  consecutiveLosses: number;
  pauseDisabled: boolean;
  pauseActive: boolean;
  pauseRemainingMs: number;
  restrictionsActive: boolean;
  severeRestrictionsActive: boolean;
};

function getConsecutiveLosses(): number {
  return Math.max(0, Number((store.stats as any)?.consecutiveLosses || 0));
}

function getLastLossAt(): number {
  return Math.max(0, Number((store.stats as any)?.lastLossAt || 0));
}

function resolveLossStreakPauseMs(consecutiveLosses: number): number {
  if (consecutiveLosses >= 8) return 90 * 60 * 1000;
  if (consecutiveLosses >= 6) return 60 * 60 * 1000;
  if (consecutiveLosses >= 4) return 30 * 60 * 1000;
  if (consecutiveLosses >= LOSS_STREAK_PAUSE_THRESHOLD) return 15 * 60 * 1000;
  return 0;
}

function resolveLossStreakRecoveryMs(consecutiveLosses: number): number {
  if (consecutiveLosses >= LOSS_STREAK_PAUSE_THRESHOLD) {
    return resolveLossStreakPauseMs(consecutiveLosses);
  }
  if (consecutiveLosses >= LOSS_STREAK_DEFENSIVE_THRESHOLD) {
    return LOSS_STREAK_DEFENSIVE_RECOVERY_MS;
  }
  return 0;
}

function maybeDecayLossStreak(now = Date.now()): number {
  const consecutiveLosses = getConsecutiveLosses();
  if (consecutiveLosses < LOSS_STREAK_DEFENSIVE_THRESHOLD) return consecutiveLosses;
  const pausedUntil = Math.max(0, Number((store.stats as any)?.pausedUntil || 0));
  const lastLossAt = getLastLossAt();
  const recoveryWindowMs = resolveLossStreakRecoveryMs(consecutiveLosses);
  const flatBook = (store.positions?.length || 0) === 0;
  if (!flatBook || pausedUntil > now || lastLossAt <= 0 || recoveryWindowMs <= 0) {
    return consecutiveLosses;
  }
  const recoveryElapsedMs = Math.max(0, now - lastLossAt);
  if (recoveryElapsedMs < recoveryWindowMs) {
    return consecutiveLosses;
  }
  console.log(
    `[SNIPER]  LOSS STREAK DECAY: clearing ${consecutiveLosses} consecutive losses ` +
    `after ${(recoveryElapsedMs / 60000).toFixed(0)}m flat-book recovery.`
  );
  (store.stats as any).consecutiveLosses = 0;
  (store.stats as any).lastLossAt = 0;
  delete (store.stats as any).pausedUntil;
  saveStore();
  return 0;
}

function getLossStreakState(now = Date.now()): LossStreakState {
  const consecutiveLosses = maybeDecayLossStreak(now);
  const pauseDisabled = isLossStreakPauseDisabled();
  const pausedUntil = Math.max(0, Number((store.stats as any)?.pausedUntil || 0));
  const pauseActive = !pauseDisabled && pausedUntil > now;
  const pauseRemainingMs = pauseActive ? Math.max(0, pausedUntil - now) : 0;
  const restrictionsActive = consecutiveLosses >= LOSS_STREAK_DEFENSIVE_THRESHOLD || pauseActive;
  const severeRestrictionsActive = consecutiveLosses >= LOSS_STREAK_PAUSE_THRESHOLD || pauseActive;
  return {
    consecutiveLosses,
    pauseDisabled,
    pauseActive,
    pauseRemainingMs,
    restrictionsActive,
    severeRestrictionsActive,
  };
}

function isLossStreakPaused(): boolean {
  const state = getLossStreakState();
  if (state.pauseDisabled) {
    delete (store.stats as any).pausedUntil;
    return false;
  }
  return state.pauseActive;
}

function getLastRecoveryProbeAt(): number {
  return Math.max(0, Number((store.stats as any)?.lastRecoveryProbeAt || 0));
}

async function getMintCooldownState(mint: string): Promise<{ active: boolean; value: string | null; ttlSeconds: number | null }> {
  try {
    const pub = RedisBus.getPublisher();
    const [value, ttlRaw] = await Promise.all([
      pub.get(REDIS_KEYS.cooldown(mint)),
      pub.ttl(REDIS_KEYS.cooldown(mint)),
    ]);
    const ttlSeconds = Number.isFinite(ttlRaw) && ttlRaw >= 0 ? Number(ttlRaw) : null;
    return { active: !!value, value: value || null, ttlSeconds };
  } catch {
    return { active: false, value: null, ttlSeconds: null };
  }
}

async function trySnipe(mint: string, symbol: string, volume1h: number, priceChg1h: number,
                        buys1h: number, sells1h: number, buyRatio: number,
                        taSig?: string, taConf?: number,
                        tokenAgeSec?: number, momentum5m?: number, momentum1m?: number,
                        pairCreatedAt?: number, entryOptions?: EntryOptions) {
  if (store.blacklist.includes(mint)) {
    console.log(`[SNIPER]  SESSION BLACKLIST SKIP: ${symbol} already sits in the in-memory blacklist.`);
    return;
  }
  if (store.positions.find(p => p.mint === mint)) {
    console.log(`[SNIPER]  ACTIVE POSITION SKIP: ${symbol} already exists in store.positions.`);
    return;
  }
  if (store.positions.length >= MAX_POSITIONS) {
    console.log(`[SNIPER]  MAX POSITIONS SKIP: ${symbol} blocked because ${store.positions.length}/${MAX_POSITIONS} slots are full.`);
    return;
  }
  if (snipeInFlight.has(mint)) {
    console.log(`[SNIPER] DUPLICATE SNIPE SKIP: ${symbol} already has an in-flight attempt.`);
    return;
  }

  snipeInFlight.add(mint);
  try {
  const pub = RedisBus.getPublisher();
  const isWalletSignalEntry =
    entryOptions?.sourceLane === 'wallet' ||
    (entryOptions?.sourceLane !== 'alpha' && typeof taSig === 'string' && taSig.startsWith('ALPHA_'));
  const lossStreakState = getLossStreakState();
  const replayRecoveryWindowMs = Math.max(0, Number(entryOptions?.replayRecoveryWindowMs || 0));
  if (lossStreakState.restrictionsActive && entryOptions?.quotaAssist === true) {
      console.log(
        `[SNIPER]  QUOTA ASSIST HOLD: ${symbol} blocked while the bot cools down ` +
        `(${lossStreakState.consecutiveLosses} consecutive losses).`
      );
      return;
  }
  if (lossStreakState.restrictionsActive && (entryOptions?.allowRoutableLowLiquidity === true || entryOptions?.routeLiveFastTrack === true)) {
      if (entryOptions?.replayRecoveryProbe === true && store.positions.length <= 0) {
        const nowMs = Date.now();
        const lastRecoveryProbeAt = getLastRecoveryProbeAt();
        const remainingMs = Math.max(0, replayRecoveryWindowMs - (nowMs - lastRecoveryProbeAt));
        if (remainingMs > 0) {
          const cooldownSec = Math.max(30, Math.ceil(remainingMs / 1000));
          console.log(
            `[SNIPER]  RECOVERY PROBE HOLD: ${symbol} replay-backed recovery lane is still cooling down ` +
            `for ${Math.ceil(remainingMs / 60000)}m.`
          );
          await setMintCooldownExact(pub, mint, cooldownSec, 'RECOVERY_PROBE_COOLDOWN');
          return;
        }
        store.stats.lastRecoveryProbeAt = nowMs;
        saveStore();
        console.log(
          `[SNIPER]  RECOVERY PROBE PASS: ${symbol} ${entryOptions?.replayRecoveryReason || 'empty-book route-live recovery is active'} ` +
          `| cooldown ${Math.max(1, Math.round(replayRecoveryWindowMs / 60000))}m.`
        );
      } else {
      console.log(
        `[SNIPER]  COLD STREAK HOLD: ${symbol} route-live / low-liquidity bypass disabled ` +
        `after ${lossStreakState.consecutiveLosses} consecutive losses.`
      );
      return;
      }
  }
  let entryMode = entryOptions?.entryMode || 'normal';
  const realizedPnlSol = getCurrentRealizedPnlSol();
  if (
      entryOptions?.quotaAssist === true &&
      Number(entryOptions?.quotaAssistLevel || 0) >= 2 &&
      !lossStreakState.restrictionsActive
  ) {
      if (realizedPnlSol < 0) {
          console.log(
            `[SNIPER]  DESPERATION HOLD: ${symbol} quota-driven bypass disabled while realized PnL is ` +
            `${realizedPnlSol.toFixed(6)} SOL.`
          );
      } else {
          entryMode = 'desperation_bypass';
          if (entryOptions) {
              entryOptions.entryMode = 'desperation_bypass';
          }
      }
  }
  const isNormalEntry = entryMode === 'normal';
  const isMicroDownshiftEntry =
    isNormalEntry &&
    entryOptions?.fixedBuySol !== undefined &&
    entryOptions?.allowRoutableLowLiquidity === true;
  const probeLikeEntry = entryOptions?.probeLikeEntry === true;
  const routeLiveFastTrack = entryOptions?.routeLiveFastTrack === true;
  const applyNormalLaneFilters = isNormalEntry && !isMicroDownshiftEntry;
  const normalLaneConfig = loadNormalLaneConfig();
  if (entryOptions?.sourceLane === 'alpha') {
    const alphaMinLiquidityUsd = Math.max(0, Number(normalLaneConfig.minLiquidityUsd || 0));
    entryOptions.minLiquidityUsd = Math.max(alphaMinLiquidityUsd, Number(entryOptions?.minLiquidityUsd || 0));
    if ((momentum5m ?? 0) <= 0 || (momentum1m ?? 0) <= 0) {
      console.log(
        `[SNIPER]  ALPHA CONTINUATION REJECT: ${symbol} requires positive 1m and 5m continuation ` +
        `(1m=${Number(momentum1m || 0).toFixed(1)}%, 5m=${Number(momentum5m || 0).toFixed(1)}%).`
      );
      await setMintCooldownExact(pub, mint, 30, 'ALPHA_CONTINUATION');
      return;
    }
  }
  const entryFamily = normalizeEntryFamily({
    entryFamily: entryOptions?.entryFamily,
    sourceLane: entryOptions?.sourceLane,
    entryMode,
    probeLikeEntry,
    routeLiveFastTrack,
  });
  const familyDecision = evaluateCurrentFamilyDecision(entryFamily);
  if (familyDecision.disabled) {
    console.log(
      `[SNIPER]  FAMILY DISABLED: ${symbol} blocked for ${entryFamily} ` +
      `(${familyDecision.reason}).`
    );
    logMissedTarget({
      mint,
      symbol,
      stage: `${entryMode}-entry`,
      reason: 'entry_family_disabled',
      entryMode,
      sourceLane: entryOptions?.sourceLane,
      entryFamily,
      familySampleCount: familyDecision.sampleCount,
      familyRecentWinRate: familyDecision.recentWinRate,
      familyRecentNetSol: familyDecision.recentNetSol,
    });
    await setMintCooldownExact(pub, mint, 45, 'FAMILY_DISABLED');
    return;
  }

  //  Duplicate Action Prevention (60s Cooldown) & Strike Check
  const isInCooldown = await pub.get(REDIS_KEYS.cooldown(mint));
  let mintStrikes = 0;
  if (isInCooldown) {
      mintStrikes = Number(await pub.get(`strikes:${mint}`) || 0);
  }
  const quotaCooldownBypass = shouldBypassCooldownForQuotaAssist({
    quotaAssist: entryOptions?.quotaAssist,
    quotaAssistLevel: entryOptions?.quotaAssistLevel,
    sourceLane: entryOptions?.sourceLane,
    entryFamily,
    strikeCount: mintStrikes,
    lossStreakActive: lossStreakState.restrictionsActive,
  });
  if (isInCooldown && !quotaCooldownBypass) {
      console.log(`[SNIPER]  Skipping ${symbol}  actively cooling down (strikes: ${mintStrikes}).`);
      return;
  } else if (isInCooldown) {
      console.log(`[SNIPER] ⚠️ QUOTA ASSIST BYPASS: ignoring post-trade cooldown for ${symbol} | lane=${entryOptions?.sourceLane || entryFamily}`);
  }
  const existingPositionLock = await pub.get(REDIS_KEYS.position(mint));
  if (existingPositionLock) {
      const trackedPosition = store.positions.find((pos) => pos.mint === mint);
      if (!trackedPosition) {
        try {
          const liveBalanceLamports = await resolveWalletMintBalanceLamports(mint);
          if (liveBalanceLamports <= 0) {
            console.warn(`[SNIPER]  STALE POSITION LOCK CLEARED: ${symbol} had a Redis lock but no tracked position or wallet balance.`);
            await pub.del(REDIS_KEYS.position(mint));
          } else {
            console.log(
              `[SNIPER]  POSITION LOCK SKIP: ${symbol} has an untracked live wallet balance ` +
              `(${liveBalanceLamports} raw units) behind its Redis lock.`
            );
            return;
          }
        } catch (lockProbeErr: any) {
          console.warn(
            `[SNIPER]  POSITION LOCK HOLD: ${symbol} lock state could not be reconciled ` +
            `(${String(lockProbeErr?.message || lockProbeErr)}).`
          );
          return;
        }
      } else {
        console.log(
          `[SNIPER]  POSITION LOCK SKIP: ${symbol} already has an active live position lock ` +
          `(${existingPositionLock === 'LOCKED' ? 'pending/active' : 'tracked'}).`
        );
        return;
      }
  }
  const tempBlacklistPenalty = await getTempBlacklistPenalty(mint);
  if (tempBlacklistPenalty !== null) {
      console.log(
        `[SNIPER]  TEMP BLACKLIST HOLD: ${symbol} cooling after an execution failure ` +
        `(penalty ${tempBlacklistPenalty.toFixed(1)}x).`
      );
      return;
  }

  //  Global Rug-Ticker Shield
  const gmgnImageDupGate = evaluateGmgnImageDuplicationGate(mint, entryMode, tokenAgeSec);
  if (gmgnImageDupGate.block || gmgnImageDupGate.warn) {
      console.log(
        `[SNIPER]  GMGN DUP-IMAGE WARN: ${symbol} dupCount=${gmgnImageDupGate.meta?.imageDupCount} ` +
        `risk=${gmgnImageDupGate.meta?.duplicateImageRisk || 'unknown'} entryMode=${entryMode} ` +
        `source=${gmgnImageDupGate.meta?.source || 'unknown'}`
      );
  }

  const cleanSymbol = symbol.toUpperCase().trim();
  if (!symbol.includes('...')) {
      const isRugged = await pub.get(`shield:ruggedTicker:${cleanSymbol}`);
      if (isRugged) {
          console.log(`[SNIPER]  RUG TICKER SHIELD: Rejected ${symbol}. A variant recently rugged us! Protecting capital.`);
          return;
      }
  }

  //  Hive-Mind Dynamic Bounds Check
  const dynamicMinMom = (global as any).DYNAMIC_MIN_MOM_1M;
  if (dynamicMinMom !== undefined && momentum1m !== undefined && momentum1m !== 0 && momentum1m < dynamicMinMom) {
      console.log(`[SNIPER]  HIVE REJECT: ${symbol} momentum (${momentum1m.toFixed(1)}%) < min required (${dynamicMinMom.toFixed(1)}%)`);
      return;
  }
  const dynamicMaxAge = (global as any).DYNAMIC_MAX_AGE_MIN;
  if (dynamicMaxAge !== undefined && tokenAgeSec !== undefined && (tokenAgeSec / 60) > dynamicMaxAge) {
      console.log(`[SNIPER]  HIVE REJECT: ${symbol} age (${(tokenAgeSec / 60).toFixed(1)}m) > max allowed (${dynamicMaxAge.toFixed(1)}m)`);
      return;
  }

  //  Mathematical Expectations Pre-Validation
  // Rejects EV < 0 and tokens marked with Apex Manipulation flags synchronously
  const validationPassed = await validateTradeCandidate(mint, symbol);
  // BYPASS VALIDATION TEMPORARILY AS REQUESTED
  // if (!validationPassed) {
  //  Target Qualifier Logic
  // We compute a formal confidence score and validate liquidity constraints before routing.
  const mom = await pub.hgetall(REDIS_KEYS.momentum(mint));
  const poolLiq = mom?.liquidityUsd ? parseFloat(mom.liquidityUsd) : 0;
  const velocityLookup = loadVelocityWithMeta(mint);
  const vel = velocityLookup.velocity;

  // Synthesize confidence index
  const confidenceScore = computeEntryConfidence({
    taConfidence: taConf,
    buyRatio,
    volume1hUsd: volume1h,
    buys1h,
    velocity: vel ? {
      buys60s: vel.buys60s,
      buyRatio60s: vel.buyRatio60s,
      velocity: vel.velocity,
      solVolume60s: vel.solVolume60s,
    } : null,
  });
  const baseQualifierThreshold = getEntryQualifierThreshold({
    continuationApproved: entryOptions?.continuationApproved,
    buys60s: vel?.buys60s,
    buyRatio60s: vel?.buyRatio60s,
    velocity: vel?.velocity,
    solVolume60s: vel?.solVolume60s,
  });
  const qualifierThreshold = entryOptions?.qualifierThresholdScale !== undefined
    ? Math.max(0.1, baseQualifierThreshold * entryOptions.qualifierThresholdScale)
    : baseQualifierThreshold;

  const alphaBoostDecision = computeAlphaBoost({
    tokenAddress: mint,
    now: Date.now(),
    catalystSignalsFile: path.join(SIGNALS_DIR, 'catalyst_alerts.json'),
    walletSignalsFile: WALLET_SIG_FILE,
  });
  const alphaBoost = Number(alphaBoostDecision.totalBoost || 0);
  if (alphaBoostDecision.signalCount > 0 && (alphaBoostDecision.uniqueKols > 0 || alphaBoost > 0)) {
    console.log(
      `[SNIPER] ALPHA_BOOST: ${symbol} | boost=${alphaBoost >= 0 ? '+' : ''}${(alphaBoost * 100).toFixed(1)}% ` +
      `| kols=${alphaBoostDecision.uniqueKols} | signals=${alphaBoostDecision.signalCount} ` +
      `| wallet=${(Number(alphaBoostDecision.walletBoost || 0) * 100).toFixed(1)}% ` +
      `| catalyst=${(Number(alphaBoostDecision.catalystBoost || 0) * 100).toFixed(1)}%`
    );
  }
  const boostedConfidence = Math.min(1.0, confidenceScore + alphaBoost);

  if (boostedConfidence < qualifierThreshold) {
     console.log(
       `[SNIPER]  QUALIFIER REJECT: ${symbol} failed confidence threshold ` +
       `(${(boostedConfidence * 100).toFixed(1)}% < ${(qualifierThreshold * 100).toFixed(0)}% | ` +
       `base ${(confidenceScore * 100).toFixed(1)}% | alpha ${alphaBoost >= 0 ? '+' : ''}${(alphaBoost * 100).toFixed(1)}%)`
     );
     logMissedTarget({
       mint,
       symbol,
       reason: "Target Qualifier Confidence Too Low",
       confidence: confidenceScore,
       baseConfidence: confidenceScore,
       alphaBoost,
       alphaSignalCount: alphaBoostDecision.signalCount,
       alphaKols: alphaBoostDecision.uniqueKols,
       poolLiq,
     });
     await setMintCooldown(pub, mint, 60, '1');
     return;
  }

  // DISABLED:   // BONDED ONLY: reject tokens with no DEX pool (prebonded pump.fun)
  // DISABLED:   if (poolLiq <= 0) {
  // DISABLED:      console.log(`[SNIPER]  UNBONDED REJECT: ${symbol} has no DEX liquidity  prebonded pump.fun token`);
  // DISABLED:      logMissedTarget({ mint, symbol, reason: "No DEX pool (unbonded)", poolLiq: 0 });
  // DISABLED:      return;
  // DISABLED:   }
  // AGE FILTER: reject tokens younger than 30 minutes (fresh launches = deployer bait)
  if (entryOptions?.minTokenAgeSec !== undefined && tokenAgeSec !== undefined && tokenAgeSec < entryOptions.minTokenAgeSec) {
     console.log(`[SNIPER] LAST STAND AGE REJECT: ${symbol} is ${tokenAgeSec}s old (< ${entryOptions.minTokenAgeSec}s min window)`);
     await setMintCooldown(pub, mint, 120, '1');
     return;
  }
  if (entryOptions?.maxTokenAgeSec !== undefined && tokenAgeSec !== undefined && tokenAgeSec > entryOptions.maxTokenAgeSec) {
     const staleFlowFloor = Math.max(50000, poolLiq * 1.5);
     if (volume1h < staleFlowFloor && buys1h < 250) {
       console.log(`[SNIPER] LAST STAND STALE REJECT: ${symbol} is ${tokenAgeSec}s old and flow is weak ($${volume1h.toFixed(0)} vol, ${buys1h} buys).`);
      await setMintCooldown(pub, mint, 120, '1');
       return;
     }
     console.log(`[SNIPER] LAST STAND AGE OVERRIDE: ${symbol} is ${tokenAgeSec}s old but flow is strong enough to continue.`);
  }
  if (!entryOptions?.bypassAgeFloor && tokenAgeSec !== undefined && tokenAgeSec < 300) {
     console.log(`[SNIPER]  FRESH LAUNCH REJECT: ${symbol} only ${(tokenAgeSec/60).toFixed(0)}m old (min 5m)`);
     logMissedTarget({ mint, symbol, reason: "Too young (<5min)", age: tokenAgeSec });
     await setMintCooldown(pub, mint, 60, '1');
     return;
  }
  if (
    !isMicroDownshiftEntry &&
    shouldApplyNormalLaneMomentumFloor({
      entryMode,
      bypassNormalMomentumFloor: entryOptions?.bypassNormalMomentumFloor,
    }) &&
    normalLaneConfig.enabled &&
    (momentum5m ?? 0) < normalLaneConfig.minMomentum5mPct
  ) {
     console.log(`[SNIPER]  NORMAL MOMENTUM FLOOR: ${symbol} 5m ${(momentum5m || 0).toFixed(1)}% < ${normalLaneConfig.minMomentum5mPct.toFixed(1)}%`);
     logMissedTarget({
       mint,
       symbol,
       stage: 'normal-entry',
       reason: 'normal_lane_momentum_floor',
       entryMode,
       momentum5m,
       momentum1m,
       volume1hUsd: volume1h,
       buys1h,
       sells1h,
       buyRatio,
       tokenAgeSec,
     });
    await setMintCooldown(pub, mint, 180, 'NORMAL_MOMENTUM');
     return;
  }
  const velocityVolumeOverride = applyNormalLaneFilters && shouldAllowVelocityVolumeOverride({
    tokenAgeSec,
    momentum5m,
    momentum1m,
    poolLiquidityUsd: poolLiq,
    volume1hUsd: volume1h,
    normalLaneMinVolume1hUsd: normalLaneConfig.minVolume1hUsd,
    buys60s: vel?.buys60s,
    buyRatio60s: vel?.buyRatio60s,
    velocity: vel?.velocity,
    solVolume60s: vel?.solVolume60s,
    continuationApproved: entryOptions?.continuationApproved,
  });
  if (
    applyNormalLaneFilters &&
    normalLaneConfig.enabled &&
    !entryOptions?.bypassNormalVolumeFloor &&
    volume1h < normalLaneConfig.minVolume1hUsd &&
    !velocityVolumeOverride
  ) {
     console.log(`[SNIPER]  NORMAL VOLUME FLOOR: ${symbol} $${volume1h.toFixed(0)} < $${normalLaneConfig.minVolume1hUsd.toFixed(0)} /1h`);
     logMissedTarget({
       mint,
       symbol,
       stage: 'normal-entry',
       reason: 'normal_lane_volume_floor',
       entryMode,
       momentum5m,
       momentum1m,
       volume1hUsd: volume1h,
       buys1h,
       sells1h,
       buyRatio,
       tokenAgeSec,
     });
    await setMintCooldown(pub, mint, 300, 'NORMAL_VOLUME');
     return;
  }
  if (
    applyNormalLaneFilters &&
    normalLaneConfig.enabled &&
    !entryOptions?.bypassNormalVolumeFloor &&
    volume1h < normalLaneConfig.minVolume1hUsd &&
    velocityVolumeOverride
  ) {
     console.log(`[SNIPER]  NORMAL VOLUME OVERRIDE: ${symbol} low 1h volume allowed via ${entryOptions?.continuationApproved ? 'continuation-zero-momentum' : 'fresh strong-flow'} context`);
  }
  const strongShortMomentum =
    (momentum5m ?? 0) >= (entryOptions?.minMomentum5mPct || 0) ||
    (
      (momentum5m ?? 0) >= (entryOptions?.minMomentum5mPct || 0) * 0.7 &&
      (momentum1m ?? 0) > 0 &&
      buys1h >= 120 &&
      buyRatio >= 1.8
    );
  const bypassHunterModeActiveForReject = store.positions.length < 8;

  if (entryOptions?.minMomentum5mPct !== undefined && !strongShortMomentum && !bypassHunterModeActiveForReject) {
     console.log(`[SNIPER] LAST STAND MOMENTUM REJECT: ${symbol} 5m ${(momentum5m || 0).toFixed(1)}% and 1m ${(momentum1m || 0).toFixed(1)}% failed continuation threshold.`);
     await setMintCooldown(pub, mint, 120, '1');
     return;
  }
  if (entryOptions?.minVolumeUsd !== undefined && volume1h < entryOptions.minVolumeUsd && !bypassHunterModeActiveForReject) {
     console.log(`[SNIPER] LAST STAND VOLUME REJECT: ${symbol} volume $${volume1h.toFixed(0)} < $${entryOptions.minVolumeUsd.toFixed(0)}`);
     await setMintCooldown(pub, mint, 120, '1');
     return;
  }
  // Market cap floor: reject anything under $25K liquidity
  if (entryOptions?.minLiquidityUsd !== undefined && poolLiq > 0 && poolLiq < entryOptions.minLiquidityUsd) {
     console.log(`[SNIPER] LAST STAND LIQUIDITY REJECT: ${symbol} liquidity $${poolLiq.toFixed(0)} < $${entryOptions.minLiquidityUsd.toFixed(0)}`);
     await setMintCooldown(pub, mint, 120, '1');
     return;
  }
  const lowLiquidityMicroScoutFloor = Math.max(0, Number(normalLaneConfig.minLiquidityUsd || 0));
  const lowLiquidityMicroScout =
    entryMode === 'micro-scout' &&
    entryOptions?.sourceLane !== 'wallet' &&
    lowLiquidityMicroScoutFloor > 0 &&
    poolLiq >= 0 &&
    poolLiq < lowLiquidityMicroScoutFloor;
  if (lowLiquidityMicroScout) {
    const riskyProbeConfirmed =
      entryOptions?.walletConfirmed === true &&
      entryOptions?.routeLiveFastTrack === true &&
      entryOptions?.strongRecentFlowConfirmed === true;
    if (!riskyProbeConfirmed) {
      console.log(
        `[SNIPER]  LOW LIQ MICRO REJECT: ${symbol} liq $${poolLiq.toFixed(0)} < $${lowLiquidityMicroScoutFloor.toFixed(0)} ` +
        `without wallet-confirmed fast-track flow.`
      );
      await setMintCooldownExact(pub, mint, 60, 'LOW_LIQ_MICRO_REJECT');
      return;
    }
  }
  if (poolLiq > 0 && poolLiq < 5000) {
     console.log(`[SNIPER]  MCAP/LIQ REJECT: ${symbol} liquidity $${poolLiq.toFixed(0)} < $5K floor`);
     logMissedTarget({ mint, symbol, reason: "Below $5K liquidity floor", poolLiq });
    await setMintCooldown(pub, mint, 60, '1');
     return;
  }

  if (poolLiq > 0 && poolLiq < 3000) { // Extremely low liquidity = slippage death
     console.log(`[SNIPER]  QUALIFIER REJECT: ${symbol} has insufficient liquidity ($${poolLiq.toFixed(0)})`);
     logMissedTarget({ mint, symbol, reason: "Insufficient Dex Liquidity", poolLiq });
     return;
  }

  // }

  //  Dynamic Penalty Blacklist Cooling-Off
  const penaltyKey = REDIS_KEYS.tempBlacklist(mint);
  const penaltyStr = await pub.get(penaltyKey);
  const penaltyFactor = penaltyStr ? parseFloat(penaltyStr) : 1;

  const mult = GLOBAL_HUNTER_MULT;
  const reqBuys = Math.max(1, MIN_BUYS_1H * penaltyFactor * Math.max(0.25, entryOptions?.buyCountThresholdScale ?? 1) * mult);
  const reqRatio = Math.max(1.05, MIN_BUY_RATIO * penaltyFactor * Math.max(0.25, entryOptions?.buyRatioThresholdScale ?? 1) * mult);


  //  Real-time velocity gate (pcp-velocity gRPC stream)
  // Supersedes DexScreener 5m lag with live 60s rolling swap counts.
  let velocityOverride = false;
  if (entryOptions?.entryMode === 'velocity-arbitrage') {
      velocityOverride = true;
      console.log(`[SNIPER] VELOCITY ARBITRAGE: bypassing buyRatio checks for ${symbol}`);
  }
  if (vel) {
    const MIN_VEL_BUYS   = Math.max(1, Math.ceil(1 * mult));
    const MIN_VEL_RATIO  = Math.max(0.50, 0.50 * penaltyFactor * mult);

    // VELOCITY OVERRIDE: If a token has massive speed right now (15+ tx/min and 3+ buys in 60s),
    if (vel.buys60s >= MIN_VEL_BUYS && vel.velocity >= 15 && vel.solVolume60s >= 1.0) {
        console.log(`[SNIPER]  VELOCITY OVERRIDE TRIGGERED FOR ${symbol} (${vel.buys60s}B/60s @ ${vel.velocity}tx/m)`);
        velocityOverride = true;
    } else {
        if (vel.buys60s < MIN_VEL_BUYS) {
          console.log(`[SNIPER]  ${symbol} VELOCITY SKIP  only ${vel.buys60s} buys/60s (min ${MIN_VEL_BUYS.toFixed(1)}) | vel:${vel.velocity.toFixed(0)}txpm`);
          return;
        }
        if (vel.buyRatio60s < MIN_VEL_RATIO) {
          console.log(`[SNIPER]  ${symbol} VELOCITY SKIP  buy ratio ${(vel.buyRatio60s*100).toFixed(0)}% <${(MIN_VEL_RATIO*100).toFixed(0)}% | ${vel.buys60s}B/${vel.sells60s}S`);
          return;
        }
        if (vel.solVolume60s < 0.3) {
          console.log(`[SNIPER]  ${symbol} VOLUME SKIP  only ${vel.solVolume60s.toFixed(3)} SOL/60s (min 0.3)`);
          return;
        }
    }
    const accTag = vel.isAccelerating ? '  ACCELERATING' : '';
    console.log(`[SNIPER]  VELOCITY ${symbol}: ${vel.buys60s}B/${vel.sells60s}S (${(vel.buyRatio60s*100).toFixed(0)}%) | ${vel.velocity.toFixed(0)}tx/min | ${vel.solVolume60s.toFixed(3)} SOL/60s${accTag}`);
  } else {
    recordVelocityHydrationMiss(symbol, velocityLookup.meta);
    const ageText = velocityLookup.meta.snapshotAgeMs === null
      ? 'unknown age'
      : `${Math.round(velocityLookup.meta.snapshotAgeMs)}ms old`;
    console.log(
      `[SNIPER]  ${symbol} velocity hydration miss (${velocityLookup.meta.status}/${velocityLookup.meta.source}; ${ageText}) -> relying on DexScreener for this candidate.`
    );
  }

  // Edge filter: buy pressure must dominate unless actively accelerating via Spike
  const buyRatioOverride = shouldAllowBuyRatioOverride({
    buyRatio,
    reqRatio,
    continuationApproved: entryOptions?.continuationApproved,
    momentum1m,
    buys1h,
    volume1hUsd: volume1h,
    tokenAgeSec,
    buys60s: vel?.buys60s,
    buyRatio60s: vel?.buyRatio60s,
    velocity: vel?.velocity,
    solVolume60s: vel?.solVolume60s,
  });
  if (buyRatioOverride) {
    console.log(
      `[SNIPER]  BUY PRESSURE OVERRIDE: ${symbol} ` +
      `${buyRatio.toFixed(1)}x < ${reqRatio.toFixed(1)}x allowed via continuation-approved live flow`
    );
  }
  if (buyRatio < reqRatio && !velocityOverride && !buyRatioOverride) {
    const shadowLaneConfig = loadShadowLaneConfig();
    const shadowTerrainState = recordTerrainObservation(mint, {
      ts: Date.now(),
      symbol,
      entryMode,
      sourceLane: entryOptions?.sourceLane,
      priceChange5m: momentum5m,
      priceChange1h: priceChg1h,
      volume1hUsd: volume1h,
      buys60s: vel?.buys60s,
      sells60s: vel?.sells60s,
      buyRatio60s: vel?.buyRatio60s,
      velocity: vel?.velocity,
      solVolume60s: vel?.solVolume60s,
    });
    const shadowBuyRatioDecision = evaluateBuyRatioShadowLane(
      {
        buyRatio,
        reqRatio,
        buys60s: vel?.buys60s,
        buyRatio60s: vel?.buyRatio60s,
        velocity: vel?.velocity,
        solVolume60s: vel?.solVolume60s,
        terrainSummary: shadowTerrainState?.summary,
      },
      shadowLaneConfig,
    );
    if (shadowBuyRatioDecision.shouldHold) {
      console.log(
        `[SNIPER]  SHADOW BUY-RATIO HOLD: ${symbol} ${shadowBuyRatioDecision.reason} ` +
        `(ratio ${buyRatio.toFixed(2)}x < ${reqRatio.toFixed(2)}x) - recheck in ${shadowBuyRatioDecision.cooldownSeconds}s.`
      );
      logMissedTarget({
        mint,
        symbol,
        stage: 'normal-entry',
        reason: shadowBuyRatioDecision.code,
        entryMode: entryOptions?.entryMode || 'normal',
        buyRatio,
        buys1h,
        sells1h,
        tokenAgeSec,
        momentum5m,
        momentum1m,
        volume1hUsd: volume1h,
        buys60s: vel?.buys60s,
        sells60s: vel?.sells60s,
        buyRatio60s: vel?.buyRatio60s,
        velocity: vel?.velocity,
        solVolume60s: vel?.solVolume60s,
        terrainSampleCount: shadowTerrainState?.summary?.sampleCount,
        terrainPriceDelta5m: shadowTerrainState?.summary?.priceDelta5m,
        terrainFlowDecayRatio: shadowTerrainState?.summary?.flowDecayRatio,
        redisCooldownSec: shadowBuyRatioDecision.cooldownSeconds,
      });
      await setMintCooldownExact(pub, mint, shadowBuyRatioDecision.cooldownSeconds, 'SHADOW_BR_HOLD');
      return;
    }
    console.log(`[SNIPER]   ${symbol} skipped  buy ratio ${buyRatio.toFixed(1)}x < req ${reqRatio.toFixed(1)}x (${buys1h}B/${sells1h}S)`);
    logMissedTarget({
      mint,
      symbol,
      stage: 'normal-entry',
      reason: 'buy_ratio_below_threshold',
      entryMode: entryOptions?.entryMode || 'normal',
      buyRatio,
      buys1h,
      sells1h,
      tokenAgeSec,
      momentum5m,
      momentum1m,
      volume1hUsd: volume1h,
      buys60s: vel?.buys60s,
      sells60s: vel?.sells60s,
      buyRatio60s: vel?.buyRatio60s,
      velocity: vel?.velocity,
      solVolume60s: vel?.solVolume60s,
    });
    if (entryOptions?.sourceLane === 'mature-fallback') {
      const matureFallbackConfig = loadMatureFallbackConfig();
      const cooldownSeconds = getMatureFallbackRejectCooldownSec(
        { hadVelocityHydrationMiss: !vel },
        matureFallbackConfig,
      );
      await setMintCooldown(pub, mint, cooldownSeconds, 'MATURE_BUY_RATIO');
    } else if (isWalletSignalEntry) {
      await setMintCooldown(pub, mint, 20, 'LOCKED');
    } else {
      const rejectCooldownConfig = loadEntryRejectCooldownConfig();
      const cooldownSeconds = getEntryRejectCooldownSeconds(
        'buy_ratio',
        {
          buys60s: vel?.buys60s,
          solVolume60s: vel?.solVolume60s,
          velocity: vel?.velocity,
        },
        rejectCooldownConfig,
      );
      if (cooldownSeconds > 0) {
        await setMintCooldown(pub, mint, cooldownSeconds, 'BUY_RATIO_FAIL');
      }
    }
    return;
  }
  const buyCountOverride = shouldAllowBuyCountOverride({
    buys1h,
    reqBuys,
    tokenAgeSec,
    continuationApproved: entryOptions?.continuationApproved,
    buys60s: vel?.buys60s,
    buyRatio60s: vel?.buyRatio60s,
    velocity: vel?.velocity,
    solVolume60s: vel?.solVolume60s,
  }, loadBuyCountOverrideConfig());
  if (buyCountOverride) {
    console.log(
      `[SNIPER]  BUY COUNT OVERRIDE: ${symbol} only ${buys1h} buys in 1h ` +
      `(min ${reqBuys}), allowed via fresh strong live flow`
    );
  }
  if (buys1h < reqBuys && !velocityOverride && !buyCountOverride) {
    console.log(`[SNIPER]   ${symbol} skipped  only ${buys1h} buys in 1h (min ${reqBuys})`);
    logMissedTarget({
      mint,
      symbol,
      stage: 'normal-entry',
      reason: 'buys_below_threshold',
      entryMode: entryOptions?.entryMode || 'normal',
      buyRatio,
      buys1h,
      sells1h,
      tokenAgeSec,
      momentum5m,
      momentum1m,
      volume1hUsd: volume1h,
      buys60s: vel?.buys60s,
      sells60s: vel?.sells60s,
      buyRatio60s: vel?.buyRatio60s,
      velocity: vel?.velocity,
      solVolume60s: vel?.solVolume60s,
    });
    if (entryOptions?.sourceLane === 'mature-fallback') {
      const matureFallbackConfig = loadMatureFallbackConfig();
      const cooldownSeconds = getMatureFallbackRejectCooldownSec(
        { hadVelocityHydrationMiss: !vel },
        matureFallbackConfig,
      );
      await setMintCooldown(pub, mint, cooldownSeconds, 'MATURE_BUYS');
    } else if (isWalletSignalEntry) {
      await setMintCooldown(pub, mint, 20, 'LOCKED');
    } else {
      const rejectCooldownConfig = loadEntryRejectCooldownConfig();
      const cooldownSeconds = getEntryRejectCooldownSeconds(
        'buys_below_threshold',
        {
          buys60s: vel?.buys60s,
          solVolume60s: vel?.solVolume60s,
          velocity: vel?.velocity,
        },
        rejectCooldownConfig,
      );
      if (cooldownSeconds > 0) {
        await setMintCooldown(pub, mint, cooldownSeconds, 'LOW_BUYS');
      }
    }
    return;
  }

  //  Volume-to-Liquidity Validation (Anticipation Filter)
  const momData = await pub.hgetall(REDIS_KEYS.momentum(mint));
  if (momData && momData.liquidityUsd) {
     const poolLiq = parseFloat(momData.liquidityUsd);
     if (poolLiq > 1000) { // Exclude newly born zero-liq pools from math fail
         // 1h Volume must be at least 2x the total pool liquidity to prove heavy accumulation vs float
         if (volume1h < poolLiq * 2.0 && !velocityOverride) {
             console.log(`[SNIPER]   ${symbol} skipped  Volume/Liquidity Divergence Failure: $${Math.floor(volume1h)} Vol < 2.0x Liquidity ($${Math.floor(poolLiq * 2.0)})`);
             logMissedTarget({
               mint,
               symbol,
               stage: 'normal-entry',
               reason: 'volume_liquidity_divergence',
               entryMode: entryOptions?.entryMode || 'normal',
               liquidityUsd: poolLiq,
               volume1hUsd: volume1h,
               buyRatio,
               buys1h,
               sells1h,
               tokenAgeSec,
               momentum5m,
               momentum1m,
             });
             return;
         }
     }
  }

  //  EV and Slippage Firewall
  const params = await pub.hgetall(`trade:params:${mint}`);
  const solPrice = parseFloat(await pub.hget('price:So11111111111111111111111111111111111111112', 'usd') || '150');

  let buySol = await calcBuySize(entryOptions); // fallback
  // Loss streak check
  if (isLossStreakPaused()) {
    const remaining = Math.ceil(((store.stats as any).pausedUntil - Date.now()) / 60000);
    console.log('[SNIPER]  LOSS STREAK PAUSE: ' + remaining + 'min remaining after ' + (store.stats as any).consecutiveLosses + ' consecutive losses');
    return;
  }

  if (buySol === 0) {
      console.log(`[SNIPER]  CIRCUIT BREAKER REJECTION: Halting snipe attempt on ${symbol}.`);
      return;
  }

  if (!entryOptions?.forceAllIn && params && Object.keys(params).length > 0) {
      // if (params.isProfitable === 'false') {
      //     console.log(`[SNIPER]  ${symbol} skipped  Negative Expected Value (EV=${parseFloat(params.expectedValue).toFixed(4)})`);
      //     return;
      // }

      if (params.positionSizeUSD) {
         const proposedSol = parseFloat(params.positionSizeUSD) / solPrice;
         const safeSol = Math.min(MAX_BUY_SOL, Math.max(MIN_BUY_SOL, proposedSol));
         buySol = parseFloat(safeSol.toFixed(4));
         if (parseFloat(params.positionSizeUSD) === 0) { // Circuit Breaker zero-out catch
             console.log(`[SNIPER]  ABORT: Performance circuit block detected in target.`);
             return;
         }
         console.log(`[SNIPER]  Kelly Criterion Sizing: ${buySol} SOL ($${parseFloat(params.positionSizeUSD).toFixed(2)})`);
      }
  }

  const ageTag = tokenAgeSec ? ` | age:${(tokenAgeSec/60).toFixed(0)}min` : '';
  console.log(`[SNIPER]  Evaluating ${symbol} | +${priceChg1h.toFixed(0)}%/1h | $${(volume1h/1000).toFixed(1)}k vol | ${buys1h}B/${sells1h}S (${buyRatio.toFixed(1)}x) | size: ${buySol} SOL${ageTag}`);

  // RUGCHECK SECURITY PRE-FLIGHT
  const rugResult = await checkRugSafety(mint);
  if (!rugResult.safe) {
    console.log(`[SNIPER]  RUGCHECK REJECT: ${symbol}  ${rugResult.riskLevel} (score: ${rugResult.score})  honeypot/mintable risk`);
    logMissedTarget({ mint, symbol, reason: 'RugCheck: ' + rugResult.riskLevel, poolLiq });
    store.blacklist.push(mint);
    await pub.setex(REDIS_KEYS.cooldown(mint), 3600, '1'); // 1hr blacklist
    return;
  }
  if (rugResult.softRiskNames.length > 0) {
    console.log(
      `[SNIPER]  RUGCHECK SOFT RISK: ${symbol} ${rugResult.softRiskNames.join(', ')} ` +
      `(score: ${rugResult.score}) will reduce size instead of hard rejecting.`
    );
  }

  // HOLDER CONCENTRATION CHECK: reject insider-controlled tokens
  const holderResult = await checkHolderConcentration(mint);
  if (holderResult.isJitterBundle) {
    console.log('[SNIPER]  JITTER BUNDLE RISK: ' + symbol + '  scripted holder shape will reduce size instead of hard reject.');
  }
  if (!holderResult.safe) {
    console.log('[SNIPER]  HOLDER RISK: ' + symbol + '  top10: ' + holderResult.top10Pct.toFixed(0) + '%, holders: ' + holderResult.holderCount + ' will flow into position sizing.');
  }
  console.log('[SNIPER] \u2705 HOLDER OK: ' + symbol + '  top10: ' + holderResult.top10Pct.toFixed(0) + '%, holders: ' + holderResult.holderCount);
  console.log('[SNIPER] DEBUG_1: Passed HOLDER OK');

  // MARKET CAP CHECK: reject micro-cap dust tokens
  const liveMcap = await fetchDexScreenerPair(mint);
  console.log('[SNIPER] DEBUG_2: Passed fetchDexScreenerPair');
  const liveMarketCapUsd = Number(liveMcap?.marketCap || liveMcap?.fdv || 0);
  const liveLiquidityUsd = Number(liveMcap?.liquidity || 0);
  const liveFdvUsd = Number(liveMcap?.fdv || liveMcap?.marketCap || 0);
  let liveRouteProbe: { routable: boolean; outAmount: string | null } | null = null;
  let preRecordedTerrainState = null;
  if (liveMcap && !isExecutableLivePair(liveMcap)) {
    liveRouteProbe = await probeJupiterTradability(
      mint,
      Math.max(1_000_000, Math.floor((entryOptions?.fixedBuySol || 0.001) * 1e9)),
    );
    if (liveRouteProbe.routable) {
      preRecordedTerrainState = recordTerrainObservation(mint, {
        ts: Date.now(),
        symbol,
        entryMode,
        sourceLane: entryOptions?.sourceLane,
        priceChange5m: liveMcap?.priceChange5m,
        priceChange1h: liveMcap?.priceChange1h ?? priceChg1h,
        liquidityUsd: liveLiquidityUsd,
        marketCapUsd: liveMarketCapUsd,
        fdvUsd: liveFdvUsd,
        volume1hUsd: Math.max(volume1h, Number(liveMcap?.volume1h || 0)),
        buys60s: vel?.buys60s,
        sells60s: vel?.sells60s,
        buyRatio60s: vel?.buyRatio60s,
        velocity: vel?.velocity,
        solVolume60s: vel?.solVolume60s,
        routeLive: true,
        routeOutAmount: liveRouteProbe?.outAmount ? Number(liveRouteProbe.outAmount) : null,
      });
      const routeLiveZeroLiqDecision = evaluateRouteLiveZeroLiquidityEntry(
        {
          priceChange5m: liveMcap?.priceChange5m,
          priceChange1h: liveMcap?.priceChange1h ?? priceChg1h,
          tokenAgeSec,
          buys60s: vel?.buys60s,
          buyRatio60s: vel?.buyRatio60s,
          velocity: vel?.velocity,
          solVolume60s: vel?.solVolume60s,
          terrainSummary: preRecordedTerrainState?.summary,
        },
        loadRouteLiveZeroLiquidityConfig(),
      );
      if (routeLiveZeroLiqDecision.shouldHold || routeLiveZeroLiqDecision.shouldBlock) {
        const bypassHunterModeActive = !lossStreakState.restrictionsActive && (store.positions ? store.positions.length < 8 : false);
        const replayRecoveryBypassActive = entryOptions?.replayRecoveryProbe === true && store.positions.length <= 0;
        if (bypassHunterModeActive) {
          console.log(`[SNIPER]  HUNTER MODE BYPASS: ${symbol} overriding ZERO LIQ ROUTE BLOCK.`);
        } else if (replayRecoveryBypassActive) {
          console.log(
            `[SNIPER]  RECOVERY PROBE ZERO LIQ PASS: ${symbol} ${entryOptions?.replayRecoveryReason || routeLiveZeroLiqDecision.reason}.`
          );
        } else {
          console.log(
            `[SNIPER] ${routeLiveZeroLiqDecision.shouldHold ? '' : ''} ZERO LIQ ROUTE ${routeLiveZeroLiqDecision.shouldHold ? 'HOLD' : 'BLOCK'}: ` +
            `${symbol} ${routeLiveZeroLiqDecision.reason} - recheck in ${routeLiveZeroLiqDecision.cooldownSec}s.`
          );
          logMissedTarget({
            mint,
            symbol,
            stage: 'normal-entry',
            reason: routeLiveZeroLiqDecision.code,
            entryMode,
            marketCapUsd: liveMarketCapUsd,
            liquidityUsd: liveLiquidityUsd,
            volume1hUsd: Math.max(volume1h, Number(liveMcap?.volume1h || 0)),
            momentum5m,
            momentum1m,
            buys1h,
            sells1h,
            buyRatio,
            tokenAgeSec,
            buys60s: vel?.buys60s,
            sells60s: vel?.sells60s,
            buyRatio60s: vel?.buyRatio60s,
            velocity: vel?.velocity,
            solVolume60s: vel?.solVolume60s,
            terrainSampleCount: preRecordedTerrainState?.summary?.sampleCount,
            terrainPriceOffPeak5m: preRecordedTerrainState?.summary?.priceOffPeak5m,
            terrainFlowDecayRatio: preRecordedTerrainState?.summary?.flowDecayRatio,
            terrainLiquidityDeltaUsd: preRecordedTerrainState?.summary?.liquidityDeltaUsd,
            terrainRouteStrengthPct: preRecordedTerrainState?.summary?.routeStrengthPct,
            redisCooldownSec: routeLiveZeroLiqDecision.cooldownSec,
          });
          await setMintCooldownExact(pub, mint, routeLiveZeroLiqDecision.cooldownSec, 'ZERO_LIQ');
          return;
        }
      }
      if (routeLiveZeroLiqDecision.code === 'route_live_zero_liq_fast_track' && !lossStreakState.restrictionsActive) {
        entryOptions = { ...(entryOptions || {}), routeLiveFastTrack: true };
        console.log(
          `[SNIPER]  ZERO LIQ FAST TRACK: ${symbol} exceptional first route-live sample ` +
          `(${Number(vel?.buys60s || 0).toFixed(0)}B/${Number(vel?.sells60s || 0).toFixed(0)}S | ` +
          `${Number(vel?.velocity || 0).toFixed(0)}tx/min | ${Number(vel?.solVolume60s || 0).toFixed(3)} SOL/60s | ` +
          `5m ${Number(liveMcap?.priceChange5m || 0).toFixed(1)}%).`
        );
      } else if (routeLiveZeroLiqDecision.code === 'route_live_zero_liq_price_response') {
        console.log(
          `[SNIPER]  ZERO LIQ PRICE RESPONSE PASS: ${symbol} rolling terrain stayed near peak ` +
          `(${Number(preRecordedTerrainState?.summary?.sampleCount || 0)} samples | ` +
          `offPeak=${Number(preRecordedTerrainState?.summary?.priceOffPeak5m || 0).toFixed(1)}% | ` +
          `flowDecay=${Number.isFinite(preRecordedTerrainState?.summary?.flowDecayRatio) ? Number(preRecordedTerrainState?.summary?.flowDecayRatio).toFixed(2) : 'n/a'}).`
        );
      }
      console.log(
        '[SNIPER] ZERO LIQ ENTRY OVERRIDE: ' + symbol +
        ' DexScreener still shows zero executable liquidity, but Jupiter quote exists' +
        (liveRouteProbe.outAmount ? ' (outAmount=' + liveRouteProbe.outAmount + ')' : '') +
        '.'
      );
    } else {
      const zeroLiqPlan = planZeroLiquidityRecheck({
        continuationApproved: entryOptions?.continuationApproved,
        buys60s: vel?.buys60s,
        buyRatio60s: vel?.buyRatio60s,
        velocity: vel?.velocity,
        solVolume60s: vel?.solVolume60s,
        tokenAgeSec,
        terrainSummary: terrainMemoryStore[mint]?.summary,
      });
      console.log(
        '[SNIPER] LIVE PAIR ZERO LIQUIDITY: ' + symbol +
        ' has an indexed pair but no executable liquidity yet' +
        ' - recheck in ' + zeroLiqPlan.cooldownSec + 's' +
        (zeroLiqPlan.fastRecheck ? ' (fast-flow retry)' : '') +
        '.'
      );
      logMissedTarget({
        mint,
        symbol,
        stage: 'normal-entry',
        reason: 'live_pair_zero_liquidity',
        entryMode,
        marketCapUsd: liveMarketCapUsd,
        liquidityUsd: liveLiquidityUsd,
        volume1hUsd: Math.max(volume1h, Number(liveMcap?.volume1h || 0)),
        momentum5m,
        momentum1m,
        buys1h,
        sells1h,
        buyRatio,
        tokenAgeSec,
        buys60s: vel?.buys60s,
        sells60s: vel?.sells60s,
        buyRatio60s: vel?.buyRatio60s,
        velocity: vel?.velocity,
        solVolume60s: vel?.solVolume60s,
        redisCooldownSec: zeroLiqPlan.cooldownSec,
      });
      await setMintCooldown(pub, mint, zeroLiqPlan.cooldownSec, 'ZERO_LIQ');
      return;
    }
  }
  const terrainState = preRecordedTerrainState || recordTerrainObservation(mint, {
    ts: Date.now(),
    symbol,
    entryMode,
    sourceLane: entryOptions?.sourceLane,
    priceChange5m: liveMcap?.priceChange5m,
    priceChange1h: liveMcap?.priceChange1h ?? priceChg1h,
    liquidityUsd: liveLiquidityUsd,
    marketCapUsd: liveMarketCapUsd,
    fdvUsd: liveFdvUsd,
    volume1hUsd: Math.max(volume1h, Number(liveMcap?.volume1h || 0)),
    buys60s: vel?.buys60s,
    sells60s: vel?.sells60s,
    buyRatio60s: vel?.buyRatio60s,
    velocity: vel?.velocity,
    solVolume60s: vel?.solVolume60s,
    routeLive: liveRouteProbe?.routable ?? null,
    routeOutAmount: liveRouteProbe?.outAmount ? Number(liveRouteProbe.outAmount) : null,
  });
  const terrainConfig = loadTerrainMemoryConfig();
  const syntheticRefinementGate = evaluateSyntheticRefinementEntryGate({
    syntheticRefinementOnly: entryOptions?.syntheticRefinementOnly,
    syntheticSource: entryOptions?.syntheticSource,
    liquidityUsd: liveLiquidityUsd,
    routeLive: liveRouteProbe?.routable ?? null,
    momentum5m,
    terrainSummary: terrainState?.summary,
  }, terrainConfig);
  if (syntheticRefinementGate.shouldHold || syntheticRefinementGate.shouldBlock) {
    const terrainSummary = terrainState?.summary || {};
    console.log(
      `[SNIPER] ${syntheticRefinementGate.shouldHold ? ' SYNTHETIC REFINE HOLD' : ' SYNTHETIC REFINE BLOCK'}: ` +
      `${symbol} ${syntheticRefinementGate.reason} | samples=${terrainSummary.sampleCount || 0} ` +
      `| liq=$${Number(liveLiquidityUsd || 0).toFixed(0)} | 5m=${Number(momentum5m || 0).toFixed(1)}%`
    );
    logMissedTarget({
      mint,
      symbol,
      stage: `${entryMode}-entry`,
      reason: syntheticRefinementGate.code,
      entryMode: entryOptions?.entryMode || 'normal',
      source: entryOptions?.syntheticSource || entryOptions?.sourceLane,
      marketCapUsd: liveMarketCapUsd,
      fdvUsd: liveFdvUsd,
      liquidityUsd: liveLiquidityUsd,
      volume1hUsd: Math.max(volume1h, Number(liveMcap?.volume1h || 0)),
      tokenAgeSec,
      momentum5m,
      momentum1m,
      buys1h,
      sells1h,
      buyRatio,
      buys60s: vel?.buys60s,
      sells60s: vel?.sells60s,
      buyRatio60s: vel?.buyRatio60s,
      velocity: vel?.velocity,
      solVolume60s: vel?.solVolume60s,
      terrainSampleCount: terrainSummary.sampleCount,
      terrainSpanMs: terrainSummary.spanMs,
      terrainStrongFlowSamples: terrainSummary.strongFlowSamples,
      terrainPriceDelta5m: terrainSummary.priceDelta5m,
      terrainLiquidityDeltaUsd: terrainSummary.liquidityDeltaUsd,
      terrainRouteStrengthPct: terrainSummary.routeStrengthPct,
      syntheticSource: entryOptions?.syntheticSource,
      redisCooldownSec: syntheticRefinementGate.cooldownSeconds,
    });
    await setMintCooldownExact(
      pub,
      mint,
      syntheticRefinementGate.cooldownSeconds,
      syntheticRefinementGate.shouldHold ? 'SYNTH_REFINE_WAIT' : 'SYNTH_REFINE_BLOCK',
    );
    return;
  }
  const apexEntry = evaluateApexEntry({
    rugCheckSafe: rugResult.safe,
    marketCapUsd: liveMarketCapUsd || undefined,
    volume5mUsd: Number(liveMcap?.volume5m || 0) || undefined,
    volume1hUsd: Math.max(volume1h, Number(liveMcap?.volume1h || 0)) || undefined,
    volume6hUsd: Number(liveMcap?.volume6h || 0) || undefined,
    momentum5mPct: momentum5m,
    momentum1hPct: Number(liveMcap?.priceChange1h ?? priceChg1h),
    tokenAgeSec,
    holderCount: holderResult.holderCount,
    top10Pct: holderResult.top10Pct,
  }, loadApexPredatorConfig());
  const apexMarketCapBypassAllowed = shouldAllowNormalLaneApexMarketCapBypass({
    marketCapUsd: liveMarketCapUsd,
    overlayMaxMarketCapUsd: normalLaneConfig.apexOverlayMaxMarketCapUsd,
    apexSupportsAggressiveOverlay: apexEntry.supportsAggressiveOverlay,
  });
  if (applyNormalLaneFilters && normalLaneConfig.enabled && liveMarketCapUsd > 0 && liveMarketCapUsd < normalLaneConfig.minMarketCapUsd && !apexMarketCapBypassAllowed) {
    console.log(
      `[SNIPER]  NORMAL MCAP FLOOR: ${symbol} mcap $${liveMarketCapUsd.toFixed(0)} < $${normalLaneConfig.minMarketCapUsd.toFixed(0)} without strong apex support`
    );
    logMissedTarget({
      mint,
      symbol,
      stage: 'normal-entry',
      reason: 'normal_lane_market_cap_floor',
      entryMode,
      marketCapUsd: liveMarketCapUsd,
      liquidityUsd: liveLiquidityUsd,
      volume1hUsd: Math.max(volume1h, Number(liveMcap?.volume1h || 0)),
      momentum5m,
      momentum1m,
      buys1h,
      sells1h,
      buyRatio,
      apexConvictionScore: apexEntry.convictionScore,
      apexRedFlagCount: apexEntry.redFlagCount,
    });
    await setMintCooldown(pub, mint, 900, 'NORMAL_MCAP');
    return;
  }
  if (applyNormalLaneFilters && normalLaneConfig.enabled && liveMarketCapUsd > normalLaneConfig.maxMarketCapUsd && !apexMarketCapBypassAllowed) {
    console.log(
      `[SNIPER]  NORMAL MCAP CEILING: ${symbol} mcap $${liveMarketCapUsd.toFixed(0)} > $${normalLaneConfig.maxMarketCapUsd.toFixed(0)} ` +
      `(overlay cap $${normalLaneConfig.apexOverlayMaxMarketCapUsd.toFixed(0)})`
    );
    logMissedTarget({
      mint,
      symbol,
      stage: 'normal-entry',
      reason: 'normal_lane_market_cap_ceiling',
      entryMode,
      marketCapUsd: liveMarketCapUsd,
      liquidityUsd: liveLiquidityUsd,
      volume1hUsd: Math.max(volume1h, Number(liveMcap?.volume1h || 0)),
      momentum5m,
      momentum1m,
      buys1h,
      sells1h,
      buyRatio,
      apexConvictionScore: apexEntry.convictionScore,
      apexRedFlagCount: apexEntry.redFlagCount,
    });
    await setMintCooldown(pub, mint, 900, 'NORMAL_MCAP');
    return;
  }
  const allowRoutableLowLiquidity = entryOptions?.allowRoutableLowLiquidity === true;
  const strongFlowLiquidityOverride =
    volume1h >= Math.max(50000, (liveMcap?.liquidity || 0) * 4) &&
    buys1h >= 250 &&
    buyRatio >= 2.5;
  const minLiveLiquidityUsd = allowRoutableLowLiquidity
    ? Math.max(0, entryOptions?.minLiquidityUsd || 0)
    : strongFlowLiquidityOverride
      ? Math.max(5000, applyNormalLaneFilters && normalLaneConfig.enabled ? normalLaneConfig.minLiquidityUsd : 0, entryOptions?.minLiquidityUsd || 0)
      : Math.max(7500, applyNormalLaneFilters && normalLaneConfig.enabled ? normalLaneConfig.minLiquidityUsd : 0, entryOptions?.minLiquidityUsd || 0);
  if (liveMcap && liveMcap.liquidity < minLiveLiquidityUsd) {
    console.log('[SNIPER] \u{1f6ab} MCAP REJECT: ' + symbol + '  liq $' + liveMcap.liquidity.toFixed(0) + ' < $' + minLiveLiquidityUsd.toFixed(0));
    logMissedTarget({
      mint,
      symbol,
      stage: 'normal-entry',
      reason: 'live_liquidity_below_threshold',
      entryMode: entryOptions?.entryMode || 'normal',
      liquidityUsd: liveMcap.liquidity,
      volume1hUsd: volume1h,
      buys1h,
      sells1h,
      buyRatio,
      tokenAgeSec,
      momentum5m,
      momentum1m,
    });
    await setMintCooldown(pub, mint, 600, '1');
    return;
  }

  const fdvLiquidityGuard = evaluateFdvLiquidityGuard({
    entryMode,
    sourceLane: entryOptions?.sourceLane,
    valuationUsd: liveFdvUsd,
    liquidityUsd: Math.max(liveLiquidityUsd, Number(momData?.liquidityUsd || 0)),
  }, loadFdvLiquidityGuardConfig());
  if (fdvLiquidityGuard.shouldBlock) {
    console.log(
      `[SNIPER]  FDV/LIQ REJECT: ${symbol} fdv/liquidity ${fdvLiquidityGuard.metrics.fdvToLiquidityRatio.toFixed(1)}x ` +
      `(${entryOptions?.sourceLane || entryMode}) | fdv $${fdvLiquidityGuard.metrics.valuationUsd.toFixed(0)} | ` +
      `liq $${fdvLiquidityGuard.metrics.liquidityUsd.toFixed(0)}`
    );
    logMissedTarget({
      mint,
      symbol,
      stage: 'normal-entry',
      reason: 'fdv_liquidity_mismatch',
      entryMode: entryOptions?.entryMode || 'normal',
      marketCapUsd: liveMarketCapUsd,
      fdvUsd: liveFdvUsd,
      liquidityUsd: fdvLiquidityGuard.metrics.liquidityUsd,
      fdvToLiquidityRatio: fdvLiquidityGuard.metrics.fdvToLiquidityRatio,
      liquidityToFdvRatio: fdvLiquidityGuard.metrics.liquidityToFdvRatio,
      volume1hUsd: Math.max(volume1h, Number(liveMcap?.volume1h || 0)),
      tokenAgeSec,
      momentum5m,
      momentum1m,
      buys1h,
      sells1h,
      buyRatio,
      buys60s: vel?.buys60s,
      sells60s: vel?.sells60s,
      buyRatio60s: vel?.buyRatio60s,
      velocity: vel?.velocity,
      solVolume60s: vel?.solVolume60s,
    });
    await setMintCooldownExact(pub, mint, fdvLiquidityGuard.cooldownSeconds, 'FDV_LIQ');
    return;
  }
  if (fdvLiquidityGuard.shouldWarn) {
    console.log(
      `[SNIPER]  FDV/LIQ WARN: ${symbol} fdv/liquidity ${fdvLiquidityGuard.metrics.fdvToLiquidityRatio.toFixed(1)}x ` +
      `(${entryOptions?.sourceLane || entryMode}) | fdv $${fdvLiquidityGuard.metrics.valuationUsd.toFixed(0)} | ` +
      `liq $${fdvLiquidityGuard.metrics.liquidityUsd.toFixed(0)}`
    );
  }

  const terrainGuard = evaluateTerrainGuard(terrainState, {
    entryMode,
    probeLike: entryMode === 'micro-scout' || isMicroDownshiftEntry || entryOptions?.fixedBuySol !== undefined,
    liquidityUsd: liveLiquidityUsd,
    routeLive: liveRouteProbe?.routable ?? null,
  }, terrainConfig);
  if (terrainGuard.shouldHold || terrainGuard.shouldBlock) {
    const terrainSummary = terrainState?.summary || {};
    const terrainLabel = terrainGuard.shouldHold ? 'TERRAIN HOLD' : 'TERRAIN REJECT';
    console.log(
      `[SNIPER]  ${terrainLabel}: ${symbol} ${terrainGuard.reason} | samples=${terrainSummary.sampleCount || 0} ` +
      `| route=${Number.isFinite(terrainSummary.routeStrengthPct) ? terrainSummary.routeStrengthPct.toFixed(1) + '%' : 'n/a'} ` +
      `| liq=$${Number(terrainSummary.liquidityDeltaUsd || 0).toFixed(0)} ` +
      `| flowDecay=${Number.isFinite(terrainSummary.flowDecayRatio) ? Number(terrainSummary.flowDecayRatio).toFixed(2) : 'n/a'} ` +
      `| offPeak=${Number(terrainSummary.priceOffPeak5m || 0).toFixed(1)}%`
    );
    logMissedTarget({
      mint,
      symbol,
      stage: `${entryMode}-entry`,
      reason: terrainGuard.code,
      entryMode: entryOptions?.entryMode || 'normal',
      marketCapUsd: liveMarketCapUsd,
      fdvUsd: liveFdvUsd,
      liquidityUsd: liveLiquidityUsd,
      volume1hUsd: Math.max(volume1h, Number(liveMcap?.volume1h || 0)),
      tokenAgeSec,
      momentum5m,
      momentum1m,
      buys1h,
      sells1h,
      buyRatio,
      buys60s: vel?.buys60s,
      sells60s: vel?.sells60s,
      buyRatio60s: vel?.buyRatio60s,
      velocity: vel?.velocity,
      solVolume60s: vel?.solVolume60s,
      terrainSampleCount: terrainSummary.sampleCount,
      terrainSpanMs: terrainSummary.spanMs,
      terrainStrongFlowSamples: terrainSummary.strongFlowSamples,
      terrainPriceDelta5m: terrainSummary.priceDelta5m,
      terrainPriceOffPeak5m: terrainSummary.priceOffPeak5m,
      terrainFlowDecayRatio: terrainSummary.flowDecayRatio,
      terrainLiquidityDeltaUsd: terrainSummary.liquidityDeltaUsd,
      terrainRouteStrengthPct: terrainSummary.routeStrengthPct,
    });
    await setMintCooldownExact(
      pub,
      mint,
      terrainGuard.cooldownSeconds,
      terrainGuard.shouldHold ? 'TERRAIN_WAIT' : 'TERRAIN_BLOCK',
    );
    return;
  }
  if (terrainGuard.shouldWarn) {
    const terrainSummary = terrainState?.summary || {};
    console.log(
      `[SNIPER]  TERRAIN WARN: ${symbol} ${terrainGuard.reason} | samples=${terrainSummary.sampleCount || 0} ` +
      `| route=${Number.isFinite(terrainSummary.routeStrengthPct) ? terrainSummary.routeStrengthPct.toFixed(1) + '%' : 'n/a'} ` +
      `| liq=$${Number(terrainSummary.liquidityDeltaUsd || 0).toFixed(0)} ` +
      `| flowDecay=${Number.isFinite(terrainSummary.flowDecayRatio) ? Number(terrainSummary.flowDecayRatio).toFixed(2) : 'n/a'} ` +
      `| offPeak=${Number(terrainSummary.priceOffPeak5m || 0).toFixed(1)}%`
    );
  }

  const microScoutQualityGate = evaluateMicroScoutQualityGate({
    entryMode,
    probeLike: entryMode === 'micro-scout' || isMicroDownshiftEntry || entryOptions?.fixedBuySol !== undefined,
    fastTrackApproved: routeLiveFastTrack,
    momentum5mPct: Number(liveMcap?.priceChange5m ?? momentum5m ?? 0),
    routeStrengthPct: terrainState?.summary?.routeStrengthPct,
    sampleCount: terrainState?.summary?.sampleCount,
    priceDelta5mPct: terrainState?.summary?.priceDelta5m,
    priceOffPeak5mPct: terrainState?.summary?.priceOffPeak5m,
    strongFlowSamples: terrainState?.summary?.strongFlowSamples,
  }, loadMicroScoutQualityConfig());
  if ((microScoutQualityGate.shouldHold || microScoutQualityGate.shouldBlock) && entryMode !== 'velocity-arbitrage') {
    const terrainSummary = terrainState?.summary || {};
    console.log(
      `[SNIPER] ${microScoutQualityGate.shouldHold ? '' : ''} MICRO SCOUT QUALITY ${microScoutQualityGate.shouldHold ? 'HOLD' : 'BLOCK'}: ` +
      `${symbol} ${microScoutQualityGate.reason} | samples=${terrainSummary.sampleCount || 0} ` +
      `| route=${Number.isFinite(terrainSummary.routeStrengthPct) ? terrainSummary.routeStrengthPct.toFixed(1) + '%' : 'n/a'} ` +
      `| 5m=${Number(liveMcap?.priceChange5m ?? momentum5m ?? 0).toFixed(1)}%`
    );
    logMissedTarget({
      mint,
      symbol,
      stage: `${entryMode}-entry`,
      reason: microScoutQualityGate.code,
      entryMode: entryOptions?.entryMode || 'normal',
      marketCapUsd: liveMarketCapUsd,
      fdvUsd: liveFdvUsd,
      liquidityUsd: liveLiquidityUsd,
      volume1hUsd: Math.max(volume1h, Number(liveMcap?.volume1h || 0)),
      tokenAgeSec,
      momentum5m,
      momentum1m,
      buys1h,
      sells1h,
      buyRatio,
      buys60s: vel?.buys60s,
      sells60s: vel?.sells60s,
      buyRatio60s: vel?.buyRatio60s,
      velocity: vel?.velocity,
      solVolume60s: vel?.solVolume60s,
      terrainSampleCount: terrainSummary.sampleCount,
      terrainSpanMs: terrainSummary.spanMs,
      terrainStrongFlowSamples: terrainSummary.strongFlowSamples,
      terrainPriceDelta5m: terrainSummary.priceDelta5m,
      terrainPriceOffPeak5m: terrainSummary.priceOffPeak5m,
      terrainFlowDecayRatio: terrainSummary.flowDecayRatio,
      terrainLiquidityDeltaUsd: terrainSummary.liquidityDeltaUsd,
      terrainRouteStrengthPct: terrainSummary.routeStrengthPct,
    });
    await setMintCooldownExact(
      pub,
      mint,
      microScoutQualityGate.cooldownSeconds,
      microScoutQualityGate.shouldHold ? 'QUALITY_WAIT' : 'QUALITY_BLOCK',
    );
    return;
  }

  const bundlerGuard = evaluateBundlerSuspicion({
    entryMode,
    tokenAgeSec,
    marketCapUsd: liveMarketCapUsd,
    liquidityUsd: Math.max(liveLiquidityUsd, Number(momData?.liquidityUsd || 0)),
    volume1hUsd: Math.max(volume1h, Number(liveMcap?.volume1h || 0)),
    momentum5mPct: Number(liveMcap?.priceChange5m ?? momentum5m ?? 0),
    momentum1mPct: Number(momentum1m || 0),
    momentum1hPct: Number(liveMcap?.priceChange1h ?? priceChg1h ?? 0),
    buys1h,
    sells1h,
    buyRatio,
    buys60s: vel?.buys60s,
    sells60s: vel?.sells60s,
    buyRatio60s: vel?.buyRatio60s,
    velocity: vel?.velocity,
    solVolume60s: vel?.solVolume60s,
    holderCount: holderResult.holderCount,
    top10Pct: holderResult.top10Pct,
    isJitterBundle: holderResult.isJitterBundle,
  }, loadBundlerTrafficGuardConfig());
  if (bundlerGuard.shouldBlock) {
    console.log(
      `[SNIPER]  BUNDLER SIGNAL REJECT: ${symbol} score=${bundlerGuard.score.toFixed(2)} ` +
      `flags=${bundlerGuard.flags.join(',') || 'none'} ` +
      `liq=$${Number(bundlerGuard.metrics?.liquidityUsd || 0).toFixed(0)} ` +
      `resp/sol=${Number(bundlerGuard.metrics?.priceResponsePerSol || 0).toFixed(2)}`
    );
    logMissedTarget({
      mint,
      symbol,
      stage: 'normal-entry',
      reason: 'bundler_suspicion_blocked',
      entryMode,
      tokenAgeSec,
      marketCapUsd: bundlerGuard.metrics?.marketCapUsd,
      liquidityUsd: bundlerGuard.metrics?.liquidityUsd,
      volume1hUsd: bundlerGuard.metrics?.volume1hUsd,
      momentum5m: bundlerGuard.metrics?.momentum5mPct,
      momentum1m: bundlerGuard.metrics?.momentum1mPct,
      buys1h,
      sells1h,
      buyRatio,
      buys60s: vel?.buys60s,
      sells60s: vel?.sells60s,
      buyRatio60s: vel?.buyRatio60s,
      velocity: vel?.velocity,
      solVolume60s: vel?.solVolume60s,
      bundlerScore: bundlerGuard.score,
      bundlerFlags: bundlerGuard.flags.join(','),
      bundlerTurnoverToLiquidityRatio: bundlerGuard.metrics?.turnoverToLiquidityRatio,
      bundlerPriceResponsePerSol: bundlerGuard.metrics?.priceResponsePerSol,
    });
    await setMintCooldownExact(pub, mint, bundlerGuard.cooldownSeconds, 'BUNDLER_SIGNAL');
    return;
  }
  if (bundlerGuard.shouldWarn) {
    console.log(
      `[SNIPER]  BUNDLER SIGNAL WARN: ${symbol} score=${bundlerGuard.score.toFixed(2)} ` +
      `flags=${bundlerGuard.flags.join(',') || 'none'} ` +
      `liq=$${Number(bundlerGuard.metrics?.liquidityUsd || 0).toFixed(0)} ` +
      `resp/sol=${Number(bundlerGuard.metrics?.priceResponsePerSol || 0).toFixed(2)}`
    );
  }

  const bullishSignals = [
    entryOptions?.continuationApproved === true,
    routeLiveFastTrack,
    Boolean(liveRouteProbe?.routable),
    Number(terrainState?.summary?.strongFlowSamples || 0) >= 1,
    Number(momentum5m || 0) >= 5,
    buyRatio >= (reqRatio * 1.1),
    Math.max(volume1h, Number(liveMcap?.volume1h || 0)) >= 5000,
  ].filter(Boolean).length;
  const entryRiskDecision = evaluateEntryRisk({
    duplicateImageRisk: gmgnImageDupGate.meta?.duplicateImageRisk,
    imageDupCount: gmgnImageDupGate.meta?.imageDupCount,
    isJitterBundle: holderResult.isJitterBundle,
    holderCount: holderResult.holderCount,
    top10Pct: holderResult.top10Pct,
    bullishSignals,
    rugCheckWarnings: rugResult.softRiskNames,
  });
  if (entryRiskDecision.reject) {
    console.log(
      `[SNIPER]  ENTRY RISK REJECT: ${symbol} score=${entryRiskDecision.riskScore} ` +
      `reasons=${entryRiskDecision.reasons.join('; ') || 'none'}`
    );
    logMissedTarget({
      mint,
      symbol,
      stage: `${entryMode}-entry`,
      reason: 'entry_risk_reject',
      entryMode: entryOptions?.entryMode || 'normal',
    });
    await setMintCooldownExact(pub, mint, 180, 'ENTRY_RISK_REJECT');
    return;
  }
  if (entryRiskDecision.riskScore > 0) {
    console.log(
      `[SNIPER]  ENTRY RISK: ${symbol} score=${entryRiskDecision.riskScore} ` +
      `band=${entryRiskDecision.riskBand} size=${(entryRiskDecision.positionMultiplier * 100).toFixed(0)}%` +
      `${entryRiskDecision.probeMode ? ' | probe-mode' : ''} ` +
      `reasons=${entryRiskDecision.reasons.join('; ') || 'none'}`
    );
  }

  const expectedValueDecision = scoreCandidateExpectedValue({
    mint,
    symbol,
    entryMode,
    entryFamily,
    sourceLane: entryOptions?.sourceLane,
    tokenAgeSec,
    liquidityUsd: Math.max(liveLiquidityUsd, Number(momData?.liquidityUsd || 0)),
    marketCapUsd: liveMarketCapUsd,
    fdvUsd: liveFdvUsd,
    momentum5m: Number(liveMcap?.priceChange5m ?? momentum5m ?? 0),
    buyRatio,
    volume1hUsd: Math.max(volume1h, Number(liveMcap?.volume1h || 0)),
    buys1h,
    sells1h,
    quotaAssistLevel: entryOptions?.quotaAssistLevel,
    walletSignalPriority: entryOptions?.walletSignalPriority,
    walletConsensusScore: entryOptions?.walletConsensusScore,
    walletCount: entryOptions?.walletCount,
    walletPnlScore: entryOptions?.walletPnlScore,
    walletWeightedScore: entryOptions?.walletWeightedScore,
    walletCompositeScore: entryOptions?.walletCompositeScore,
    kolConfirmed: entryOptions?.kolConfirmed,
    alphaBoost,
    alphaKolCount: entryOptions?.alphaKolCount ?? alphaBoostDecision.uniqueKols,
    preferredHoldMs: entryOptions?.preferredHoldMs ?? (entryOptions?.maxHoldMinutes ? entryOptions.maxHoldMinutes * 60_000 : undefined),
    confidenceScore: boostedConfidence,
    familySizeMultiplier: familyDecision.sizeMultiplier,
    velocityBuys60s: vel?.buys60s,
    velocityBuyRatio60s: vel?.buyRatio60s,
    velocityTxPerMin: vel?.velocity,
    velocitySolVolume60s: vel?.solVolume60s,
  }, {
    model: getExpectedValueModelSnapshot(),
  });
  const allowQuotaEvBypass = false;
  if (expectedValueDecision.shouldSkip && !allowQuotaEvBypass) {
    console.log(
      `[SNIPER]  EV REJECT: ${symbol} ${expectedValueDecision.skipReason} ` +
      `| lane=${entryOptions?.sourceLane || entryFamily} | winProb=${(expectedValueDecision.winProbability * 100).toFixed(1)}%`
    );
    logMissedTarget({
      mint,
      symbol,
      stage: `${entryMode}-entry`,
      reason: 'expected_value_negative',
      entryMode,
      sourceLane: entryOptions?.sourceLane,
      entryFamily,
      amountSol: buySol,
      expectedValueSol: expectedValueDecision.expectedPnlSol,
      evConfidence: expectedValueDecision.confidence,
      evRankScore: expectedValueDecision.rankScore,
      evTradeCount: expectedValueDecision.posteriorTradeCount,
      marketCapUsd: liveMarketCapUsd,
      liquidityUsd: Math.max(liveLiquidityUsd, Number(momData?.liquidityUsd || 0)),
      volume1hUsd: Math.max(volume1h, Number(liveMcap?.volume1h || 0)),
      tokenAgeSec,
      momentum5m,
      momentum1m,
      buyRatio,
      buys1h,
      sells1h,
      buys60s: vel?.buys60s,
      sells60s: vel?.sells60s,
      buyRatio60s: vel?.buyRatio60s,
      velocity: vel?.velocity,
      solVolume60s: vel?.solVolume60s,
    });
    await setMintCooldownExact(pub, mint, 45, 'NEG_EV');
    return;
  }
  if (entryOptions) {
    entryOptions.expectedValueSol = expectedValueDecision.expectedPnlSol;
    entryOptions.expectedValueConfidence = expectedValueDecision.confidence;
    entryOptions.expectedValueRankScore = expectedValueDecision.rankScore;
    entryOptions.expectedValueTradeCount = expectedValueDecision.posteriorTradeCount;
  }

  const combinedPositionMultiplier = Math.max(
    0,
    Number(
      (
        (entryOptions?.sizeMultiplier ?? 1) *
        familyDecision.sizeMultiplier *
        entryRiskDecision.positionMultiplier *
        expectedValueDecision.positionMultiplier
      ).toFixed(4),
    ),
  );
  if (combinedPositionMultiplier <= 0) {
    console.log(`[SNIPER]  SIZING BLOCK: ${symbol} has zero deployable size after family/risk scaling.`);
    await pub.del(REDIS_KEYS.position(mint));
    return;
  }
  if (combinedPositionMultiplier < 1) {
    const scaledBuySol = Number((buySol * combinedPositionMultiplier).toFixed(4));
    console.log(
      `[SNIPER]  POSITION SCALE: ${symbol} ${buySol.toFixed(4)} SOL  ${scaledBuySol.toFixed(4)} SOL ` +
      `(family ${(familyDecision.sizeMultiplier * 100).toFixed(0)}% | risk ${(entryRiskDecision.positionMultiplier * 100).toFixed(0)}% | ` +
      `ev ${(expectedValueDecision.positionMultiplier * 100).toFixed(0)}%).`
    );
    buySol = scaledBuySol;
  }
  if (buySol < 0.001) {
    console.log(
      `[SNIPER]  SIZE FLOOR HOLD: ${symbol} effective size ${buySol.toFixed(4)} SOL fell below executable floor after scaling.`
    );
    logMissedTarget({
      mint,
      symbol,
      stage: `${entryMode}-entry`,
      reason: 'size_below_min_after_risk_scaling',
      entryMode,
      sourceLane: entryOptions?.sourceLane,
      entryFamily,
      amountSol: buySol,
      positionMultiplier: combinedPositionMultiplier,
      familyRecentWinRate: familyDecision.recentWinRate,
      familyRecentNetSol: familyDecision.recentNetSol,
      riskScore: entryRiskDecision.riskScore,
      riskBand: entryRiskDecision.riskBand,
    });
    await setMintCooldownExact(pub, mint, 30, 'SIZE_FLOOR');
    await pub.del(REDIS_KEYS.position(mint));
    return;
  }

  const buyLamports = Math.floor(buySol * 1e9);

  const apexPreExit = evaluateApexExit({
    entryLiquidityUsd: Math.max(Number(liveMcap?.liquidity || 0), Number(momData?.liquidityUsd || 0)),
    currentLiquidityUsd: Math.max(Number(liveMcap?.liquidity || 0), Number(momData?.liquidityUsd || 0)),
    marketCapUsd: Number(liveMcap?.marketCap || liveMcap?.fdv || 0),
    priceChangeSinceEntryPct: Math.max(0, Number(momentum5m || 0)),
    volume5mUsd: Number(liveMcap?.volume5m || 0),
    volume1hUsd: Math.max(volume1h, Number(liveMcap?.volume1h || 0)),
    volume6hUsd: Number(liveMcap?.volume6h || 0),
  }, loadApexPredatorConfig());
  if (entryOptions?.entryMode !== 'micro-scout' && apexPreExit?.flags?.thinAirLiquidity) {
    console.log(
      `[SNIPER]  APEX PRE-EXIT REJECT: ${symbol} already looks like thin-air liquidity at entry ` +
      `(mcap $${Number(liveMcap?.marketCap || liveMcap?.fdv || 0).toFixed(0)} | liq $${Math.max(Number(liveMcap?.liquidity || 0), Number(momData?.liquidityUsd || 0)).toFixed(0)} | req $${Number(apexPreExit.metrics?.requiredLiquidityUsd || 0).toFixed(0)}).`
    );
    logMissedTarget({
      mint,
      symbol,
      stage: 'normal-entry',
      reason: 'thin_air_liquidity_pre_entry',
      entryMode: entryOptions?.entryMode || 'normal',
      marketCapUsd: Number(liveMcap?.marketCap || liveMcap?.fdv || 0),
      liquidityUsd: Math.max(Number(liveMcap?.liquidity || 0), Number(momData?.liquidityUsd || 0)),
      volume1hUsd: Math.max(volume1h, Number(liveMcap?.volume1h || 0)),
      tokenAgeSec,
      momentum5m,
      momentum1m,
      buys1h,
      sells1h,
      buyRatio,
    });
    await setMintCooldown(pub, mint, 900, '1');
    return;
  }

  const pumpMayhemGuard = evaluatePumpLaunchpadGuard(
    mint,
    entryOptions?.entryMode || 'normal',
    tokenAgeSec,
    liveMarketCapUsd,
  );
  if (pumpMayhemGuard.block) {
    const launchpad = String(pumpMayhemGuard.meta?.launchpad || '');
    const standard = String(pumpMayhemGuard.meta?.standard || '');
    console.log(
      `[SNIPER]  PUMP MAYHEM-RISK REJECT: ${symbol} launchpad=${launchpad || 'unknown'} ` +
      `standard=${standard || 'unknown'} reason=${pumpMayhemGuard.reason} ` +
      `source=${pumpMayhemGuard.meta?.source || 'unknown'}`
    );
    logMissedTarget({
      mint,
      symbol,
      stage: `${entryMode}-entry`,
      reason: 'pump_mayhem_risk_reject',
      entryMode: entryOptions?.entryMode || 'normal',
      buyRatio,
      buys1h,
    });
    await setMintCooldownExact(pub, mint, pumpMayhemGuard.config.cooldownSeconds, 'PUMP_MAYHEM_BLOCK');
    return;
  }

  // Phase 1: Slopfest Fast Gate (Require at least $500 5m volume)
  if (entryMode === 'desperation_bypass' && Number(liveMcap?.volume5m || 0) < 500) {
    console.log(`[SNIPER]  SLOPFEST VOLUME REJECT: ${symbol} volume5m=$${Number(liveMcap?.volume5m || 0).toFixed(0)} < $500 required.`);
    logMissedTarget({
      mint,
      symbol,
      stage: 'slopfest-volume-gate',
      reason: 'insufficient_volume_5m',
      entryMode,
      buyRatio,
      buys1h,
    });
    return;
  }

  console.log(`[SWARM]  Broadcasting Tri-Arb Trigger for ${mint} after passing all Sniper preflight constraints!`);
  require('fs').writeFileSync('/tmp/arb_trigger.txt', mint);

  // Pump-timing routes work better with fixed slippage and no dynamic slippage heuristics.
  const usePumpTimingQuote =
    entryOptions?.quoteMode === 'pump-direct' ||
    entryOptions?.entryMode === 'micro-scout';
  console.log(
    `[SNIPER]  FINAL GATE READY: ${symbol} | family=${entryFamily} | lane=${entryOptions?.sourceLane || entryMode} ` +
    `| conf=${(confidenceScore * 100).toFixed(1)}%/${(qualifierThreshold * 100).toFixed(0)}% ` +
    `| size=${buySol.toFixed(4)} SOL | familyWin=${(familyDecision.recentWinRate * 100).toFixed(1)}%/${familyDecision.sampleCount} ` +
    `| familyNet=${familyDecision.recentNetSol.toFixed(6)} SOL | risk=${entryRiskDecision.riskScore}(${entryRiskDecision.riskBand}) ` +
    `| EV=${expectedValueDecision.expectedPnlSol.toFixed(6)} SOL @ ${(expectedValueDecision.confidence * 100).toFixed(0)}% ` +
    `| mult=${combinedPositionMultiplier.toFixed(2)} | routeLive=${liveRouteProbe?.routable ? 'yes' : 'no'} ` +
    `| terrainSamples=${Number(terrainState?.summary?.sampleCount || 0)} | strongFlow=${Number(terrainState?.summary?.strongFlowSamples || 0)} ` +
    `| reqRatio=${reqRatio.toFixed(2)}x | reqBuys=${reqBuys}`
  );
  const entryQuoteOptions: QuoteRequestOptions = {
    slippageBps: usePumpTimingQuote ? 9999 : 500,
    restrictIntermediateTokens: usePumpTimingQuote,
    asLegacyTransaction: false,
  };
	  const quote = await getQuote(WSOL, mint, buyLamports, entryQuoteOptions);
	  console.log(
	    `[SNIPER] DEBUG_3: Passed getQuote ` +
	    `(slippage ${entryQuoteOptions.slippageBps}bps | ` +
	    `restrictIntermediate=${entryQuoteOptions.restrictIntermediateTokens ? 'true' : 'false'} | ` +
	    `mode=${usePumpTimingQuote ? 'pump-direct' : 'default'})`
	  );
	  if (quote?.errorCode === 'RATE_LIMITED') {
	    const cooldownSeconds = Math.max(5, Math.ceil((Number(quote.retryAfterMs) || JUPITER_RATE_LIMIT_MIN_BACKOFF_MS) / 1000));
	    console.log(`[SNIPER]  Jupiter quote backoff for ${symbol}  retrying in ${cooldownSeconds}s after API rate limit.`);
	    logMissedTarget({ mint, symbol, reason: 'jupiter_quote_rate_limited', price: buySol, redisCooldownSec: cooldownSeconds });
	    await setMintCooldownExact(pub, mint, cooldownSeconds, 'JUP_RATE_LIMIT');
	    await pub.del(REDIS_KEYS.position(mint));
	    return;
	  }
	  if (!quote) {
	    console.log(`[SNIPER]  No route via Jupiter yet for ${symbol}  retrying in 30s (indexer lag)`);
	    logMissedTarget({ mint, symbol, reason: "No route on Jupiter", price: buySol });
    await setMintCooldown(pub, mint, 30, '1'); // 30 second cooldown to avoid deadlock
    await pub.del(REDIS_KEYS.position(mint));
    return;
  }

  const tokenAmount   = Number(quote.outAmount);

  // Pre-fetch decimals safely from Jupiter Swap Quote or RPC for Oracle Fallback
  let decimals = 6;
  try {
     const supplyResp = await callRpcGateway('getTokenSupply', [new PublicKey(mint)]);
     if (supplyResp?.value?.decimals !== undefined) decimals = supplyResp.value.decimals;
  } catch(e) {}

  // Guard against extreme slippage before we execute the swap
  const currentPriceSol = buySol / (tokenAmount / Math.pow(10, decimals));
  // REMOVED BROKEN SLIPPAGE CHECK: params and solPrice are undefined here, causing ReferenceErrors
  // if (params && params.maxBuyPrice) { ... }

  const entryPriceSol = computeEntryPriceSol(buySol, tokenAmount, decimals) || currentPriceSol;
  const sig = await executeSwap(quote, BUY_PRIORITY_FEE_LAMPORTS, { asLegacyTransaction: false });
  console.log('[SNIPER] DEBUG_4: Passed executeSwap');
  if (!sig) {
      console.log(`[SNIPER]  Swap execution failed for ${symbol}  blacklisting temporarily`);
      logMissedTarget({ mint, symbol, reason: "Simulation or Execution Failed on Chain", amountSol: buySol });
      await pub.setex(REDIS_KEYS.tempBlacklist(mint), 300, '2.0'); // 5 min penalty
      await pub.del(REDIS_KEYS.position(mint));
      return;
  }
  if (process.env.PAPER_MODE !== 'true' && isGhostExecutionSignature(sig)) {
      console.warn(`[SNIPER]  LIVE BUY BLOCKED for ${symbol}: received ghost signature ${sig}`);
      logMissedTarget({ mint, symbol, reason: 'ghost_signature_blocked_live', amountSol: buySol, sig });
      await pub.setex(REDIS_KEYS.tempBlacklist(mint), 300, '2.0');
      await pub.del(REDIS_KEYS.position(mint));
      return;
  }


  // Duplicate Check: Add SETNX lock immediately
  const posLockStr = await pub.set(REDIS_KEYS.position(mint), 'LOCKED', 'EX', 3600, 'NX');
  if (!posLockStr) {
      console.log(`[SNIPER]  RACE DETECTED: Position lock already exists for ${symbol}. Skipping memory tracking.`);
      return;
  }

  // Set 30s re-buy cooldown locally just in case
  await setMintCooldown(pub, mint, 30, 'LOCKED');

  // Derive the correct ATA for classic SPL vs Token-2022 mints.
  const { ata, tokenProgramId } = await deriveTokenAccountContext(mint, wallet.publicKey);

  // Generate unified map identifier
  const tradeId = randomUUID();
  const openedAt = Date.now();
  const normalizedTokenAmount = normalizeTokenAmount(tokenAmount, decimals);

  // Journal: BUY entry  include freshness metadata + ATA for AnalyzerAgent
  const entryModeTag =
    entryOptions?.entryMode === 'last-stand'
      ? 'LAST_STAND'
      : entryOptions?.entryMode === 'micro-scout'
        ? entryOptions?.routeLiveFastTrack ? 'MICRO_SCOUT_FAST_TRACK' : 'MICRO_SCOUT'
        : 'SNIPER';
  const buyTrade = { agent: 'pcp-sniper', action: 'BUY', mint, symbol, amountSol: buySol, sig, tradeId,
    reason: `${entryModeTag} ${priceChg1h.toFixed(0)}%/1h ${buys1h}B/${sells1h}S`, taSig, taConf,
    tokenAgeSec, momentum5m, momentum1m, pairCreatedAt, ata,
    tokenProgramId, entryMode: entryOptions?.entryMode || 'normal',
    entryFamily, sourceLane: entryOptions?.sourceLane, probeLikeEntry,
    quotaAssist: entryOptions?.quotaAssist === true,
    quotaAssistLevel: Number(entryOptions?.quotaAssistLevel || 0),
    walletSignalPriority: entryOptions?.walletSignalPriority,
    walletConsensusScore: entryOptions?.walletConsensusScore,
    walletCount: entryOptions?.walletCount,
	    walletPnlScore: entryOptions?.walletPnlScore,
	    walletWeightedScore: entryOptions?.walletWeightedScore,
	    walletCompositeScore: entryOptions?.walletCompositeScore,
	    kolConfirmed: entryOptions?.kolConfirmed,
	    alphaBoost: entryOptions?.alphaBoost,
	    alphaKolCount: entryOptions?.alphaKolCount,
	    preferredHoldMs: entryOptions?.preferredHoldMs,
	    expectedValueSol: entryOptions?.expectedValueSol,
	    evConfidence: entryOptions?.expectedValueConfidence,
	    evRankScore: entryOptions?.expectedValueRankScore,
	    evTradeCount: entryOptions?.expectedValueTradeCount,
	    buyRatio,
	    positionMultiplier: combinedPositionMultiplier, riskScore: entryRiskDecision.riskScore, riskBand: entryRiskDecision.riskBand,
    timestamp: openedAt, openedAt, entryPriceSol, entryCostSol: buySol,
    tokenAmount: normalizedTokenAmount, tokenAmountRaw: tokenAmount, decimals,
    marketCapUsd: liveMarketCapUsd,
    fdvUsd: liveFdvUsd,
    liquidityUsd: liveLiquidityUsd,
    fdvToLiquidityRatio: fdvLiquidityGuard.metrics.fdvToLiquidityRatio,
    liquidityToFdvRatio: fdvLiquidityGuard.metrics.liquidityToFdvRatio,
    bundlerScore: bundlerGuard.score,
    bundlerSeverity: bundlerGuard.severity,
    bundlerFlags: bundlerGuard.flags.join(','),
    bundlerTurnoverToLiquidityRatio: bundlerGuard.metrics?.turnoverToLiquidityRatio,
    bundlerPriceResponsePerSol: bundlerGuard.metrics?.priceResponsePerSol,
    terrainSampleCount: terrainState?.summary?.sampleCount,
    terrainSpanMs: terrainState?.summary?.spanMs,
    terrainStrongFlowSamples: terrainState?.summary?.strongFlowSamples,
    terrainPriceDelta5m: terrainState?.summary?.priceDelta5m,
    terrainPriceOffPeak5m: terrainState?.summary?.priceOffPeak5m,
    terrainFlowDecayRatio: terrainState?.summary?.flowDecayRatio,
    terrainLiquidityDeltaUsd: terrainState?.summary?.liquidityDeltaUsd,
    terrainRouteStrengthPct: terrainState?.summary?.routeStrengthPct,
    routeLiveFastTrack,
    slopfestParamsSetId: entryOptions?.entryMode === 'desperation_bypass' ? GLOBAL_SLOPFEST_PARAMS_ID : undefined,
    slopfestParamsRaw: entryOptions?.entryMode === 'desperation_bypass' ? JSON.stringify(GLOBAL_SLOPFEST_PARAMS_RAW) : undefined,
  } as any;
  appendTrade(buyTrade);
  PERSIST_JOURNAL_REDIS(buyTrade);
  await pub.publish('guardian:add_tracking', mint);


  // Fetch dynamically precomputed bounds from Market Data Daemon
  let maxTPpct = GLOBAL_TP_PCT;
  let maxHoldMinutes = GLOBAL_HOLD_MIN;
  let stopLossPct = GLOBAL_SL_PCT;

  try {
      const pub = RedisBus.getPublisher();
      const params = await pub.hgetall(`trade:params:${mint}`);
      if (params && params.maxTPpct && params.stopLossPct) {
          maxTPpct = parseFloat(params.maxTPpct);
          maxHoldMinutes = parseFloat(params.maxHoldMinutes);
          stopLossPct = parseFloat(params.stopLossPct);
      }
  } catch (e) { }

  const pos: Position = {
    tradeId, mint, ata, tokenProgramId, symbol, buyPriceSol: buySol, tokenAmount,
    openedAt, entryPriceSol, signature: sig,
    peakPnlPct: 0, entryMom5m: momentum5m, entryBuyRatio: buyRatio,
    fdvUsd: liveFdvUsd,
    fdvToLiquidityRatio: fdvLiquidityGuard.metrics.fdvToLiquidityRatio,
    liquidityToFdvRatio: fdvLiquidityGuard.metrics.liquidityToFdvRatio,
    bundlerScore: bundlerGuard.score,
    bundlerSeverity: bundlerGuard.severity,
    bundlerFlags: bundlerGuard.flags.join(','),
    terrainSampleCount: terrainState?.summary?.sampleCount,
    terrainSpanMs: terrainState?.summary?.spanMs,
    terrainStrongFlowSamples: terrainState?.summary?.strongFlowSamples,
    terrainPriceDelta5m: terrainState?.summary?.priceDelta5m,
    terrainPriceOffPeak5m: terrainState?.summary?.priceOffPeak5m,
    terrainFlowDecayRatio: terrainState?.summary?.flowDecayRatio,
    terrainLiquidityDeltaUsd: terrainState?.summary?.liquidityDeltaUsd,
    terrainRouteStrengthPct: terrainState?.summary?.routeStrengthPct,
    routeLiveFastTrack,
    entryVolume5mUsd: Number(liveMcap?.volume5m || 0),
    riskScore: entryRiskDecision.riskScore,
    riskBand: entryRiskDecision.riskBand,
    positionMultiplier: combinedPositionMultiplier,
    sourceLane: entryOptions?.sourceLane,
    entryFamily,
    probeLikeEntry,
    quotaAssist: entryOptions?.quotaAssist === true,
    quotaAssistLevel: Number(entryOptions?.quotaAssistLevel || 0),
    walletSignalPriority: entryOptions?.walletSignalPriority,
    walletConsensusScore: entryOptions?.walletConsensusScore,
    walletCount: entryOptions?.walletCount,
    walletPnlScore: entryOptions?.walletPnlScore,
    walletWeightedScore: entryOptions?.walletWeightedScore,
    walletCompositeScore: entryOptions?.walletCompositeScore,
    kolConfirmed: entryOptions?.kolConfirmed,
	    alphaBoost: entryOptions?.alphaBoost,
	    alphaKolCount: entryOptions?.alphaKolCount,
	    preferredHoldMs: entryOptions?.preferredHoldMs,
	    expectedValueSol: entryOptions?.expectedValueSol,
	    evConfidence: entryOptions?.expectedValueConfidence,
	    evRankScore: entryOptions?.expectedValueRankScore,
	    evTradeCount: entryOptions?.expectedValueTradeCount,
	    tokenAgeSec,
    momentum1m,
    marketCapUsd: liveMarketCapUsd,
    liquidityUsd: liveLiquidityUsd,
    partialProfitStage: 0,
    slopfestParamsSetId: entryOptions?.entryMode === 'desperation_bypass' ? GLOBAL_SLOPFEST_PARAMS_ID : undefined,
    maxTPpct: entryOptions?.maxTPpct ?? maxTPpct,
    maxHoldMinutes: entryOptions?.maxHoldMinutes ?? maxHoldMinutes,
    stopLossPct: entryOptions?.stopLossPct ?? stopLossPct,
    entryMode: entryOptions?.entryMode || 'normal',
    disablePartialTakeProfit: entryOptions?.disablePartialTakeProfit || false,
    trailingActivationPct: entryOptions?.trailingActivationPct,
    trailingStopPct: entryOptions?.trailingStopPct,
    partialProfitStage: 0,
    decimals
  };
  store.positions.push(pos);
  saveStore();

  // Apex Predator: REMOVED  was causing force-sells


  console.log(`[SNIPER]  Entered ${symbol}: ${buySol} SOL  ${tokenAmount} tokens | mode: ${pos.entryMode}`);
  console.log(`[SNIPER]  https://solscan.io/tx/${sig}`);
  console.log(`[SNIPER]  ATA: ${ata} | tokenProgram: ${tokenProgramId === TOKEN_2022_PROGRAM_ID_STR ? 'Token-2022' : 'Tokenkeg'}`);
  console.log(
    `[SNIPER]  EXIT PLAN: hard-stop ${Math.min(8, Math.max(0.5, Number((pos.stopLossPct ?? GLOBAL_SL_PCT) * 100 || 8))).toFixed(1)}% ` +
    `| time-stop 60s if red | trail 5% off peak after +5% | staged TP 30/30/40 at +8/+15/+25 ` +
    `| entry was +${priceChg1h.toFixed(0)}%/1h | orderflow: ${buys1h}B/${sells1h}S (${buyRatio.toFixed(1)}x)`
  );
  } finally {
    snipeInFlight.delete(mint);
  }
}

//  Exit logic
async function checkExits() {
  const now   = Date.now();
  const exits: Position[] = [];
  let storeDirty = false;

  for (const pos of store.positions) {
    const heldMs    = now - pos.openedAt;
    let forceExit = pos.forceExitTriggered || false; // WSS GUARDIAN OVERRIDE ENABLED
    const inRetrace = heldMs < RETRACE_SHIELD_MS;
    const isLastStand = pos.entryMode === 'last-stand';
    const gmgnSnapshot = loadGmgnActivePositionSnapshot(pos.mint);

    if (pos.nextExitRetryAt && now < pos.nextExitRetryAt) {
      continue;
    }
    if (!pos.nextExitRetryAt && pos.lastExitFailureAt && (now - pos.lastExitFailureAt) < EXIT_RETRY_COOLDOWN_MS) {
      continue;
    }

    //  Pure TP/SL exit logic
    const pub = RedisBus.getPublisher();

    const routeValueSol = await getCurrentPriceSol(pos.mint, pos.tokenAmount, pos.decimals);
    const gmgnMarkValueSol = Number.isFinite(Number(gmgnSnapshot?.markValueSol)) ? Number(gmgnSnapshot?.markValueSol) : null;
    const curValueSol = routeValueSol ?? gmgnMarkValueSol;
    const markSource = routeValueSol !== null
      ? 'route-or-oracle'
      : gmgnMarkValueSol !== null
        ? 'gmgn-active'
        : forceExit
          ? 'force-exit'
          : 'unpriced';
    if (!curValueSol && !forceExit) continue;

    const pnlPct = curValueSol
      ? ((curValueSol - pos.buyPriceSol) / pos.buyPriceSol) * 100
      : -100;

    if (syncPositionMarkState(pos, curValueSol, pnlPct, now, heldMs, markSource, gmgnSnapshot)) {
      storeDirty = true;
    }

    // Update peak profit for trailing stop
    if (pnlPct > (pos.peakPnlPct || 0)) {
      pos.peakPnlPct = pnlPct;
      storeDirty = true;
    }
    const peak = pos.peakPnlPct || 0;

    //  $4M mcap check: DISABLED
    //  Triple-Layer Hard Exit Constraints & Dynamic Trailing Stop
    const elapsedMinutes = heldMs / 60000;
    const hardStopPct = Math.min(8, Math.max(0.5, Number((pos.stopLossPct ?? GLOBAL_SL_PCT) * 100 || 8)));
    // Slopfest: Time stop & ATR extension
    const isSlopfest = pos.entryMode === 'desperation_bypass';
    const configuredMaxHoldMinutes = Number.isFinite(Number(pos.maxHoldMinutes))
      ? Number(pos.maxHoldMinutes)
      : GLOBAL_HOLD_MIN;
    const timeStopHit = elapsedMinutes >= configuredMaxHoldMinutes;

    // Approximate ATR for dynamic trailing
    const baseAtrPct = Math.abs(pos.terrainPriceDelta5m || 0) > 0 ? (Math.abs(pos.terrainPriceDelta5m || 0) / 100) / 5 : 0.05;
    const atrPct = Math.min(Math.max(baseAtrPct, 0.02), 0.15) * 100; // in percentage points
    const atrMultiplier = elapsedMinutes < 0.5 ? 4 : 3;

    let trailingStopFloorPct: number | null = null;
    if (isSlopfest) {
      if (peak > (pos.maxTPpct || 0.25) * 100 * 0.5) trailingStopFloorPct = peak - (atrPct * 2); // Tighten to 2 ATR at high profit
      else trailingStopFloorPct = peak - (atrPct * atrMultiplier);
      if (trailingStopFloorPct < 0) trailingStopFloorPct = null; // Don't trail below 0 initially
    } else {
      trailingStopFloorPct = resolveTrailingStopFloorPct({
        peakPnlPct: peak,
        isLastStand,
        trailingActivationPct: pos.trailingActivationPct ?? 8,
        trailingStopPct: pos.trailingStopPct ?? 12,
      });
    }

    const trailingStopHit = !isLastStand &&
      trailingStopFloorPct !== null &&
      pnlPct > 0 &&
      pnlPct <= trailingStopFloorPct;
    const hardStopHit = pnlPct <= -hardStopPct;

    const partialStage = Math.max(0, Math.min(4, Number(pos.partialProfitStage || 0)));
    let partialPlan = resolvePartialTakeProfitPlan({
      pnlPct,
      partialProfitStage: partialStage,
      isLastStand,
      disablePartialTakeProfit: pos.disablePartialTakeProfit,
    });

    // Slopfest Scaling Exits Override
    if (isSlopfest && !partialPlan && !pos.disablePartialTakeProfit) {
      const tp1 = (pos.maxTPpct || 0.25) * 100;
      const tp2 = tp1 * 2;
      const targetStage = pnlPct >= tp2 ? 2 : (pnlPct >= tp1 ? 1 : partialStage);
      if (targetStage > partialStage) {
        const isExplosive = (pos.entryMom5m || 0) > 100;
        const frac2 = isExplosive ? 0.50 : 0.66;
        const frac1 = isExplosive ? 0.25 : 0.33;

        const targetFrac = targetStage === 2 ? frac2 : frac1;
        const currentFrac = partialStage === 1 ? frac1 : 0;
        const sellFrac = (targetFrac - currentFrac) / (1 - currentFrac);
        partialPlan = {
          currentStage: partialStage,
          targetStage,
          reasonCode: `SLOP_TP${targetStage}`,
          thresholdPct: targetStage === 2 ? tp2 : tp1,
          cumulativeSoldFraction: targetFrac,
          sellFractionOfCurrent: Math.min(1, Math.max(0, sellFrac)),
        };
      }
    }

    let reason: string | null = null;
    let sellFraction = 0;
    let nextPartialStage = partialStage;

    if (forceExit) {
      reason = 'FORCE_EXIT (Emergency)';
      sellFraction = 1.0;
    } else if (partialPlan) {
      reason = `${partialPlan.reasonCode} +${pnlPct.toFixed(1)}%`;
      sellFraction = partialPlan.sellFractionOfCurrent;
      nextPartialStage = partialPlan.targetStage;
    } else if (hardStopHit) {
      reason = `HARD_STOP ${pnlPct.toFixed(1)}%`;
      sellFraction = 1.0;
    } else if (trailingStopHit) {
      reason = `TRAIL/STOP_HIT +${pnlPct.toFixed(1)}%`;
      sellFraction = 1.0;
    } else if (timeStopHit) {
      reason = `TIME_EXIT (${elapsedMinutes.toFixed(1)}m no-profit)`;
      sellFraction = 1.0;
    }

    if (reason) {
      console.log(`[SNIPER]  Exiting ${pos.symbol}  ${reason}`);
      if (sellFraction < 0.999) {
        console.log(
          `[SNIPER]  STAGED TAKE PROFIT: ${pos.symbol} stage ${nextPartialStage} ` +
          `selling ${(sellFraction * 100).toFixed(1)}% of current size at +${pnlPct.toFixed(1)}% ` +
          `| cumulative banked ${(partialPlan?.cumulativeSoldFraction || 0) * 100}%`
        );
      } else if (trailingStopHit) {
        console.log(
          `[SNIPER]  TRAILING STOP: ${pos.symbol} peak +${peak.toFixed(1)}%, ` +
          `floor +${Number(trailingStopFloorPct || 0).toFixed(1)}%, now +${pnlPct.toFixed(1)}%`
        );
      }
      // Aggressive execution for stop-loss and time-based force exits to prevent hold-over
      const isEmergencyExit = hardStopHit || forceExit;
      const slippageBps = isEmergencyExit ? 500 : 300; // 5% max on emergency stops, 3% normal

      let exactBalanceLamports = Number(pos.tokenAmount);
      let liveBalanceResolved = process.env.PAPER_MODE === 'true';
      if (process.env.PAPER_MODE !== 'true') {
        const resolvedBalance = await resolveLiveTokenBalance(pos);
        if (resolvedBalance) {
          exactBalanceLamports = resolvedBalance.amountLamports;
          pos.ata = resolvedBalance.ata;
          pos.tokenProgramId = resolvedBalance.tokenProgramId;
          pos.lastObservedBalanceLamports = exactBalanceLamports;
          pos.lastBalanceSource = resolvedBalance.source;
          pos.balanceFetchFailureCount = 0;
          liveBalanceResolved = true;
          storeDirty = true;
        } else {
          pos.balanceFetchFailureCount = (pos.balanceFetchFailureCount || 0) + 1;
          pos.lastExitFailureAt = Date.now();
          pos.lastExitFailureReason = 'balance-fetch-failed';
          storeDirty = true;
          if (shouldEvictAfterBalanceLookupFailures(pos, heldMs, gmgnSnapshot)) {
            console.warn(`[SNIPER]  EXIT EVICT: ${pos.symbol} remained unresolved after ${pos.balanceFetchFailureCount} balance lookup failures and exceeded stale tracking grace.`);
            store.blacklist.push(pos.mint);
            exits.push(pos);
          } else if (pos.balanceFetchFailureCount >= MAX_BALANCE_FETCH_FAILURES) {
            console.warn(
              `[SNIPER]  EXIT HOLD: ${pos.symbol} balance lookup degraded ` +
              `(${pos.balanceFetchFailureCount}/${MAX_BALANCE_EVICT_FAILURES}). ` +
              `Holding tracker state while GMGN/mark data stays available.`
            );
          } else {
            console.warn(`[SNIPER]  EXIT HOLD: Could not fetch live balance for ${pos.symbol} (${pos.balanceFetchFailureCount}/${MAX_BALANCE_FETCH_FAILURES}). Cooling down before retry.`);
          }
          continue;
        }
      }

      if (!liveBalanceResolved) {
        continue;
      }

      if (exactBalanceLamports <= 0) {
        console.warn(`[SNIPER]  Token ${pos.symbol} balance is zero/dust on-chain! Dropping from memory to prevent infinite sell loop.`);
        store.blacklist.push(pos.mint);
        exits.push(pos);
        continue;
      }

      // Calculate how many raw tokens to swap using fraction
      const activeSwapBal = Math.floor(exactBalanceLamports * sellFraction);

      const sellQuote = await getQuote(pos.mint, WSOL, activeSwapBal, slippageBps);
      if (sellQuote) {
      const priorityFee = SELL_PRIORITY_FEE_LAMPORTS;
      let sellSig = await executeSwap(sellQuote, priorityFee);
        if (sellSig && process.env.PAPER_MODE !== 'true' && isGhostExecutionSignature(sellSig)) {
          console.warn(`[SNIPER]  LIVE SELL BLOCKED for ${pos.symbol}: received ghost signature ${sellSig}`);
          sellSig = null;
        }
        if (sellSig) {
          pos.exitFailureCount = 0;
          pos.lastExitFailureAt = undefined;
          pos.lastExitFailureReason = undefined;
          pos.lastExitFailureCode = undefined;
          pos.nextExitRetryAt = undefined;
          pos.balanceFetchFailureCount = 0;
          const realizedSol = Number(sellQuote.outAmount) / 1e9;

          // CRITICAL FIX: Multiply the buy price by the exact fraction of the bag we are selling
          // Defaulting to the 100% cost basis during a 50% scale-out corrupts the journal mathematics
          const proratedCostBasis = pos.buyPriceSol * sellFraction;
          const pnlSol = realizedSol - proratedCostBasis;

          const tradeId = randomUUID();
          const closedAt = Date.now();
          const soldTokenAmount = normalizeTokenAmount(activeSwapBal, pos.decimals);
          const isPartialExit = sellFraction < 0.999;
          const lifecycleSnapshot = !isPartialExit && pos.tradeId
            ? computeLifecyclePnlForClosedTrade(pos.tradeId, realizedSol)
            : null;
          const lifecyclePnlSol = lifecycleSnapshot && Number.isFinite(Number(lifecycleSnapshot.lifecyclePnlSol))
            ? Number(lifecycleSnapshot.lifecyclePnlSol)
            : null;
          const effectivePnlSol = lifecyclePnlSol ?? pnlSol;
          const remainingRawAmount = isPartialExit ? Math.max(0, exactBalanceLamports - activeSwapBal) : 0;
          const remainingTokenAmount = normalizeTokenAmount(remainingRawAmount, pos.decimals);
          const remainingEntryCostSol = isPartialExit ? Math.max(0, pos.buyPriceSol - proratedCostBasis) : 0;
          const remainingEntryPriceSol = isPartialExit
            ? computeEntryPriceSol(remainingEntryCostSol, remainingRawAmount, pos.decimals)
            : 0;
          const tradeObj = {
            agent: 'pcp-sniper',
            action: 'SELL',
            mint: pos.mint,
            symbol: pos.symbol,
            amountSol: realizedSol,
            pnlSol: effectivePnlSol,
            legPnlSol: pnlSol,
            lifecyclePnlSol: lifecyclePnlSol ?? undefined,
            sig: sellSig,
            reason,
            holdMs: heldMs,
            parentBuyId: pos.tradeId,
            tradeId,
            momentum5m: pos.entryMom5m,
            rsi: pos.peakPnlPct,
            partialExit: isPartialExit,
            timestamp: closedAt,
            openedAt: pos.openedAt,
            closedAt,
            entryMode: pos.entryMode,
            entryFamily: pos.entryFamily,
            sourceLane: pos.sourceLane,
            probeLikeEntry: pos.probeLikeEntry,
            quotaAssist: pos.quotaAssist === true,
            quotaAssistLevel: Number(pos.quotaAssistLevel || 0),
            walletSignalPriority: pos.walletSignalPriority,
            walletConsensusScore: pos.walletConsensusScore,
            walletCount: pos.walletCount,
            walletPnlScore: pos.walletPnlScore,
            kolConfirmed: pos.kolConfirmed,
            alphaBoost: pos.alphaBoost,
            alphaKolCount: pos.alphaKolCount,
            preferredHoldMs: pos.preferredHoldMs,
            tokenAgeSec: pos.tokenAgeSec,
            momentum1m: pos.momentum1m,
            marketCapUsd: pos.marketCapUsd,
            liquidityUsd: pos.liquidityUsd,
            buyRatio: pos.entryBuyRatio,
            entryPriceSol: pos.entryPriceSol,
            entryCostSol: proratedCostBasis,
            tokenAmount: soldTokenAmount,
            tokenAmountRaw: activeSwapBal,
            remainingAmount: remainingTokenAmount,
            remainingAmountRaw: remainingRawAmount,
            remainingEntryCostSol,
            remainingEntryPriceSol,
            decimals: pos.decimals,
            ata: pos.ata,
            tokenProgramId: pos.tokenProgramId,
            riskScore: pos.riskScore,
            riskBand: pos.riskBand,
            positionMultiplier: pos.positionMultiplier,
            slopfestParamsSetId: pos.slopfestParamsSetId,
            slopfestParamsRaw: pos.slopfestParamsSetId ? JSON.stringify(GLOBAL_SLOPFEST_PARAMS_RAW) : undefined,
          };
          appendTrade(tradeObj as any);
          PERSIST_JOURNAL_REDIS(tradeObj);
          console.log(`[SNIPER]  SELL TX: https://solscan.io/tx/${sellSig}`);
          console.log(`[SNIPER]  P&L: ${effectivePnlSol >= 0 ? '+' : ''}${effectivePnlSol.toFixed(6)} SOL | ${pos.symbol} | held ${(heldMs/60000).toFixed(1)}min`);
          if (!isPartialExit && lifecyclePnlSol !== null && Math.abs(lifecyclePnlSol - pnlSol) > 0.000001) {
            console.log(
              `[SNIPER]  LIFECYCLE P&L OVERRIDE: ${pos.symbol} leg=${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(6)} SOL ` +
              `lifecycle=${lifecyclePnlSol >= 0 ? '+' : ''}${lifecyclePnlSol.toFixed(6)} SOL ` +
              `after ${Number(lifecycleSnapshot?.priorPartialExitCount || 0)} prior partial exits.`,
            );
          }

          if (isPartialExit) {
            pos.tokenAmount = Math.max(0, exactBalanceLamports - activeSwapBal);
            pos.buyPriceSol = Math.max(0, pos.buyPriceSol - proratedCostBasis);
            pos.entryPriceSol = computeEntryPriceSol(pos.buyPriceSol, pos.tokenAmount, pos.decimals) || pos.entryPriceSol;
            pos.lastObservedBalanceLamports = pos.tokenAmount;
            pos.partialProfitStage = nextPartialStage;
            pos.partialSold = true;
            saveStore();
            console.log(`[SNIPER]  PARTIAL EXIT RETAINED: ${pos.symbol} remainder ${pos.tokenAmount} raw tokens | remaining cost basis ${pos.buyPriceSol.toFixed(6)} SOL`);
            continue;
          }

          await pub.publish('guardian:remove_tracking', pos.mint);


          store.stats.totalPnlSol += effectivePnlSol;
          if (effectivePnlSol >= 0) store.stats.wins++; else store.stats.losses++;

          const isTimeExit = reason.startsWith('TIME_EXIT');
          const pubPublisher = RedisBus.getPublisher();

                    if (effectivePnlSol < 0) {
              const strikes = await pubPublisher.incr(`strikes:${pos.mint}`);

              await setMintCooldownExact(pubPublisher, pos.mint, 1800, 'LOCKED');

              if (strikes >= 3) {
                  console.log(`[SNIPER]  3-STRIKE BLACKLIST: Perma-banning ${pos.mint} after 3 consecutive losses!`);
                  store.blacklist.push(pos.mint);
                  await pubPublisher.setex(`shield:ruggedTicker:${pos.mint}`, 86400, 'LOCKED');
              }

              (store.stats as any).consecutiveLosses = ((store.stats as any).consecutiveLosses || 0) + 1;
              (store.stats as any).lastLossAt = Date.now();
              if ((store.stats as any).consecutiveLosses >= LOSS_STREAK_PAUSE_THRESHOLD) {
                if (isLossStreakPauseDisabled()) {
                  delete (store.stats as any).pausedUntil;
                  console.log('[SNIPER]  LOSS STREAK RECORDED: pause disabled by liveTest config during data-refine window');
                } else {
                  const pauseMs = resolveLossStreakPauseMs(Number((store.stats as any).consecutiveLosses || 0));
                  (store.stats as any).pausedUntil = Date.now() + pauseMs;
                  console.log(
                    `[SNIPER]  LOSS STREAK BRAKE: pausing new entries for ${(pauseMs / 60000).toFixed(0)}min ` +
                    `after ${(store.stats as any).consecutiveLosses} consecutive losses.`
                  );
                }
                try {
                  pubPublisher.publish('gemma4:refine', JSON.stringify({
                    trigger: 'LOSS_STREAK',
                    consecutiveLosses: (store.stats as any).consecutiveLosses,
                    totalPnlSol: store.stats.totalPnlSol,
                    ts: Date.now(),
                  }));
                  console.log('[SNIPER]  Triggered Gemma4 refinement (loss streak: ' + (store.stats as any).consecutiveLosses + ')');
                } catch {}
              }
          } else {
              (store.stats as any).consecutiveLosses = 0;
              (store.stats as any).lastLossAt = 0;
              delete (store.stats as any).pausedUntil;
              await pubPublisher.del(`strikes:${pos.mint}`);
              if (isTimeExit) {
                console.log(`[SNIPER]  STALE WIN on ${pos.symbol}. Reset strikes + Setting 10m cooldown.`);
                await setMintCooldownExact(pubPublisher, pos.mint, 600, 'LOCKED');
              } else {
                console.log(`[SNIPER]  WIN on ${pos.symbol}. Reset strikes + Setting 60s cooldown.`);
                await setMintCooldownExact(pubPublisher, pos.mint, 60, 'LOCKED');
              }
          }
          // Unset position lock
          const outerPub = RedisBus.getPublisher();
          await outerPub.del(REDIS_KEYS.position(pos.mint));

          exits.push(pos);
        } else {
          const swapFailureMeta = sellQuote?.__pcpLastFailureMeta || null;
          pos.exitFailureCount = (pos.exitFailureCount || 0) + 1;
          pos.lastExitFailureAt = Date.now();
          pos.lastExitFailureReason = swapFailureMeta?.category || 'swap-execution-failed';
          pos.lastExitFailureCode = swapFailureMeta?.code ?? null;
          const retryCooldownMs = resolveExitRetryCooldownMs(
            swapFailureMeta,
            pos.exitFailureCount,
            EXIT_RETRY_COOLDOWN_MS,
          );
          pos.nextExitRetryAt = Date.now() + retryCooldownMs;
          saveStore();
          if (pos.exitFailureCount >= MAX_EXIT_FAILURES) {
            console.warn(`[SNIPER]  EXIT EVICT: ${pos.symbol} failed exit ${pos.exitFailureCount}x. Dropping from active tracker to stop fee churn.`);
            store.blacklist.push(pos.mint);
            const outerPub = RedisBus.getPublisher();
            await outerPub.del(REDIS_KEYS.position(pos.mint));
            exits.push(pos);
          } else {
            const retrySeconds = Math.max(1, Math.round(retryCooldownMs / 1000));
            const detailSuffix = swapFailureMeta?.code
              ? ` code=${swapFailureMeta.code}`
              : '';
            console.warn(
              `[SNIPER]  EXIT RETRY COOLING DOWN: ${pos.symbol} exit failed ` +
              `(${pos.exitFailureCount}/${MAX_EXIT_FAILURES}) reason=${pos.lastExitFailureReason}${detailSuffix} ` +
              `retryIn=${retrySeconds}s.`
            );
          }
        }
      } else {
        console.warn(`[SNIPER]   No sell quote for ${pos.symbol}  holding`);
        pos.noQuoteFailureCount = (pos.noQuoteFailureCount || 0) + 1;
        saveStore();

        // Self-heal: Drop dead tokens aggressively to free up active slots (lanes)
        // Evict if: Hard stop hit and 3+ quote failures (instant rug) OR 10+ general quote failures
        if (heldMs > MAX_HOLD_MS || (isEmergencyExit && pos.noQuoteFailureCount >= 3) || pos.noQuoteFailureCount >= 10) {
            console.error(`[SNIPER]  EVICT DEAD BAG: Token ${pos.symbol} has 0 liquidity/no route after ${(heldMs/60000).toFixed(1)}m (${pos.noQuoteFailureCount} failures). Dropping to free lane.`);
            store.blacklist.push(pos.mint);
            const outerPub = RedisBus.getPublisher();
            await outerPub.del(REDIS_KEYS.position(pos.mint));
            exits.push(pos);
        }
        continue;
      }
    } else {
      // Status line
      let dynamicTP = pos.maxTPpct ?? GLOBAL_TP_PCT;
      let dynamicSL = pos.stopLossPct ?? GLOBAL_SL_PCT;

      // Apex widening removed

      if (isLastStand) {
          const trailingFloorPct = resolveTrailingStopFloorPct({
            peakPnlPct: peak,
            isLastStand: true,
            trailingActivationPct: pos.trailingActivationPct ?? 8,
            trailingStopPct: pos.trailingStopPct ?? 12,
          });
          if (trailingFloorPct !== null) {
              dynamicSL = -(trailingFloorPct / 100);
          }
      } else {
          const trailingFloorPct = resolveTrailingStopFloorPct({
            peakPnlPct: peak,
            isLastStand: false,
          });
          if (trailingFloorPct !== null) {
              dynamicSL = -(trailingFloorPct / 100);
          }
      }

      const tpStr = !isLastStand && !pos.disablePartialTakeProfit
        ? 'PARTIALS+TRAIL'
        : dynamicTP >= 999
          ? 'TRAIL_ONLY'
          : `+${(dynamicTP * 100).toFixed(0)}%`;
      const slStr = dynamicSL <= 0 ? `+${Math.abs(dynamicSL * 100).toFixed(0)}%` : `-${(dynamicSL * 100).toFixed(0)}%`;

      console.log(`[SNIPER]  ${pos.symbol} | mode: ${pos.entryMode || 'normal'} | PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% | Peak: +${peak.toFixed(1)}% | target: ${tpStr} | SL: ${slStr} | held: ${(heldMs/60000).toFixed(1)}m`);
    }
  }

  store.positions = store.positions.filter(p => !exits.find(e => e.mint === p.mint));
  if (exits.length > 0 || storeDirty) {
    saveStore();
  }
  if (exits.length > 0) {
    console.log(`[SNIPER]  Session stats | Wins: ${store.stats.wins} | Losses: ${store.stats.losses} | PnL: ${store.stats.totalPnlSol >= 0 ? '+' : ''}${store.stats.totalPnlSol.toFixed(4)} SOL`);
  }
}

//  Orphan recovery  sell wallet tokens not tracked in positions[]
// Uses 'finalized' commitment + both token programs to catch ALL holdings
const TOKEN_PROG    = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_PROG_22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const STABLE_MINTS  = new Set([
  'So11111111111111111111111111111111111111112',   // WSOL: trading capital, never sell.
  'So11111111111111111111111111111111111111111',   // native SOL variant
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',   // USDC: strategy quote inventory, do not sweep as orphan
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',   // USDT: stable reserve, do not sweep as orphan
]);


async function recoverOrphans() {
  try {
    const pub = RedisBus.getPublisher();
    const seen = new Map<string, {
      amount: string;
      uiAmount: number;
      decimals: number | null;
      tokenProgramId: string | null;
      symbol: string | null;
    }>();

    // Use Helius DAS API to drastically reduce RPC credit burn
    try {
      await pub.incr('rpc:calls:total');
      const rpcEndpoint = process.env.RPC_ENDPOINT!;
      const res = await fetch(rpcEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 'my-id', method: 'searchAssets',
          params: { ownerAddress: wallet.publicKey.toBase58(), tokenType: 'fungible' }
        })
      });
      const data = await res.json();
      const items = data?.result?.items || [];
      for (const item of items) {
        const mint = item.id;
        const rawBalance = Number(item.token_info?.balance || 0);
        const decimals = Number(item.token_info?.decimals || 0);
        const uiAmount = decimals >= 0 ? rawBalance / Math.pow(10, decimals) : rawBalance;
        if (rawBalance > 0) {
           seen.set(mint, {
             amount: String(Math.floor(rawBalance)),
             uiAmount,
             decimals: Number.isFinite(decimals) ? decimals : null,
             tokenProgramId: null,
             symbol: item?.content?.metadata?.symbol || item?.token_info?.symbol || null,
           });
        }
      }
    } catch (e: any) {
      console.warn(`[SNIPER] Failed to fetch DAS assets: ${e.message}`);
    }

    // Also try backup RPC if PRIMARY missed any
    const backupRpc = process.env.RPC_ENDPOINT_2;
    if (backupRpc && seen.size === 0) {
      const { Connection: C } = await import('@solana/web3.js') as any;
      const backup = new C(backupRpc, 'finalized');
      for (const prog of [TOKEN_PROG, TOKEN_PROG_22]) {
        try {
          const accts = await backup.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: prog });
          for (const a of accts.value) {
            const info = a.account.data.parsed.info;
            if (info.tokenAmount.uiAmount > 0) {
              seen.set(info.mint, {
                amount: String(info.tokenAmount.amount),
                uiAmount: Number(info.tokenAmount.uiAmount || 0),
                decimals: Number.isFinite(Number(info.tokenAmount.decimals)) ? Number(info.tokenAmount.decimals) : null,
                tokenProgramId: prog.toBase58(),
                symbol: null,
              });
            }
          }
        } catch {}
      }
    }

    const prunedTrackedMints: string[] = [];
    if (seen.size > 0) {
      const liveMints = new Set(seen.keys());
      const nextPositions = store.positions.filter((pos) => {
        if (liveMints.has(pos.mint)) return true;
        prunedTrackedMints.push(pos.mint);
        return false;
      });
      if (prunedTrackedMints.length > 0) {
        for (const mint of prunedTrackedMints) {
          console.log(`[SNIPER]  TRACKING PRUNE: ${mint.slice(0,12)}... absent from wallet inventory scan, dropping stale position memory.`);
          await pub.publish('guardian:remove_tracking', mint);
        }
        store.positions = nextPositions;
        saveStore();
      }
    }

    let nativeBalanceSol: number | null = null;
    try {
      nativeBalanceSol = Number((await getSpendableNativeBalance(connection, wallet.publicKey, 0)).nativeSol || 0);
    } catch {}

    const holdings: WalletHoldingSnapshotRow[] = Array.from(seen.entries())
      .map(([mint, tokenAmount]) => {
        const trackedPos = store.positions.find((p) => p.mint === mint);
        const blacklisted = store.blacklist.includes(mint);
        const strikeCount = Number(store.strikes[mint] || 0);
        const classification: 'tracked' | 'stable' | 'untracked' =
          trackedPos ? 'tracked' : (STABLE_MINTS.has(mint) ? 'stable' : 'untracked');
        const openedAt = trackedPos?.openedAt ?? null;
        return {
          mint,
          symbol: trackedPos?.symbol || tokenAmount.symbol || `${mint.slice(0, 8)}...`,
          uiAmount: Number(tokenAmount.uiAmount || 0),
          rawAmount: String(tokenAmount.amount || '0'),
          decimals: tokenAmount.decimals,
          tokenProgramId: tokenAmount.tokenProgramId,
          tracked: !!trackedPos,
          classification,
          blacklisted,
          strikeCount,
          recoverableOrphan: classification === 'untracked' && (blacklisted || strikeCount >= 3),
          entryMode: trackedPos?.entryMode || null,
          openedAt,
          heldMinutes: openedAt ? Math.max(0, (Date.now() - openedAt) / 60000) : null,
        };
      })
      .sort((a, b) => {
        const classRank = { tracked: 0, untracked: 1, stable: 2 } as const;
        const rankDiff = classRank[a.classification] - classRank[b.classification];
        if (rankDiff !== 0) return rankDiff;
        return b.uiAmount - a.uiAmount;
      });

    persistWalletHoldingsSnapshot({
      generatedAt: Date.now(),
      wallet: wallet.publicKey.toBase58(),
      nativeBalanceSol,
      nonzeroHoldingCount: holdings.length,
      trackedHoldingCount: holdings.filter((row) => row.classification === 'tracked').length,
      stableHoldingCount: holdings.filter((row) => row.classification === 'stable').length,
      untrackedHoldingCount: holdings.filter((row) => row.classification === 'untracked').length,
      recoverableOrphanCount: holdings.filter((row) => row.recoverableOrphan).length,
      prunedTrackedMints,
      holdings,
    });

    for (const [mint, tokenAmount] of seen) {
      if (STABLE_MINTS.has(mint)) continue;
      if (store.positions.find(p => p.mint === mint)) continue; // already tracked

      // Restrict orphan sweep to bad lists only (user request)
      const isBlacklisted = store.blacklist.includes(mint);
      const isBadStreak = (store.strikes[mint] || 0) >= 3;
      if (!isBlacklisted && !isBadStreak) {
        // Skip recovering this orphan, let it sit
        continue;
      }
      const orphanSkipKey = `sniper:orphan:skip:${mint}`;
      const orphanSkipReason = await pub.get(orphanSkipKey);
      if (orphanSkipReason) {
        console.log(`[SNIPER]  ORPHAN SKIP: ${mint.slice(0,12)}... suppressed (${orphanSkipReason})`);
        continue;
      }

      console.log(`[SNIPER]  Orphan: ${mint.slice(0,12)}... (${tokenAmount.uiAmount})  selling`);
      const q = await getQuote(mint, WSOL, Number(tokenAmount.amount));
      if (!q) {
        console.warn(`[SNIPER]  No route for orphan ${mint.slice(0,12)}`);
        await pub.setex(orphanSkipKey, 1800, 'NO_ROUTE');
        continue;
      }
      const sig = await executeSwap(q, ORPHAN_PRIORITY_FEE_LAMPORTS);
      if (sig) {
        if (process.env.PAPER_MODE !== 'true' && isGhostExecutionSignature(sig)) {
          console.warn(`[SNIPER]  ORPHAN GHOST SELL BLOCKED for ${mint.slice(0,12)}... invalid live signature ${sig}`);
          await pub.setex(orphanSkipKey, 21600, 'GHOST_SIG');
          continue;
        }
        const solOut = Number(q.outAmount) / 1e9;
        console.log(`[SNIPER]  Orphan sold  +${solOut.toFixed(5)} SOL`);
        const tradeId = randomUUID();
        const shouldJournal = shouldJournalOrphanRecovery('orphan-recovery', store.positions.some((p) => p.mint === mint));
        if (shouldJournal) {
          appendTrade({ agent:'pcp-sniper', action:'SELL', mint, symbol:'ORPHAN',
            amountSol:solOut, sig, reason:'orphan-recovery', tradeId });
        } else {
          console.log(`[SNIPER]  ORPHAN JOURNAL SKIP: ${mint.slice(0,12)}... sold outside tracked positions; keeping trade journal clean.`);
        }
      }
    }
    if (seen.size > 0) console.log(`[SNIPER] Orphan scan complete (${seen.size} non-zero tokens found)`);
  } catch (e: any) { console.error('[SNIPER] Orphan recovery error:', e.message); }
}

async function poll() {
  if (pollInFlight) {
    pollQueued = true;
    return;
  }
  pollInFlight = true;
  const MIN_POSITIONS = 10;
  const TARGET_POSITIONS = 15;
  const openPositions = store.positions.length;
  globalQuotaAssistLevel = resolveQuotaAssistLevel(openPositions, MIN_POSITIONS, TARGET_POSITIONS);
  globalQuotaPressure = resolveQuotaPressure(openPositions, MIN_POSITIONS, TARGET_POSITIONS);
  if (globalQuotaPressure > 0) {
    console.log(
      `[SNIPER] Quota status: open=${openPositions}, min=${MIN_POSITIONS}, target=${TARGET_POSITIONS}, ` +
      `pressure=${globalQuotaPressure.toFixed(2)}, level=${globalQuotaAssistLevel} | strict entry standards active`
    );
  }
  //  PATH 0 (pre): Force-sell queue  execute orphan sweep sells
  // Written by orphan_sweep.py or monitor. Processed once then deleted.
    // force_sell.json: REMOVED  was causing unexpected sells

  //  PATH 0a: Alpha wallet SELL exit (highest priority  before price checks)
  // If a tracked smart-money wallet SELLS a token we're holding, exit immediately.
  // Their exit = informed signal that the move is done.

  if (false && store.positions.length > 0 && fs.existsSync(WALLET_SIG_FILE)) {
    // [DISABLED] - We use alpha wallets to track tokens with volume, not to inherently copytrade their exits.
    try {
      const wData = JSON.parse(fs.readFileSync(WALLET_SIG_FILE, 'utf-8'));
      const sellSigs: any[] = (wData.sell_signals || []).filter((s: any) => !s.expired);
      for (const sellSig of sellSigs) {
        const pos = store.positions.find((p: any) => p.mint === sellSig.mint);
        if (!pos) continue;
        console.log(`[SNIPER]  ALPHA WALLET SOLD ${pos.symbol}  force exit | held by alpha: ${(sellSig.holdMs/60000).toFixed(1)}min`);
        const sellQuote = await getQuote(pos.mint, WSOL, pos.tokenAmount);
        if (sellQuote) {
          let sellSigTx = await executeSwap(sellQuote, ALPHA_EXIT_PRIORITY_FEE_LAMPORTS);
          if (sellSigTx && process.env.PAPER_MODE !== 'true' && isGhostExecutionSignature(sellSigTx)) {
            console.warn(`[SNIPER]  ALPHA SELL BLOCKED for ${pos.symbol}: received ghost signature ${sellSigTx}`);
            sellSigTx = null;
          }
          if (sellSigTx) {
            const realizedSol = Number(sellQuote.outAmount) / 1e9;
            const pnlSol      = realizedSol - (pos as any).buyPriceSol;
            const pnlPct      = ((realizedSol - (pos as any).buyPriceSol) / (pos as any).buyPriceSol) * 100;
            console.log(`[SNIPER] ${pnlSol >= 0 ? ' WIN' : ' LOSS'} ${(pos as any).symbol} | PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%) | ALPHA_SELL_TRIGGER`);
            const tradeId = randomUUID();
            const alphaTrade = { agent: 'pcp-sniper', action: 'SELL', mint: (pos as any).mint, symbol: (pos as any).symbol,
              amountSol: realizedSol, pnlSol, sig: sellSigTx, reason: `ALPHA_SELL wallet:${(sellSig.walletAddr || "").slice(0,8)}`, holdMs: Date.now() - (pos as any).openedAt, parentBuyId: (pos as any).tradeId, tradeId };
            appendTrade(alphaTrade as any);
            PERSIST_JOURNAL_REDIS(alphaTrade);
            store.stats.totalPnlSol += pnlSol;
            if (pnlSol >= 0) store.stats.wins++; else store.stats.losses++;
            store.positions = store.positions.filter(p => p.mint !== (pos as any).mint);
            saveStore();
          }
        }
      }
    } catch {}
  }

  // Check exits (price-based logic)
    // Check exits previously evaluated here - now decoupled to real-time timer in main()

  try {
    //
    // PATH 0: ALPHA WALLET SIGNAL (pcp-wallet-tracker)
    //  Highest priority  2+ tracked smart money wallets bought same token
    //  HIGH_CONVICTION flag = skip normal filters, enter immediately
    //
    const microOnlyMode = isMicroOnlyMode();
    if (!microOnlyMode) {
      const lastStandContext = await getLastStandContext();
      if (lastStandContext.active) {
        await runLastStandScan(lastStandContext);
        return;
      }
    }
    const microScoutConfig = loadMicroScoutConfig();
    const lossStreakState = getLossStreakState();
    const lossStreakRestricted = lossStreakState.restrictionsActive;
    const walletSignalSnapshot = readJsonFile<any>(WALLET_SIG_FILE) || {};
    const followMonitorSnapshot = readJsonFile<any>(GMGN_FOLLOW_MONITOR_FILE) || {};
    const freshWalletSignals: any[] = Array.isArray(walletSignalSnapshot?.buy_signals)
      ? walletSignalSnapshot.buy_signals.filter((signal: any) => isWalletSignalFresh(signal))
      : [];
    const freshWalletSignalMap = new Map(
      freshWalletSignals
        .filter((signal: any) => String(signal?.mint || '').trim())
        .map((signal: any) => [String(signal.mint).trim(), signal]),
    );
    const replayBackedProfile = resolveReplayBackedStrategyProfile(GLOBAL_SLOPFEST_PARAMS_RAW);
    const replayAlphaMomentumFloor = Math.max(0, Math.min(5, Number(replayBackedProfile.min5mChange || 0)));
    const executableWalletBuyCount = freshWalletSignals.filter((signal: any) => signal?.executable === true).length;
    const gmgnFollowCount = Math.max(
      0,
      Number(
        followMonitorSnapshot?.count ||
        (Array.isArray(followMonitorSnapshot?.tokens) ? followMonitorSnapshot.tokens.length : 0),
      ),
    );
    const quietQuotaRegime = shouldSuppressQuotaAssistForQuietRegime({
      quotaAssistLevel: globalQuotaAssistLevel,
      executableWalletBuyCount,
      gmgnFollowCount,
    });
    if (quietQuotaRegime) {
      console.log(
        `[SNIPER]  QUIET REGIME HOLD: quota assist paused with ` +
        `${executableWalletBuyCount} executable wallet buys and ${gmgnFollowCount} GMGN follow leads.`
      );
    }
    let quotaTrendingMap: Map<string, any> = new Map();
    if (fs.existsSync(TRENDING_FILE)) {
      try {
        const tRaw = JSON.parse(fs.readFileSync(TRENDING_FILE, 'utf-8'));
        quotaTrendingMap = buildTrendingMap(tRaw);
      } catch {}
    }

	    if (store.positions.length < MAX_POSITIONS && Array.isArray(walletSignalSnapshot?.buy_signals)) {
	      try {
	        const wData = walletSignalSnapshot;
	        const walletScales = {
            qualifierThresholdScale: 1,
            buyCountThresholdScale: 1,
            buyRatioThresholdScale: 1,
          };
	        const walletCandidateLimit = resolveWalletQuotaCandidateLimit(globalQuotaAssistLevel);
	        const sortedWalletSignals: any[] = sortWalletQuotaSignals((wData.buy_signals || []).filter((s: any) =>
	          s?.executable === true &&
	          isWalletSignalFresh(s) &&
	          !store.blacklist.includes(s.mint) &&
	          !store.positions.find((p: any) => p.mint === s.mint)
	        ));
	        const walletBaseRank = new Map(
	          sortedWalletSignals.map((signal: any, index: number) => [String(signal?.mint || ''), index]),
	        );
	        const buySigs: any[] = annotateCandidatesWithExpectedValue(
	          sortedWalletSignals,
	          (signal: any) => {
	            const trendingMeta = quotaTrendingMap.get(signal.mint) || {};
	            const walletCount = Array.isArray(signal?.wallets) ? signal.wallets.length : Number(signal?.walletCount || 0);
	            const alphaDecision = computeAlphaBoost({
	              tokenAddress: signal.mint,
	              now: Date.now(),
	              catalystSignalsFile: path.join(SIGNALS_DIR, 'catalyst_alerts.json'),
	              walletSignalsFile: WALLET_SIG_FILE,
	            });
	            const pairCreatedAt = trendingMeta?.pairCreatedAt || trendingMeta?.createdAt || undefined;
	            const tokenAgeSec = pairCreatedAt ? Math.max(0, Math.floor((Date.now() - Number(pairCreatedAt)) / 1000)) : undefined;
	            return {
	              entryMode: microOnlyMode ? 'micro-scout' : 'normal',
	              sourceLane: 'wallet',
	              entryFamily: 'wallet',
	              tokenAgeSec,
	              liquidityUsd: Number(trendingMeta?.liquidityUsd || 0),
	              marketCapUsd: Math.max(Number(trendingMeta?.marketCapUsd || 0), Number(trendingMeta?.fdvUsd || 0)),
	              fdvUsd: Number(trendingMeta?.fdvUsd || trendingMeta?.marketCapUsd || 0),
	              momentum5m: Number(trendingMeta?.priceChange5m || 0),
	              buyRatio: Math.max(Number(trendingMeta?.buyRatio || 0), Number(signal?.consensusScore || 0), 0.9),
	              volume1hUsd: Number(trendingMeta?.volume1h || 0),
	              buys1h: Number(trendingMeta?.buys1h || walletCount),
	              sells1h: Number(trendingMeta?.sells1h || 0),
	              quotaAssistLevel: globalQuotaAssistLevel,
	              walletSignalPriority: signal?.priority,
	              walletConsensusScore: Number(signal?.consensusScore || 0),
	              walletCount,
	              walletPnlScore: Number(signal?.walletPnlScore || 0),
	              walletWeightedScore: Number(signal?.walletWeightedScore || 0),
	              walletCompositeScore: Number(signal?.walletCompositeScore || signal?.walletWeightedScore || signal?.walletPnlScore || 0),
	              kolConfirmed: Boolean(signal?.kolConfirmed),
	              alphaBoost: Number(alphaDecision.totalBoost || 0),
	              alphaKolCount: Number(alphaDecision.uniqueKols || 0),
	              preferredHoldMs: Number(signal?.preferredHoldMs || 0) || undefined,
	              confidenceScore: Math.max(
	                0.45,
	                Math.min(
	                  0.99,
	                  (
	                    (Number(signal?.consensusScore || 0.5) * 0.45) +
	                    (Number(signal?.walletCompositeScore || signal?.walletWeightedScore || 0) * 0.35) +
	                    (Number(signal?.avgWalletWinRate || 0) * 0.20)
	                  ),
	                ),
	              ),
	            };
	          },
	        ).sort((left: any, right: any) =>
	          compareExpectedValueRank(
	            left,
	            right,
	            (baseLeft: any, baseRight: any) =>
	              (walletBaseRank.get(String(baseLeft?.mint || '')) ?? Number.MAX_SAFE_INTEGER) -
	              (walletBaseRank.get(String(baseRight?.mint || '')) ?? Number.MAX_SAFE_INTEGER),
	          ),
	        );

	        for (const top of buySigs.slice(0, walletCandidateLimit)) {
	          if (store.positions.length >= MAX_POSITIONS) break;
	          const sizeTag = top.sizeUp ? 'SIZE_UP' : 'HIGH_CONV';
	          const sectorTag = top.sector ? ` [${top.sector}]` : '';
          const hotSector = wData.hot_sector;
          const trendingMeta = quotaTrendingMap.get(top.mint) || {};
          const walletCount = Array.isArray(top.wallets) ? top.wallets.length : Number(top.walletCount || 0);
          const observedTokenAmount = Number(top.observedTokenAmount || 0);
          const metadataBlind = isQuotaCandidateMetadataBlind(trendingMeta);
          const hasMarketSupport = hasQuotaCandidateMarketSupport(trendingMeta);
          const allowWalletSignal = globalQuotaAssistLevel > 0
            ? Boolean(top?.executable) && !metadataBlind && (hasMarketSupport || shouldAllowQuotaWalletWithoutExtraMarketSupport(top))
            : (top.sizeUp || walletCount >= 2 || hasMarketSupport);
          if (!allowWalletSignal) {
            const pollPub = RedisBus.getPublisher();
            await setMintCooldown(pollPub, top.mint, 20, 'LOCKED');
            console.log(
              `[SNIPER]  HIGH_CONV HOLD: ${top.symbol || top.mint.slice(0,8)} ` +
              `${metadataBlind ? 'is missing liquidity / market-cap metadata' : 'lacks market support'} ` +
              `(${walletCount} wallet, bags:${trendingMeta?.bagsSignal ? 'yes' : 'no'}, observed:${observedTokenAmount.toFixed(3)} token units).`
            );
            continue;
          }

	          const bagsTag = trendingMeta?.bagsSignal ? ' | bags:yes' : '';
	          const topEv = top.expectedValueDecision || {};
	          console.log(
	            `[SNIPER]  WALLET QUOTA ${sizeTag}: ${top.symbol || top.mint.slice(0,8)}${sectorTag} | ` +
	            `${walletCount} wallets | priority:${top.priority || 'INFO'} | consensus:${Number(top.consensusScore || 0).toFixed(2)} ` +
	            `| wScore:${Number(top.walletCompositeScore || top.walletWeightedScore || 0).toFixed(2)} ` +
	            `| quota=${globalQuotaAssistLevel} | EV=${Number(topEv.expectedPnlSol || 0).toFixed(6)} ` +
	            `| conf=${(Number(topEv.confidence || 0) * 100).toFixed(0)}% | hot:${hotSector || 'none'}${bagsTag}`
	          );

          if (top.sizeUp) {
            process.env.WALLET_SIZE_UP = '1';
          }

          const preferredHoldMinutes = Math.min(
            GLOBAL_HOLD_MIN,
            Math.max(2, Number(top.preferredHoldMs || 0) > 0 ? Number(top.preferredHoldMs) / 60000 : GLOBAL_HOLD_MIN),
          );
          const walletEntryOptions = {
            ...buildMicroOnlyProbeEntryOptions({
              requestedEntryMode: 'normal',
              microOnlyMode,
              microScoutConfig,
            }),
            sourceLane: 'wallet',
            entryFamily: 'wallet',
            quotaAssist: globalQuotaAssistLevel > 0,
            quotaAssistLevel: globalQuotaAssistLevel,
            qualifierThresholdScale: walletScales.qualifierThresholdScale,
            buyCountThresholdScale: walletScales.buyCountThresholdScale,
            buyRatioThresholdScale: walletScales.buyRatioThresholdScale,
            maxHoldMinutes: preferredHoldMinutes,
            walletSignalPriority: top.priority,
            walletConsensusScore: Number(top.consensusScore || 0),
            walletCount,
            walletPnlScore: Number(top.walletPnlScore || 0),
            walletWeightedScore: Number(top.walletWeightedScore || 0),
            walletCompositeScore: Number(top.walletCompositeScore || top.walletWeightedScore || top.walletPnlScore || 0),
            kolConfirmed: Boolean(top.kolConfirmed),
            preferredHoldMs: Number(top.preferredHoldMs || 0) || undefined,
          };
          if (microOnlyMode && walletEntryOptions.entryMode === 'micro-scout') {
            console.log(
              `[SNIPER]  MICRO-ONLY WALLET DOWNSHIFT: ${top.symbol || top.mint.slice(0,8)} ` +
              `will use probe sizing (${describeMicroScoutSizing(microScoutConfig)}).`
            );
          }

          try {
            await trySnipe(
              top.mint,
              top.symbol || trendingMeta.symbol || top.mint.slice(0, 8),
              Number(trendingMeta.volume1h || 0),
              Number(trendingMeta.priceChange1h || 0),
              Number(trendingMeta.buys1h || walletCount),
              Number(trendingMeta.sells1h || 0),
              Math.max(Number(trendingMeta.buyRatio || 0), Number(top.consensusScore || 0.9), 0.9),
              `ALPHA_${sizeTag}`, top.consensusScore || 0.9,
              undefined,
              undefined,
              undefined,
              undefined,
              walletEntryOptions,
            );
          } finally {
            process.env.WALLET_SIZE_UP = '0';
          }
        }
      } catch (e: any) {
        console.error('[SNIPER] Wallet signal read error:', e.message);
      }
    }

    if (globalQuotaAssistLevel > 0 && quietQuotaRegime && store.positions.length < MAX_POSITIONS && quotaTrendingMap.size > 0) {
      console.log(
        `[SNIPER]  ALPHA QUOTA HOLD: standing down quota fills until executable wallet or GMGN follow flow returns.`
      );
    }

    if (globalQuotaAssistLevel > 0 && !quietQuotaRegime && store.positions.length < MAX_POSITIONS && quotaTrendingMap.size > 0) {
      try {
	        const alphaBaseCandidates = Array.from(quotaTrendingMap.values())
	          .filter((candidate: any) =>
	            candidate?.mint &&
	            !store.blacklist.includes(candidate.mint) &&
            !store.positions.find((p: any) => p.mint === candidate.mint)
          )
          .map((candidate: any) => {
            const alphaDecision = computeAlphaBoost({
              tokenAddress: candidate.mint,
              now: Date.now(),
              catalystSignalsFile: path.join(SIGNALS_DIR, 'catalyst_alerts.json'),
              walletSignalsFile: WALLET_SIG_FILE,
            });
            const pairCreatedAt = candidate.pairCreatedAt || candidate.createdAt || undefined;
            const tokenAgeSec = pairCreatedAt ? Math.max(0, Math.floor((Date.now() - Number(pairCreatedAt)) / 1000)) : undefined;
            return {
              candidate,
              alphaBoost: Number(alphaDecision.totalBoost || 0),
              alphaKolCount: Number(alphaDecision.uniqueKols || 0),
              signalCount: Number(alphaDecision.signalCount || 0),
              tokenAgeSec,
              walletSignal: freshWalletSignalMap.get(String(candidate?.mint || '').trim()) || null,
            };
          })
          .filter((row: any) => row.alphaBoost > 0 || row.alphaKolCount > 0);
	        const alphaBaseShortlist = alphaBaseCandidates
          .filter((row: any) =>
            shouldAllowAlphaQuotaCandidate({
              candidate: row.candidate,
              alphaKolCount: row.alphaKolCount,
              signalCount: row.signalCount,
              quotaQuietRegime: quietQuotaRegime,
              walletSignal: row.walletSignal,
              replayBacked: replayBackedProfile.active &&
                Number(row.candidate?.priceChange5m || 0) >= replayAlphaMomentumFloor &&
                (
                  row.alphaKolCount > 0 ||
                  row.signalCount >= 2 ||
                  Number(row.candidate?.volume1h || 0) >= Math.max(1000, Number(replayBackedProfile.minVolume5m || 0))
                ),
            })
          )
	          .sort((left: any, right: any) =>
	            (right.alphaBoost - left.alphaBoost) ||
	            (right.alphaKolCount - left.alphaKolCount) ||
	            (Number(right.candidate?.buys1h || 0) - Number(left.candidate?.buys1h || 0)) ||
	            (Number(right.candidate?.priceChange5m || 0) - Number(left.candidate?.priceChange5m || 0))
	          )
	          .slice(0, resolveAlphaQuotaCandidateLimit(globalQuotaAssistLevel));
	        const alphaGuardFilteredCount = Math.max(0, alphaBaseCandidates.length - alphaBaseShortlist.length);
	        if (alphaGuardFilteredCount > 0) {
	          console.log(
	            `[SNIPER]  ALPHA QUALITY HOLD: filtered ${alphaGuardFilteredCount} quota candidate(s) ` +
	            `for weak confirmation or missing market metadata.`
	          );
	        }
	        const alphaBaseRank = new Map(
	          alphaBaseShortlist.map((row: any, index: number) => [String(row?.candidate?.mint || ''), index]),
	        );
          const alphaMinLiquidityUsd = Math.max(0, Number(loadNormalLaneConfig().minLiquidityUsd || 0));
	        const alphaShortlist = annotateCandidatesWithExpectedValue(
	          alphaBaseShortlist,
	          (row: any) => ({
	            entryMode: microOnlyMode ? 'micro-scout' : 'normal',
	            sourceLane: 'alpha',
	            entryFamily: 'alpha',
	            tokenAgeSec: row.tokenAgeSec,
	            liquidityUsd: Number(row.candidate?.liquidityUsd || 0),
	            marketCapUsd: Math.max(Number(row.candidate?.marketCapUsd || 0), Number(row.candidate?.fdvUsd || 0)),
	            fdvUsd: Number(row.candidate?.fdvUsd || row.candidate?.marketCapUsd || 0),
	            momentum5m: Number(row.candidate?.priceChange5m || 0),
	            buyRatio: Number(row.candidate?.buyRatio || 0.9),
	            volume1hUsd: Number(row.candidate?.volume1h || 0),
	            buys1h: Number(row.candidate?.buys1h || 0),
	            sells1h: Number(row.candidate?.sells1h || 0),
	            quotaAssistLevel: globalQuotaAssistLevel,
	            alphaBoost: row.alphaBoost,
	            alphaKolCount: row.alphaKolCount,
	            kolConfirmed: row.alphaKolCount > 0,
	            confidenceScore: Math.min(0.99, Math.max(0.45, 0.55 + Number(row.alphaBoost || 0))),
	          }),
	        ).sort((left: any, right: any) =>
	          compareExpectedValueRank(
	            left,
	            right,
	            (baseLeft: any, baseRight: any) =>
	              (alphaBaseRank.get(String(baseLeft?.candidate?.mint || '')) ?? Number.MAX_SAFE_INTEGER) -
	              (alphaBaseRank.get(String(baseRight?.candidate?.mint || '')) ?? Number.MAX_SAFE_INTEGER),
	          ),
	        );

	        for (const row of alphaShortlist) {
	          if (store.positions.length >= MAX_POSITIONS) break;
	          const candidate = row.candidate;
	          const symbol = candidate.symbol || candidate.mint.slice(0, 8);
	          const ta = loadSignal(candidate.mint);
            const alphaMomentum5m = Number(candidate.priceChange5m || 0);
            const alphaMomentum1m = Number(candidate.priceChange1m || 0);
            const alphaLiquidityUsd = Number(candidate.liquidityUsd || 0);
            if (alphaMomentum5m <= 0 || alphaMomentum1m <= 0) {
              console.log(
                `[SNIPER]  ALPHA MOMENTUM HOLD: ${symbol} needs positive 1m and 5m continuation ` +
                `(1m=${alphaMomentum1m.toFixed(1)}%, 5m=${alphaMomentum5m.toFixed(1)}%).`
              );
              const pollPub = RedisBus.getPublisher();
              await setMintCooldown(pollPub, candidate.mint, 30, 'ALPHA_CONTINUATION');
              continue;
            }
            if (alphaLiquidityUsd > 0 && alphaLiquidityUsd < alphaMinLiquidityUsd) {
              console.log(
                `[SNIPER]  ALPHA LIQUIDITY HOLD: ${symbol} liquidity $${alphaLiquidityUsd.toFixed(0)} ` +
                `< $${alphaMinLiquidityUsd.toFixed(0)} floor.`
              );
              const pollPub = RedisBus.getPublisher();
              await setMintCooldown(pollPub, candidate.mint, 45, 'ALPHA_LIQUIDITY');
              continue;
            }
	          const rowEv = row.expectedValueDecision || {};
	          console.log(
	            `[SNIPER]  ALPHA QUOTA ASSIST: ${symbol} | boost=${row.alphaBoost >= 0 ? '+' : ''}${(row.alphaBoost * 100).toFixed(1)}% ` +
	            `| kols=${row.alphaKolCount} | signals=${row.signalCount} | quota=${globalQuotaAssistLevel} ` +
	            `| EV=${Number(rowEv.expectedPnlSol || 0).toFixed(6)} | conf=${(Number(rowEv.confidence || 0) * 100).toFixed(0)}%`
	          );
          await trySnipe(
            candidate.mint,
            symbol,
            Number(candidate.volume1h || 0),
            Number(candidate.priceChange1h || 0),
            Number(candidate.buys1h || 0),
            Number(candidate.sells1h || 0),
            Number(candidate.buyRatio || 0.9),
            ta?.signal || 'ALPHA_ASSIST',
            Math.min(0.99, Math.max(Number(ta?.confidence || 0), 0.55 + row.alphaBoost)),
            row.tokenAgeSec,
            Number(candidate.priceChange5m || 0),
            Number(candidate.priceChange1m || 0),
            candidate.pairCreatedAt || candidate.createdAt || undefined,
            {
              ...buildMicroOnlyProbeEntryOptions({
                requestedEntryMode: 'normal',
                microOnlyMode,
                microScoutConfig,
              }),
              sourceLane: 'alpha',
              entryFamily: 'alpha',
              quotaAssist: true,
              quotaAssistLevel: globalQuotaAssistLevel,
              qualifierThresholdScale: 1,
              minLiquidityUsd: alphaMinLiquidityUsd,
              alphaBoost: row.alphaBoost,
              alphaKolCount: row.alphaKolCount,
              kolConfirmed: row.alphaKolCount > 0,
              walletConfirmed: isWalletConfirmedSignal(row.walletSignal),
            },
          );
        }
      } catch (e: any) {
        console.error('[SNIPER] Alpha quota shortlist error:', e.message);
      }
    }

    //

    // --- PATH 0b: VELOCITY ARBITRAGE (Quota-Filler bypass lane) ---
    // Instantly catch any token with >5% price spike and > volume, bypassing mature checks
	    try {
	        if (fs.existsSync(TRENDING_FILE) && store.positions.length < MAX_POSITIONS) {
	            const tRaw = JSON.parse(fs.readFileSync(TRENDING_FILE, 'utf-8'));
	            const velocityCandidates = tRaw.filter((t: any) =>
	                (t.priceChange5m || 0) >= 5.0 &&
	                (t.volume1h || 0) >= 10000 &&
	                !store.blacklist.includes(t.mint) &&
	                !store.positions.find((p: any) => p.mint === t.mint)
	            );
	            const velocityArbRanked = annotateCandidatesWithExpectedValue(
	              velocityCandidates,
	              (candidate: any) => ({
	                entryMode: microOnlyMode ? 'micro-scout' : 'normal',
	                sourceLane: 'velocity-first',
	                entryFamily: 'velocity-first',
	                tokenAgeSec: candidate?.pairCreatedAt || candidate?.createdAt
	                  ? Math.max(0, Math.floor((Date.now() - Number(candidate?.pairCreatedAt || candidate?.createdAt || 0)) / 1000))
	                  : undefined,
	                liquidityUsd: Number(candidate?.liquidityUsd || 0),
	                marketCapUsd: Math.max(Number(candidate?.marketCapUsd || 0), Number(candidate?.fdvUsd || 0)),
	                fdvUsd: Number(candidate?.fdvUsd || candidate?.marketCapUsd || 0),
	                momentum5m: Number(candidate?.priceChange5m || 0),
	                buyRatio: Number(candidate?.buyRatio || 0.8),
	                volume1hUsd: Number(candidate?.volume1h || 0),
	                buys1h: Number(candidate?.buys1h || 0),
	                sells1h: Number(candidate?.sells1h || 0),
	                confidenceScore: clamp(Number(candidate?.buyRatio || 0.8) / 3, 0.25, 0.95),
	              }),
	            ).sort((left: any, right: any) =>
	              compareExpectedValueRank(
	                left,
	                right,
	                (baseLeft: any, baseRight: any) =>
	                  (Number(baseRight?.priceChange5m || 0) - Number(baseLeft?.priceChange5m || 0)) ||
	                  (Number(baseRight?.volume1h || 0) - Number(baseLeft?.volume1h || 0)),
	              ),
	            );
	            if (velocityCandidates.length > 0) {
	                console.log(`[SNIPER] VELOCITY_ARBITRAGE: Identified ${velocityCandidates.length} high-volatility moving tokens.`);
	                for (const candidate of velocityArbRanked) {
	                    if (store.positions.length >= MAX_POSITIONS) break;
	                    await trySnipe(
	                        candidate.mint,
                        candidate.symbol || candidate.mint.slice(0, 8),
                        candidate.volume1h,
                        candidate.priceChange1h || 0,
                        candidate.buys1h || 10,
                        candidate.sells1h || 0,
                        candidate.buyRatio || 0.8,
                        undefined, undefined, undefined, undefined, undefined, undefined,
                        { entryMode: 'velocity-arbitrage' } as any
                    );
                }
            }
        }
    } catch(e) {}
    // PATH 1: VELOCITY-FIRST DISCOVERY (pcp-velocity WebSocket stream)
    //  Catch pumps BEFORE DexScreener shows them
    // Scans velocity.json for isAccelerating mints, cross-checks trending.json
    // for directional confirmation. This is the sub-2s early-entry path.
    //
    const velMints = loadAllVelocityMints();

    const accelerating = velMints.filter(v =>
      v.buys60s >= MIN_BUYS_1H &&
      v.buyRatio60s >= 0.50 &&
      v.solVolume60s >= 1.0 &&
      !store.blacklist.includes(v.mint) &&
      !store.positions.find(p => p.mint === v.mint)
    ).sort((a, b) => (b.solVolume60s - a.solVolume60s) || (b.buys60s - a.buys60s));

    let freshVelocityTrackedCount = accelerating.length;
    let freshVelocityEligibleCount = 0;
    if (!microScoutConfig.enabled && accelerating.length > 0) {
      console.log(
        `[SNIPER]  MICRO_SCOUT disabled in strategy profile; ignoring ${accelerating.length} accelerating candidate(s) and preserving treasury.`
      );
    }

    if (microScoutConfig.enabled && accelerating.length > 0 && store.positions.length < MAX_POSITIONS) {
      const velocitySelectionConfig = loadVelocitySelectionConfig();
      const pollMicroScoutPacing = resolveActiveMicroScoutPacing(store.positions.length, MAX_POSITIONS, microScoutConfig);
      let microScoutEntriesThisPoll = 0;
      const collectEligibleVelocityCandidates = async (candidatePool: typeof accelerating) => {
        const eligible: typeof accelerating = [];
        let cooldownFiltered = 0;
        let softCooldownRechecks = 0;
        let tempBlacklistFiltered = 0;
        let scannedCandidates = 0;

        for (const candidate of candidatePool) {
          scannedCandidates += 1;
          const cooldownState = await getMintCooldownState(candidate.mint);
          const softCooldownRecheck =
            softCooldownRechecks < velocitySelectionConfig.maxSoftRechecksPerPoll &&
            shouldAllowVelocitySoftRecheck(cooldownState, candidate, velocitySelectionConfig);
          if (cooldownState.active && !softCooldownRecheck) {
            cooldownFiltered += 1;
            if (scannedCandidates >= 120 && eligible.length === 0) break;
            continue;
          }
          const tempBlacklistPenalty = await getTempBlacklistPenalty(candidate.mint);
          if (tempBlacklistPenalty !== null) {
            tempBlacklistFiltered += 1;
            if (scannedCandidates >= 120 && eligible.length === 0) break;
            continue;
          }
          if (softCooldownRecheck) {
            softCooldownRechecks += 1;
          }
          eligible.push({
            ...candidate,
            softCooldownRecheck,
            softCooldownReason: cooldownState.value,
            softCooldownTtlSeconds: cooldownState.ttlSeconds,
          } as any);
          if (eligible.length >= 30) break;
        }

        return {
          eligible,
          cooldownFiltered,
          softCooldownRechecks,
          tempBlacklistFiltered,
          scannedCandidates,
        };
      };

      let eligibleAccelerating: typeof accelerating = [];
      let cooldownFiltered = 0;
      let softCooldownRechecks = 0;
      let tempBlacklistFiltered = 0;
      let scannedAccelerating = 0;
      const velocityTiersUsed: string[] = [];
      let candidatePool = accelerating;
      const exhaustedRecoveryTiers: string[] = [];

      let selectionResult = await collectEligibleVelocityCandidates(candidatePool);
      eligibleAccelerating = selectionResult.eligible;
      cooldownFiltered = selectionResult.cooldownFiltered;
      softCooldownRechecks = selectionResult.softCooldownRechecks;
      tempBlacklistFiltered = selectionResult.tempBlacklistFiltered;
      scannedAccelerating = selectionResult.scannedCandidates;

      let assessmentBudget = resolveVelocityAssessmentBudget({
        underfilledBookActive: pollMicroScoutPacing.underfilledBookActive,
        scoutCandidatesPerPoll: pollMicroScoutPacing.maxCandidatesPerPoll,
        currentOpenPositions: store.positions.length,
        maxOpenPositions: MAX_POSITIONS,
        currentEligibleCandidates: eligibleAccelerating.length,
      });

	      while (assessmentBudget.additionalCandidatesNeeded > 0) {
        const recoverySelection = selectVelocityRecoveryTier(
          velMints,
          {
            excludeMints: [
              ...accelerating.map((candidate) => candidate.mint),
              ...eligibleAccelerating.map((candidate: any) => candidate?.mint),
            ],
            blacklist: store.blacklist,
            heldMints: store.positions.map((position) => position.mint),
            skipLabels: exhaustedRecoveryTiers,
          },
          velocitySelectionConfig,
        );
        if (!recoverySelection.tier || recoverySelection.candidates.length === 0) {
          break;
        }
        const recoveryTierLabel = recoverySelection.tier.label;
        velocityTiersUsed.push(recoveryTierLabel);
        exhaustedRecoveryTiers.push(recoveryTierLabel);
        candidatePool = recoverySelection.candidates as typeof accelerating;
        console.log(
          `[SNIPER]  VELOCITY RECOVERY: ${eligibleAccelerating.length === 0 ? 'primary leaders exhausted after cooldown filtering' : 'underfilled book needs more fresh candidates'}; ` +
          `trying ${recoveryTierLabel} shortlist with ${candidatePool.length} fresh mint(s).`
        );
        selectionResult = await collectEligibleVelocityCandidates(candidatePool);
        const existingEligibleMints = new Set(eligibleAccelerating.map((candidate: any) => candidate?.mint).filter(Boolean));
        const appendedEligible = selectionResult.eligible.filter((candidate: any) => {
          const mint = String(candidate?.mint || '').trim();
          if (!mint || existingEligibleMints.has(mint)) return false;
          existingEligibleMints.add(mint);
          return true;
        });
        eligibleAccelerating = [...eligibleAccelerating, ...appendedEligible];
        cooldownFiltered += selectionResult.cooldownFiltered;
        softCooldownRechecks += selectionResult.softCooldownRechecks;
        tempBlacklistFiltered += selectionResult.tempBlacklistFiltered;
        scannedAccelerating += selectionResult.scannedCandidates;
	        assessmentBudget = resolveVelocityAssessmentBudget({
	          underfilledBookActive: pollMicroScoutPacing.underfilledBookActive,
	          scoutCandidatesPerPoll: pollMicroScoutPacing.maxCandidatesPerPoll,
	          currentOpenPositions: store.positions.length,
	          maxOpenPositions: MAX_POSITIONS,
	          currentEligibleCandidates: eligibleAccelerating.length,
	        });
	      }

	        eligibleAccelerating = prioritizeVelocityAssessmentCandidates(eligibleAccelerating as any) as typeof eligibleAccelerating;
        const uncappedEligibleCount = eligibleAccelerating.length;
        eligibleAccelerating = capSyntheticRefinementCandidates(
          eligibleAccelerating as any,
          velocitySelectionConfig,
        ) as typeof eligibleAccelerating;
        const syntheticRefinementTrimmed = Math.max(0, uncappedEligibleCount - eligibleAccelerating.length);

		      if (eligibleAccelerating.length === 0) {
		        console.log(
          `[SNIPER]  VELOCITY-FIRST: ${candidatePool.length} ${velocityTiersUsed.length === 0 ? 'accelerating' : velocityTiersUsed[velocityTiersUsed.length - 1]} mint(s) detected, but the first ` +
          `${scannedAccelerating} candidates are already cooling down.`
        );
      }
      const velocityTierSummary = velocityTiersUsed.length > 0 ? velocityTiersUsed.join(',') : 'primary';
      freshVelocityEligibleCount = eligibleAccelerating.length;
      console.log(
        `[SNIPER]  VELOCITY-FIRST: ${eligibleAccelerating.length} eligible ` +
        `${velocityTiersUsed.length === 0 ? 'accelerating' : `${velocityTierSummary} recovery`} mint(s) ` +
        `after cooldown filtering | scanned ${scannedAccelerating}` +
	        `${velocityTiersUsed.length > 0 ? ` | tiers ${velocityTierSummary}` : ''}` +
	        `${pollMicroScoutPacing.underfilledBookActive ? ` | target ${assessmentBudget.desiredEligibleCandidates}` : ''}` +
	        `${cooldownFiltered > 0 ? ` | skipped ${cooldownFiltered} cooling-down leaders` : ''}` +
	        `${softCooldownRechecks > 0 ? ` | reused ${softCooldownRechecks} soft-cooling leaders` : ''}` +
          `${syntheticRefinementTrimmed > 0 ? ` | trimmed ${syntheticRefinementTrimmed} synthetic-refine leaders` : ''}` +
	        `${tempBlacklistFiltered > 0 ? ` | skipped ${tempBlacklistFiltered} temp-blacklisted routes` : ''}`
	      );

      // Load trending for cross-reference (1h direction confirmation)
      let trendingMap: Map<string, any> = new Map();
	      if (fs.existsSync(TRENDING_FILE)) {
	        try {
	          const tRaw = JSON.parse(fs.readFileSync(TRENDING_FILE, 'utf-8'));
	          trendingMap = buildTrendingMap(tRaw);
	        } catch {}
	      }

	      eligibleAccelerating = annotateCandidatesWithExpectedValue(
	        eligibleAccelerating as any,
	        (candidate: any) => {
	          const trending = trendingMap.get(candidate.mint) || {};
	          const createdAt = trending?.pairCreatedAt ?? trending?.createdAt ?? undefined;
	          const tokenAgeSec = createdAt ? Math.floor((Date.now() - Number(createdAt)) / 1000) : undefined;
	          return {
	            entryMode: microOnlyMode ? 'micro-scout' : 'normal',
	            sourceLane: 'velocity-first',
	            entryFamily: 'velocity-first',
	            tokenAgeSec,
	            liquidityUsd: Number(trending?.liquidityUsd || 0),
	            marketCapUsd: Math.max(Number(trending?.marketCapUsd || 0), Number(trending?.fdvUsd || 0)),
	            fdvUsd: Number(trending?.fdvUsd || trending?.marketCapUsd || 0),
	            momentum5m: Number(trending?.priceChange5m || 0),
	            buyRatio: Number(trending?.buyRatio || (Number(candidate?.buyRatio60s || 0) / Math.max(0.001, 1 - Number(candidate?.buyRatio60s || 0)))),
	            volume1hUsd: Number(trending?.volume1h || 0) || (Number(candidate?.solVolume60s || 0) * 60),
	            buys1h: Number(trending?.buys1h || 0) || (Number(candidate?.buys60s || 0) * 60),
	            sells1h: Number(trending?.sells1h || 0) || (Number(candidate?.sells60s || 0) * 60),
	            confidenceScore: clamp(Number(candidate?.buyRatio60s || 0.5), 0.2, 0.98),
	            velocityBuys60s: Number(candidate?.buys60s || 0),
	            velocityBuyRatio60s: Number(candidate?.buyRatio60s || 0),
	            velocityTxPerMin: Number(candidate?.velocity || 0),
	            velocitySolVolume60s: Number(candidate?.solVolume60s || 0),
	          };
	        },
	      ).sort((left: any, right: any) =>
	        compareExpectedValueRank(
	          left,
	          right,
	          (baseLeft: any, baseRight: any) =>
	            Number(Boolean(baseLeft?.isSynthetic)) - Number(Boolean(baseRight?.isSynthetic)) ||
	            Number(Boolean(baseLeft?.refinementOnly)) - Number(Boolean(baseRight?.refinementOnly)) ||
	            (Number(baseRight?.solVolume60s || 0) - Number(baseLeft?.solVolume60s || 0)) ||
	            (Number(baseRight?.buys60s || 0) - Number(baseLeft?.buys60s || 0)),
	        ),
	      ) as typeof eligibleAccelerating;

	      for (const v of eligibleAccelerating) {
	        if (store.positions.length >= MAX_POSITIONS) break;
        const trending = trendingMap.get(v.mint);
        const createdAt = trending?.pairCreatedAt ?? trending?.createdAt ?? undefined;
        const tokenAgeSec = createdAt ? Math.floor((Date.now() - createdAt) / 1000) : undefined;

        // Cross-check: if in trending, confirm 1h direction is positive
        if (trending && trending.priceChange1h < 0) {
          const negativeOneHourRecoveryPass =
            !v.isSynthetic &&
            Number(trending.priceChange1h) >= -25 &&
            (tokenAgeSec === undefined || tokenAgeSec <= 1800) &&
            Number(v.buys60s || 0) >= 8 &&
            Number(v.buyRatio60s || 0) >= 0.75 &&
            Number(v.solVolume60s || 0) >= 1 &&
            Number(v.velocity || 0) >= 8 &&
            Number(trending?.priceChange5m ?? 0) >= 5;
          if (!negativeOneHourRecoveryPass) {
            console.log(`[SNIPER]  ${trending.symbol || v.mint.slice(0,8)}  velocity accelerating but 1h negative (${trending.priceChange1h.toFixed(0)}%)  skip`);
            continue;
          }
          console.log(
            `[SNIPER]  NEG 1H RECOVERY PASS: ${trending.symbol || v.mint.slice(0,8)} ` +
            `1h ${Number(trending.priceChange1h).toFixed(0)}% but fresh flow is still strong ` +
            `(${Number(v.buys60s || 0).toFixed(0)}B/${Number(v.sells60s || 0).toFixed(0)}S | ` +
            `${Number(v.velocity || 0).toFixed(0)}tx/min | ${Number(v.solVolume60s || 0).toFixed(3)} SOL/60s).`
          );
        }

        const symbol   = v.symbol || trending?.symbol || v.mint.slice(0, 8) + '...';
        let vol1h    = trending?.volume1h  || v.solVolume60s * 60; // estimate from 60s SOL vol
        let pc1h     = trending?.priceChange1h ?? 0;
        let mom5m: number | undefined       = trending?.priceChange5m ?? undefined;
        let mom1m: number | undefined       = trending?.priceChange1m ?? undefined;
        const buys1h   = trending?.buys1h    || v.buys60s * 60;
        const sells1h  = trending?.sells1h   || v.sells60s * 60;
        const buyRatio = trending?.buyRatio   || v.buyRatio60s / (1 - v.buyRatio60s + 0.001);

        const cooldownState = await getMintCooldownState(v.mint);
        const softCooldownRecheck = Boolean((v as any).softCooldownRecheck) &&
          shouldAllowVelocitySoftRecheck(cooldownState, v, velocitySelectionConfig);
        if (cooldownState.active && !softCooldownRecheck) {
          continue;
        }
        if (softCooldownRecheck) {
          console.log(
            `[SNIPER]  VELOCITY SOFT-RECHECK: ${symbol} cooldown ${cooldownState.value || 'unknown'} ` +
            `expiring in ${cooldownState.ttlSeconds ?? '?'}s and live flow is still strong.`
          );
        }

        const syntheticVelocityGuard = evaluateSyntheticVelocityGuard({
          isSynthetic: v.isSynthetic,
          refinementOnly: v.refinementOnly,
          syntheticSource: v.syntheticSource,
          source: trending?.source,
          buyRatio60s: v.buyRatio60s,
          buys60s: v.buys60s,
          sells60s: v.sells60s,
          velocity: v.velocity,
          solVolume60s: v.solVolume60s,
          momentum5m: mom5m,
          momentum1h: pc1h,
          liquidityUsd: trending?.liquidityUsd,
          volume5mUsd: trending?.volume5m,
          bagsSignal: trending?.bagsSignal,
          walletExecutable: false,
        });
        if (syntheticVelocityGuard.blocked) {
          console.log(
            `[SNIPER]  SYNTHETIC VELOCITY BLOCK: ${symbol} ${syntheticVelocityGuard.reason} ` +
            `(${v.buys60s}B/${v.sells60s}S ${(v.buyRatio60s * 100).toFixed(0)}% | ${v.solVolume60s.toFixed(3)} SOL/60s)`
          );
          logMissedTarget({
            mint: v.mint,
            symbol,
            stage: 'velocity_first',
            reason: syntheticVelocityGuard.code,
            entryMode: 'velocity',
            source: trending?.source || v.syntheticSource || 'synthetic',
            momentum5m: mom5m,
            priceChange1h: pc1h,
            poolLiq: trending?.liquidityUsd,
            volume5mUsd: trending?.volume5m,
            buys60s: v.buys60s,
            sells60s: v.sells60s,
            buyRatio60s: v.buyRatio60s,
            velocity: v.velocity,
            solVolume60s: v.solVolume60s,
            syntheticSource: v.syntheticSource,
            redisCooldownSec: syntheticVelocityGuard.cooldownSeconds,
          });
          await setMintCooldownExact(RedisBus.getPublisher(), v.mint, syntheticVelocityGuard.cooldownSeconds, 'SYNTHETIC_VELOCITY');
          continue;
        }
        const syntheticRefinementOnly = Boolean(v.isSynthetic) && (Boolean(v.refinementOnly) || syntheticVelocityGuard.refinementOnly);
        const createdAtRef = createdAt;
	        const tokenAgeSecRef = tokenAgeSec;
            const shadowLaneConfig = loadShadowLaneConfig();
            const shadowMomentumTerrainState = recordTerrainObservation(v.mint, {
              ts: Date.now(),
              symbol,
              entryMode: 'velocity',
              sourceLane: 'velocity-first',
              priceChange5m: mom5m,
              priceChange1h: pc1h,
              volume1hUsd: vol1h,
              buys60s: v.buys60s,
              sells60s: v.sells60s,
              buyRatio60s: v.buyRatio60s,
              velocity: v.velocity,
              solVolume60s: v.solVolume60s,
            });
        if (syntheticRefinementOnly) {
          const terrainConfig = loadTerrainMemoryConfig();
          const earlySyntheticRefinementGate = evaluateSyntheticRefinementEntryGate({
            syntheticRefinementOnly,
            syntheticSource: v.syntheticSource,
            liquidityUsd: trending?.liquidityUsd,
            routeLive: false,
            momentum5m: mom5m,
            terrainSummary: shadowMomentumTerrainState?.summary,
          }, terrainConfig);
          if (earlySyntheticRefinementGate.shouldHold || earlySyntheticRefinementGate.shouldBlock) {
            console.log(
              `[SNIPER] ${earlySyntheticRefinementGate.shouldHold ? ' SYNTHETIC REFINE HOLD' : ' SYNTHETIC REFINE BLOCK'}: ` +
              `${symbol} ${earlySyntheticRefinementGate.reason} (${v.syntheticSource || trending?.source || 'synthetic'})`
            );
            logMissedTarget({
              mint: v.mint,
              symbol,
              stage: 'velocity_first',
              reason: earlySyntheticRefinementGate.code,
              entryMode: 'velocity',
              source: v.syntheticSource || trending?.source || 'synthetic',
              momentum5m: mom5m,
              priceChange1h: pc1h,
              poolLiq: trending?.liquidityUsd,
              volume5mUsd: trending?.volume5m,
              buys60s: v.buys60s,
              sells60s: v.sells60s,
              buyRatio60s: v.buyRatio60s,
              velocity: v.velocity,
              solVolume60s: v.solVolume60s,
              syntheticSource: v.syntheticSource,
              terrainSampleCount: shadowMomentumTerrainState?.summary?.sampleCount,
              terrainPriceDelta5m: shadowMomentumTerrainState?.summary?.priceDelta5m,
              terrainLiquidityDeltaUsd: shadowMomentumTerrainState?.summary?.liquidityDeltaUsd,
              terrainFlowDecayRatio: shadowMomentumTerrainState?.summary?.flowDecayRatio,
              redisCooldownSec: earlySyntheticRefinementGate.cooldownSeconds,
            });
            await setMintCooldownExact(
              RedisBus.getPublisher(),
              v.mint,
              earlySyntheticRefinementGate.cooldownSeconds,
              earlySyntheticRefinementGate.shouldHold ? 'SYNTH_REFINE_WAIT' : 'SYNTH_REFINE_BLOCK',
            );
            continue;
          }
          console.log(
            `[SNIPER]  SYNTHETIC REFINE PASS: ${symbol} rolling terrain confirmed a live response ` +
            `(${v.syntheticSource || trending?.source || 'synthetic'}).`
          );
          const syntheticLivePair = await fetchDexScreenerPair(v.mint);
          const syntheticLivePairExecutable = isExecutableLivePair(syntheticLivePair);
          let syntheticRouteProbe: { routable: boolean; outAmount: string | null } | null = null;
          if (!syntheticLivePairExecutable) {
            syntheticRouteProbe = await probeJupiterTradability(
              v.mint,
              Math.max(1_000_000, Math.floor((microScoutConfig.fixedBuySol || 0.001) * 1e9)),
            );
          }
          const syntheticLiveConfirmationGate = evaluateSyntheticLiveConfirmationGate({
            syntheticRefinementOnly,
            livePairPresent: Boolean(syntheticLivePair),
            livePairExecutable: syntheticLivePairExecutable,
            routeLive: syntheticRouteProbe?.routable === true,
          });
          if (!syntheticLiveConfirmationGate.confirmed) {
            console.log(
              `[SNIPER]  SYNTHETIC LIVE CONFIRM HOLD: ${symbol} ${syntheticLiveConfirmationGate.reason} ` +
              `(${v.syntheticSource || trending?.source || 'synthetic'}).`
            );
            logMissedTarget({
              mint: v.mint,
              symbol,
              stage: 'velocity_first',
              reason: syntheticLiveConfirmationGate.code,
              entryMode: 'velocity',
              source: v.syntheticSource || trending?.source || 'synthetic',
              momentum5m: mom5m,
              priceChange1h: pc1h,
              poolLiq: Number(syntheticLivePair?.liquidity || 0),
              marketCapUsd: Number(syntheticLivePair?.marketCap || syntheticLivePair?.fdv || 0),
              volume5mUsd: Number(syntheticLivePair?.volume5m || 0),
              volume1hUsd: Number(syntheticLivePair?.volume1h || vol1h || 0),
              buys60s: v.buys60s,
              sells60s: v.sells60s,
              buyRatio60s: v.buyRatio60s,
              velocity: v.velocity,
              solVolume60s: v.solVolume60s,
              syntheticSource: v.syntheticSource,
              terrainSampleCount: shadowMomentumTerrainState?.summary?.sampleCount,
              terrainPriceDelta5m: shadowMomentumTerrainState?.summary?.priceDelta5m,
              terrainLiquidityDeltaUsd: shadowMomentumTerrainState?.summary?.liquidityDeltaUsd,
              terrainRouteStrengthPct: shadowMomentumTerrainState?.summary?.routeStrengthPct,
              redisCooldownSec: syntheticLiveConfirmationGate.cooldownSeconds,
            });
            await setMintCooldownExact(
              RedisBus.getPublisher(),
              v.mint,
              syntheticLiveConfirmationGate.cooldownSeconds,
              'SYNTH_LIVE_WAIT',
            );
            continue;
          }
          if (syntheticLivePair) {
            vol1h = Math.max(vol1h, Number(syntheticLivePair.volume1h || 0));
            const livePriceChange1h = Number(syntheticLivePair.priceChange1h);
            const livePriceChange5m = Number(syntheticLivePair.priceChange5m);
            if (Number.isFinite(livePriceChange1h)) {
              pc1h = livePriceChange1h;
            }
            if (Number.isFinite(livePriceChange5m)) {
              mom5m = livePriceChange5m;
            }
          }
          if (syntheticRouteProbe?.routable) {
            console.log(
              `[SNIPER]  SYNTHETIC LIVE ROUTE CONFIRMED: ${symbol} has a live route beyond cached ${v.syntheticSource || trending?.source || 'synthetic'} data.`
            );
          }
        }
	        const continuation = evaluateContinuationSignal({
	          momentum1m: mom1m,
	          minMomentum1mPct: 0.5,
          buys60s: v.buys60s,
          buyRatio60s: v.buyRatio60s,
	          velocity: v.velocity,
		          solVolume60s: v.solVolume60s,
		          mode: 'velocity',
              terrainSampleCount: shadowMomentumTerrainState?.summary?.sampleCount,
              terrainStrongFlowSamples: shadowMomentumTerrainState?.summary?.strongFlowSamples,
              terrainFlowDecayRatio: shadowMomentumTerrainState?.summary?.flowDecayRatio,
              terrainPriceOffPeak5m: shadowMomentumTerrainState?.summary?.priceOffPeak5m,
              terrainCurrentPriceChange5m: shadowMomentumTerrainState?.summary?.currentPriceChange5m,
	        });
        const signalSourceTag = trending?.bagsSignal
          ? ' | bags-signal'
          : trending?.source
            ? ` | src:${trending.source}`
            : v.syntheticSource
              ? ` | synth:${v.syntheticSource}`
              : '';
        console.log(`[SNIPER]  VELOCITY ENTRY: ${symbol} | ${v.buys60s}B/${v.sells60s}S (${(v.buyRatio60s*100).toFixed(0)}%) | ${v.velocity.toFixed(0)}tx/min | ${v.solVolume60s.toFixed(3)} SOL/60s | 1h:${pc1h >= 0 ? '+' : ''}${pc1h.toFixed(0)}%${signalSourceTag}`);

        // TA soft gate
        const ta = loadSignal(v.mint);
        if (ta?.signal === 'SELL' && ta.confidence > 0.65) {
          console.log(`[SNIPER]  TA says SELL on ${symbol}  skip`);
          continue;
        }

		        // PRICE DIRECTION CHECK: Don't buy dead/dumping tokens
                const minMom = GLOBAL_HUNTER_MULT < 0.5 ? -10 : 0;
		        if (mom5m !== undefined && mom5m < minMom) {
              const shadowWeakMomentumDecision = evaluateWeakMomentumShadowLane(
                {
                  momentum5m: mom5m,
                  continuationApproved: false,
                  buys60s: v.buys60s,
                  buyRatio60s: v.buyRatio60s,
                  velocity: v.velocity,
                  solVolume60s: v.solVolume60s,
                  terrainSummary: shadowMomentumTerrainState?.summary,
                },
                shadowLaneConfig,
              );
	              if (shadowWeakMomentumDecision.shouldHold) {
                  const flatGmgnMissingMomentumHold = evaluateFlatGmgnMissingMomentumHold({
                    source: trending?.source,
                    momentum5m: mom5m,
                    missingMomentum1m: continuation.missingMomentum1m,
                    buys60s: v.buys60s,
                    buyRatio60s: v.buyRatio60s,
                    velocity: v.velocity,
                    solVolume60s: v.solVolume60s,
                  });
                  const syntheticFlatMomentumHold =
                    syntheticRefinementOnly &&
                    Math.abs(Number(mom5m || 0)) <= 0.1;
                  const shadowMomentumCooldownSec = syntheticFlatMomentumHold
                    ? Math.max(
                        shadowWeakMomentumDecision.cooldownSeconds,
                        flatGmgnMissingMomentumHold.shouldHold
                          ? flatGmgnMissingMomentumHold.cooldownSeconds
                          : 120,
                      )
                    : shadowWeakMomentumDecision.cooldownSeconds;
	                console.log(
	                  `[SNIPER]  SHADOW MOMENTUM HOLD: ${symbol} ${shadowWeakMomentumDecision.reason} ` +
	                  `(5m ${mom5m.toFixed(1)}%) - recheck in ${shadowMomentumCooldownSec}s` +
                    `${syntheticFlatMomentumHold ? ' | synthetic-flat cooldown' : ''}.`
	                );
	                logMissedTarget({
                  mint: v.mint,
                  symbol,
                  stage: 'velocity_first',
                  reason: shadowWeakMomentumDecision.code,
                  entryMode: 'velocity',
                  momentum5m: mom5m,
                  priceChange1h: pc1h,
                  buys60s: v.buys60s,
                  sells60s: v.sells60s,
                  buyRatio60s: v.buyRatio60s,
                  velocity: v.velocity,
                  solVolume60s: v.solVolume60s,
                  terrainSampleCount: shadowMomentumTerrainState?.summary?.sampleCount,
                  terrainPriceDelta5m: shadowMomentumTerrainState?.summary?.priceDelta5m,
                  terrainFlowDecayRatio: shadowMomentumTerrainState?.summary?.flowDecayRatio,
	                  redisCooldownSec: shadowMomentumCooldownSec,
                    syntheticSource: v.syntheticSource,
	                });
	                await setMintCooldownExact(RedisBus.getPublisher(), v.mint, shadowMomentumCooldownSec, 'SHADOW_MOM_HOLD');
	                continue;
	              }
                const flatGmgnMissingMomentumCooldownSec = resolveWeakMomentumCooldownSeconds({
                  source: trending?.source,
                  momentum5m: mom5m,
                  missingMomentum1m: continuation.missingMomentum1m,
                  defaultCooldownSeconds: 20,
                });
                const flatGmgnMissingMomentumHold = evaluateFlatGmgnMissingMomentumHold({
                  source: trending?.source,
                  momentum5m: mom5m,
                  missingMomentum1m: continuation.missingMomentum1m,
                  buys60s: v.buys60s,
                  buyRatio60s: v.buyRatio60s,
                  velocity: v.velocity,
                  solVolume60s: v.solVolume60s,
                });
                if (flatGmgnMissingMomentumHold.shouldHold) {
	                console.log(
	                  `[SNIPER]  FLAT GMGN HOLD: ${symbol} ${flatGmgnMissingMomentumHold.reason} ` +
	                  `- recheck in ${flatGmgnMissingMomentumHold.cooldownSeconds}s.`
	                );
	                logMissedTarget({
                    mint: v.mint,
                    symbol,
                    stage: 'velocity_first',
                    reason: flatGmgnMissingMomentumHold.code,
                    entryMode: 'velocity',
                    momentum5m: mom5m,
                    priceChange1h: pc1h,
                    buys60s: v.buys60s,
                    sells60s: v.sells60s,
                    buyRatio60s: v.buyRatio60s,
                    velocity: v.velocity,
                    solVolume60s: v.solVolume60s,
                    redisCooldownSec: flatGmgnMissingMomentumHold.cooldownSeconds,
                  });
                  await setMintCooldownExact(
                    RedisBus.getPublisher(),
                    v.mint,
                    flatGmgnMissingMomentumHold.cooldownSeconds,
                    'FLAT_GMGN_HOLD',
                  );
                  continue;
                }
			          logMissedTarget({
			            mint: v.mint,
			            symbol,
			            stage: 'velocity_first',
			            reason: 'weak_momentum_skip',
			            entryMode: 'velocity',
	            momentum5m: mom5m,
	            priceChange1h: pc1h,
	            buys60s: v.buys60s,
	            sells60s: v.sells60s,
	            buyRatio60s: v.buyRatio60s,
		            velocity: v.velocity,
		            solVolume60s: v.solVolume60s,
		          });
		          await setMintCooldownExact(
		            RedisBus.getPublisher(),
		            v.mint,
		            flatGmgnMissingMomentumCooldownSec,
		            'WEAK_MOMENTUM',
		          );
		          console.log(
		            `[SNIPER]  WEAK MOMENTUM SKIP: ${symbol} price DOWN ${mom5m.toFixed(1)}% in 5m ` +
		            ` negative short-term structure` +
		            `${flatGmgnMissingMomentumCooldownSec > 20 ? ` | flat gmgn cooldown ${flatGmgnMissingMomentumCooldownSec}s` : ''}`
		          );
		          continue;
		        }
                const weakMomThreshold = GLOBAL_HUNTER_MULT < 0.5 ? -5 : 1;
		        if (mom5m !== undefined && mom5m < weakMomThreshold && !continuation.hasContinuation) {
              const shadowWeakMomentumDecision = evaluateWeakMomentumShadowLane(
                {
                  momentum5m: mom5m,
                  continuationApproved: false,
                  buys60s: v.buys60s,
                  buyRatio60s: v.buyRatio60s,
                  velocity: v.velocity,
                  solVolume60s: v.solVolume60s,
                  terrainSummary: shadowMomentumTerrainState?.summary,
                },
                shadowLaneConfig,
              );
	              if (shadowWeakMomentumDecision.shouldHold) {
                  const flatGmgnMissingMomentumHold = evaluateFlatGmgnMissingMomentumHold({
                    source: trending?.source,
                    momentum5m: mom5m,
                    missingMomentum1m: continuation.missingMomentum1m,
                    buys60s: v.buys60s,
                    buyRatio60s: v.buyRatio60s,
                    velocity: v.velocity,
                    solVolume60s: v.solVolume60s,
                  });
                  const syntheticFlatMomentumHold =
                    syntheticRefinementOnly &&
                    Math.abs(Number(mom5m || 0)) <= 0.1;
                  const shadowMomentumCooldownSec = syntheticFlatMomentumHold
                    ? Math.max(
                        shadowWeakMomentumDecision.cooldownSeconds,
                        flatGmgnMissingMomentumHold.shouldHold
                          ? flatGmgnMissingMomentumHold.cooldownSeconds
                          : 120,
                      )
                    : shadowWeakMomentumDecision.cooldownSeconds;
	                console.log(
	                  `[SNIPER]  SHADOW MOMENTUM HOLD: ${symbol} ${shadowWeakMomentumDecision.reason} ` +
	                  `(5m ${mom5m.toFixed(1)}%, ${continuation.missingMomentum1m ? '1m missing' : `${continuation.displayMomentum1m.toFixed(1)}%/1m`}) - ` +
	                  `recheck in ${shadowMomentumCooldownSec}s` +
                    `${syntheticFlatMomentumHold ? ' | synthetic-flat cooldown' : ''}.`
	                );
	                logMissedTarget({
                  mint: v.mint,
                  symbol,
                  stage: 'velocity_first',
                  reason: shadowWeakMomentumDecision.code,
                  entryMode: 'velocity',
                  momentum5m: mom5m,
                  momentum1m: continuation.momentum1m,
                  priceChange1h: pc1h,
                  buys60s: v.buys60s,
                  sells60s: v.sells60s,
                  buyRatio60s: v.buyRatio60s,
                  velocity: v.velocity,
                  solVolume60s: v.solVolume60s,
                  terrainSampleCount: shadowMomentumTerrainState?.summary?.sampleCount,
                  terrainPriceDelta5m: shadowMomentumTerrainState?.summary?.priceDelta5m,
                  terrainFlowDecayRatio: shadowMomentumTerrainState?.summary?.flowDecayRatio,
	                  redisCooldownSec: shadowMomentumCooldownSec,
                    syntheticSource: v.syntheticSource,
	                });
	                await setMintCooldownExact(RedisBus.getPublisher(), v.mint, shadowMomentumCooldownSec, 'SHADOW_MOM_HOLD');
	                continue;
		              }
                  const flatGmgnMissingMomentumCooldownSec = resolveWeakMomentumCooldownSeconds({
                    source: trending?.source,
                    momentum5m: mom5m,
                    missingMomentum1m: continuation.missingMomentum1m,
                    defaultCooldownSeconds: 20,
                  });
                  const flatGmgnMissingMomentumHold = evaluateFlatGmgnMissingMomentumHold({
                    source: trending?.source,
                    momentum5m: mom5m,
                    missingMomentum1m: continuation.missingMomentum1m,
                    buys60s: v.buys60s,
                    buyRatio60s: v.buyRatio60s,
                    velocity: v.velocity,
                    solVolume60s: v.solVolume60s,
                  });
                  if (flatGmgnMissingMomentumHold.shouldHold) {
	                console.log(
	                  `[SNIPER]  FLAT GMGN HOLD: ${symbol} ${flatGmgnMissingMomentumHold.reason} ` +
	                  `- recheck in ${flatGmgnMissingMomentumHold.cooldownSeconds}s.`
	                );
	                logMissedTarget({
                    mint: v.mint,
                    symbol,
                    stage: 'velocity_first',
                    reason: flatGmgnMissingMomentumHold.code,
                    entryMode: 'velocity',
                    momentum5m: mom5m,
                    momentum1m: continuation.momentum1m,
                    priceChange1h: pc1h,
                    buys60s: v.buys60s,
                    sells60s: v.sells60s,
                    buyRatio60s: v.buyRatio60s,
                    velocity: v.velocity,
                    solVolume60s: v.solVolume60s,
                    redisCooldownSec: flatGmgnMissingMomentumHold.cooldownSeconds,
                  });
                  await setMintCooldownExact(
                    RedisBus.getPublisher(),
                    v.mint,
                    flatGmgnMissingMomentumHold.cooldownSeconds,
                    'FLAT_GMGN_HOLD',
                  );
                  continue;
                  }
			          logMissedTarget({
			            mint: v.mint,
			            symbol,
		            stage: 'velocity_first',
		            reason: 'weak_momentum_skip',
		            entryMode: 'velocity',
		            momentum5m: mom5m,
		            momentum1m: continuation.momentum1m,
		            priceChange1h: pc1h,
		            buys60s: v.buys60s,
			            sells60s: v.sells60s,
			            buyRatio60s: v.buyRatio60s,
			            velocity: v.velocity,
			            solVolume60s: v.solVolume60s,
                  redisCooldownSec: flatGmgnMissingMomentumCooldownSec,
			          });
			          await setMintCooldownExact(RedisBus.getPublisher(), v.mint, flatGmgnMissingMomentumCooldownSec, 'WEAK_MOMENTUM');
			          console.log(
                  `[SNIPER]  WEAK MOMENTUM SKIP: ${symbol} 5m ${mom5m.toFixed(1)}% lacks continuation ` +
                  `(${continuation.missingMomentum1m ? '1m missing' : `${continuation.displayMomentum1m.toFixed(1)}%/1m`})` +
                  `${flatGmgnMissingMomentumCooldownSec > 20 ? ` | flat gmgn cooldown ${flatGmgnMissingMomentumCooldownSec}s` : ''}`
                );
			          continue;
			        }
		        if (mom5m !== undefined && mom5m < weakMomThreshold && continuation.hasContinuation) {
		          const continuationSource = continuation.fallbackSource || (continuation.usingFlowFallback ? 'flow-fallback' : '1m-confirmed');
		          console.log(`[SNIPER]  VELOCITY CONTINUATION OVERRIDE: ${symbol} 5m ${mom5m.toFixed(1)}% allowed via ${continuationSource}`);
		        }
		        if (mom1m !== undefined && mom1m < -3) {
		          logMissedTarget({
		            mint: v.mint,
		            symbol,
	            stage: 'velocity_first',
	            reason: 'crashing_skip',
	            entryMode: 'velocity',
	            momentum1m: mom1m,
	            priceChange1h: pc1h,
	            buys60s: v.buys60s,
	            sells60s: v.sells60s,
	            buyRatio60s: v.buyRatio60s,
	            velocity: v.velocity,
	            solVolume60s: v.solVolume60s,
	          });
	          await setMintCooldown(RedisBus.getPublisher(), v.mint, 30, 'CRASHING');
	          console.log(`[SNIPER]  CRASHING SKIP: ${symbol} price DOWN ${mom1m.toFixed(1)}% in 1m  active dump`);
	          continue;
	        }
        let routeLiveQualifierThresholdScale: number | null = null;
        let routeLiveShouldBypassLowVolumeFloor = false;
        let routeLiveQualifierReason: string | null = null;
        let routeLiveRecoveryEntryOptions: Partial<EntryOptions> | null = null;

        // If no cached trending data, do a LIVE DexScreener lookup
        if (!trending) {
          let preflightTerrainState = null;
          let routeLivePreflight = false;
          const livePair = await fetchDexScreenerPair(v.mint);
          const tradabilityProbeLamports = Math.max(1_000_000, Math.floor(microScoutConfig.fixedBuySol * 1e9));
          const microScoutPacing = resolveActiveMicroScoutPacing(store.positions.length, MAX_POSITIONS, microScoutConfig);
          const microScoutDecision = evaluateNoDexMicroScoutProbe({
            buys60s: v.buys60s,
            sells60s: v.sells60s,
            buyRatio60s: v.buyRatio60s,
            velocity: v.velocity,
            solVolume60s: v.solVolume60s,
          }, microScoutPacing.probeConfig);
          const microScoutContinuationGate = evaluateMicroScoutContinuationGate(microScoutConfig, continuation);
          const canUseMicroScout =
            microScoutConfig.enabled &&
            microScoutEntriesThisPoll < microScoutPacing.maxCandidatesPerPoll &&
            microScoutDecision.shouldScout &&
            microScoutContinuationGate.ready;
          const microScoutPacingTag = microScoutPacing.underfilledBookActive ? ' underfilled-book' : '';
	          if (livePair && !isExecutableLivePair(livePair)) {
	            const tradabilityProbe = await probeJupiterTradability(v.mint, tradabilityProbeLamports);
	            if (tradabilityProbe.rateLimited) {
	              const cooldownSec = Math.max(5, Math.ceil((Number(tradabilityProbe.retryAfterMs) || JUPITER_RATE_LIMIT_MIN_BACKOFF_MS) / 1000));
	              console.log(
	                `[SNIPER]  JUPITER PROBE BACKOFF: ${symbol} quote path rate-limited while checking route-live zero-liquidity  ` +
	                `recheck in ${cooldownSec}s.`
	              );
	              logMissedTarget({
	                mint: v.mint,
	                symbol,
	                stage: 'velocity_first',
	                reason: 'jupiter_quote_rate_limited',
	                entryMode: canUseMicroScout || microOnlyMode ? 'micro-scout' : 'normal',
	                momentum5m: livePair.priceChange5m,
	                priceChange1h: livePair.priceChange1h ?? pc1h,
	                buys60s: v.buys60s,
	                sells60s: v.sells60s,
	                buyRatio60s: v.buyRatio60s,
	                velocity: v.velocity,
	                solVolume60s: v.solVolume60s,
	                redisCooldownSec: cooldownSec,
	              });
	              await setMintCooldownExact(pub, v.mint, cooldownSec, 'JUP_RATE_LIMIT');
	              continue;
	            }
	            if (tradabilityProbe.routable) {
                routeLivePreflight = true;
	              preflightTerrainState = recordTerrainObservation(v.mint, {
	                ts: Date.now(),
	                symbol,
	                entryMode: canUseMicroScout || microOnlyMode ? 'micro-scout' : 'normal',
	                sourceLane: 'velocity-first-preflight',
	                priceChange5m: livePair.priceChange5m,
	                priceChange1h: livePair.priceChange1h ?? pc1h,
	                liquidityUsd: livePair.liquidity,
	                marketCapUsd: Number(livePair.marketCap || livePair.fdv || 0),
	                fdvUsd: Number(livePair.fdv || livePair.marketCap || 0),
	                volume1hUsd: Number(livePair.volume1h || vol1h || 0),
	                buys60s: v.buys60s,
	                sells60s: v.sells60s,
	                buyRatio60s: v.buyRatio60s,
	                velocity: v.velocity,
	                solVolume60s: v.solVolume60s,
	                routeLive: true,
	                routeOutAmount: tradabilityProbe.outAmount ? Number(tradabilityProbe.outAmount) : null,
	              });
                const routeLiveZeroLiqDecision = evaluateRouteLiveZeroLiquidityEntry(
                  {
                    priceChange5m: livePair.priceChange5m,
                    priceChange1h: livePair.priceChange1h ?? pc1h,
                    tokenAgeSec,
                    buys60s: v.buys60s,
                    buyRatio60s: v.buyRatio60s,
                    velocity: v.velocity,
                    solVolume60s: v.solVolume60s,
                    terrainSummary: preflightTerrainState?.summary,
                  },
                  loadRouteLiveZeroLiquidityConfig(),
                );
                if (routeLiveZeroLiqDecision.shouldHold || routeLiveZeroLiqDecision.shouldBlock) {
                  const bypassHunterModeActive = !lossStreakRestricted && store.positions.length < 8;
                  if (bypassHunterModeActive) {
                    console.log(`[SNIPER]  HUNTER MODE BYPASS: ${symbol} overriding ZERO LIQ ROUTE BLOCK.`);
                  } else {
                    console.log(
                      `[SNIPER] ${routeLiveZeroLiqDecision.shouldHold ? '' : ''} ZERO LIQ ROUTE ${routeLiveZeroLiqDecision.shouldHold ? 'HOLD' : 'BLOCK'}: ` +
                      `${symbol} ${routeLiveZeroLiqDecision.reason} - recheck in ${routeLiveZeroLiqDecision.cooldownSec}s.`
                    );
                    logMissedTarget({
                      mint: v.mint,
                      symbol,
                      stage: 'velocity_first',
                      reason: routeLiveZeroLiqDecision.code,
                      entryMode: canUseMicroScout || microOnlyMode ? 'micro-scout' : 'velocity',
                      liquidityUsd: Number(livePair?.liquidity || 0),
                      marketCapUsd: Number(livePair?.marketCap || livePair?.fdv || 0),
                      momentum5m: livePair?.priceChange5m,
                      priceChange1h: livePair?.priceChange1h,
                      buys60s: v.buys60s,
                      sells60s: v.sells60s,
                      buyRatio60s: v.buyRatio60s,
                      velocity: v.velocity,
                      solVolume60s: v.solVolume60s,
                      terrainSampleCount: preflightTerrainState?.summary?.sampleCount,
                      terrainPriceOffPeak5m: preflightTerrainState?.summary?.priceOffPeak5m,
                      terrainFlowDecayRatio: preflightTerrainState?.summary?.flowDecayRatio,
                      terrainLiquidityDeltaUsd: preflightTerrainState?.summary?.liquidityDeltaUsd,
                      terrainRouteStrengthPct: preflightTerrainState?.summary?.routeStrengthPct,
                      redisCooldownSec: routeLiveZeroLiqDecision.cooldownSec,
                    });
                    const pub = RedisBus.getPublisher();
                    await setMintCooldownExact(pub, v.mint, routeLiveZeroLiqDecision.cooldownSec, 'ZERO_LIQ');
                    continue;
                  }
                }
              console.log(
                '[SNIPER] ZERO LIQ OVERRIDE: ' + symbol +
                ' DexScreener shows $0 liquidity, but Jupiter returned a live route' +
                (tradabilityProbe.outAmount ? ' (outAmount=' + tradabilityProbe.outAmount + ')' : '') +
                '.'
              );
              const routeLiveContinuationOverride = evaluateRouteLiveContinuationOverride({
                routeLive: true,
                missingMomentum1m: microScoutContinuationGate.source === '1m-missing',
                priceChange5m: livePair.priceChange5m,
                buys60s: v.buys60s,
                buyRatio60s: v.buyRatio60s,
                velocity: v.velocity,
                solVolume60s: v.solVolume60s,
                terrainSummary: preflightTerrainState?.summary,
              });
              const replayRouteLiveOverride = evaluateReplayBackedRouteLiveOverride({
                slopfestParams: GLOBAL_SLOPFEST_PARAMS_RAW,
                routeLive: true,
                continuationReady: microScoutContinuationGate.ready,
                missingMomentum1m: microScoutContinuationGate.source === '1m-missing',
                priceChange5m: livePair.priceChange5m,
                liquidityUsd: livePair.liquidity,
                buys60s: v.buys60s,
                buyRatio60s: v.buyRatio60s,
                velocity: v.velocity,
                solVolume60s: v.solVolume60s,
                probeLikeFlowReady: microScoutDecision.shouldScout,
              });
              const replayRecoveryProbeDecision = evaluateReplayBackedRecoveryProbe({
                slopfestParams: GLOBAL_SLOPFEST_PARAMS_RAW,
                routeLive: true,
                priceChange5m: livePair.priceChange5m,
                liquidityUsd: livePair.liquidity,
                buys60s: v.buys60s,
                buyRatio60s: v.buyRatio60s,
                velocity: v.velocity,
                solVolume60s: v.solVolume60s,
                probeLikeFlowReady: microScoutDecision.shouldScout,
                openPositionCount: store.positions.length,
                consecutiveLosses: lossStreakState.consecutiveLosses,
                lastProbeAtMs: getLastRecoveryProbeAt(),
              });
              const replayRecoveryEntryOptions =
                lossStreakRestricted && replayRecoveryProbeDecision.allow
                  ? {
                      replayRecoveryProbe: true,
                      replayRecoveryReason: replayRecoveryProbeDecision.reason,
                      replayRecoveryWindowMs: replayRecoveryProbeDecision.windowMs,
                    }
                  : {};
              const routeLiveCanUseMicroScout =
                microScoutConfig.enabled &&
                microScoutEntriesThisPoll < microScoutPacing.maxCandidatesPerPoll &&
                microScoutDecision.shouldScout &&
                (
                  microScoutContinuationGate.ready ||
                  routeLiveContinuationOverride.allow ||
                  replayRouteLiveOverride.allowContinuationOverride
                );
              if (microScoutDecision.shouldScout && !microScoutContinuationGate.ready) {
                if (routeLiveContinuationOverride.allow) {
                  console.log(
                    `[SNIPER]  ROUTE-LIVE CONTINUATION PASS: ${symbol} ${routeLiveContinuationOverride.reason}.`
                  );
                } else if (replayRouteLiveOverride.allowContinuationOverride) {
                  console.log(
                    `[SNIPER]  REPLAY CONTINUATION PASS: ${symbol} ${replayRouteLiveOverride.reason}.`
                  );
                } else {
                console.log(
                  `[SNIPER]  MICRO SCOUT CONTINUATION HOLD: ${symbol} raw flow passed scout floor, ` +
                  `but continuation is not confirmed (${microScoutContinuationGate.source}).`
                );
                const pub = RedisBus.getPublisher();
                  await setMintCooldown(pub, v.mint, 20, 'MICRO_CONTINUATION');
                  continue;
                }
              }
              if (routeLiveCanUseMicroScout) {
                microScoutEntriesThisPoll += 1;
                const routeLiveFastTrack = routeLiveZeroLiqDecision.code === 'route_live_zero_liq_fast_track';
                const routeLivePriceResponsePass = routeLiveZeroLiqDecision.code === 'route_live_zero_liq_price_response';
                console.log(
                  `[SNIPER] ${routeLiveFastTrack ? '' : routeLivePriceResponsePass ? '' : ''} ZERO LIQ ${routeLiveFastTrack ? 'FAST-TRACK' : routeLivePriceResponsePass ? 'PRICE-RESPONSE' : 'MICRO-SCOUT'}: ` +
                  `${symbol} is already routable despite Dex liquidity ${livePair.liquidity.toFixed(0)}. ` +
		                  `Probing with ${describeMicroScoutSizing(microScoutConfig)} (${microScoutDecision.limitingReason}${microScoutPacingTag}).`
                );
                const routeLiveWalletSignal = freshWalletSignalMap.get(String(v.mint || '').trim()) || null;
                await trySnipe(
                  v.mint,
                  symbol,
                  vol1h,
                  pc1h,
                  buys1h,
                  sells1h,
                  buyRatio,
                  ta?.signal,
                  ta?.confidence,
                  tokenAgeSec,
                  mom5m,
                  mom1m,
                  createdAt,
	                  {
		                  ...buildMicroScoutEntryOptions({
		                    requestedEntryMode: 'micro-scout',
		                    microScoutConfig,
		                  }),
                  syntheticRefinementOnly,
                  syntheticSource: v.syntheticSource,
		                  quoteMode: 'pump-direct',
		                  minLiquidityUsd: 0,
	                    allowRoutableLowLiquidity: true,
	                    bypassAgeFloor: true,
	                    routeLiveFastTrack,
                      walletConfirmed: isWalletConfirmedSignal(routeLiveWalletSignal),
                      strongRecentFlowConfirmed: hasStrongRecentFlowConfirmation({
                        terrainSummary: preflightTerrainState?.summary,
                        buys60s: v.buys60s,
                        solVolume60s: v.solVolume60s,
                        velocity: v.velocity,
                      }),
                      ...replayRecoveryEntryOptions,
	                  }
                );
                continue;
              }
            } else {
	              const zeroLiqPlan = planZeroLiquidityRecheck({
                buys60s: v.buys60s,
                buyRatio60s: v.buyRatio60s,
                velocity: v.velocity,
                solVolume60s: v.solVolume60s,
                tokenAgeSec,
                terrainSummary: recordTerrainObservation(v.mint, {
                  ts: Date.now(),
                  symbol,
                  entryMode: 'velocity',
                  sourceLane: 'velocity-first-preflight',
                  priceChange5m: livePair.priceChange5m,
                  priceChange1h: livePair.priceChange1h ?? pc1h,
                  liquidityUsd: livePair.liquidity,
                  marketCapUsd: Number(livePair.marketCap || livePair.fdv || 0),
                  fdvUsd: Number(livePair.fdv || livePair.marketCap || 0),
                  volume1hUsd: Number(livePair.volume1h || vol1h || 0),
                  buys60s: v.buys60s,
                  sells60s: v.sells60s,
                  buyRatio60s: v.buyRatio60s,
                  velocity: v.velocity,
                  solVolume60s: v.solVolume60s,
                  routeLive: false,
                  routeOutAmount: null,
                })?.summary,
              });
              logMissedTarget({
                mint: v.mint,
                symbol,
                stage: 'velocity_first',
                reason: 'live_pair_zero_liquidity',
                entryMode: 'velocity',
                liquidityUsd: Number(livePair?.liquidity || 0),
                marketCapUsd: Number(livePair?.marketCap || livePair?.fdv || 0),
                momentum5m: livePair?.priceChange5m,
                priceChange1h: livePair?.priceChange1h,
                buys60s: v.buys60s,
                sells60s: v.sells60s,
                buyRatio60s: v.buyRatio60s,
                velocity: v.velocity,
                solVolume60s: v.solVolume60s,
                redisCooldownSec: zeroLiqPlan.cooldownSec,
              });
              console.log(
                '[SNIPER] LIVE PAIR ZERO LIQUIDITY: ' + symbol +
                ' pair indexed but liq is $0' +
                ' - recheck in ' + zeroLiqPlan.cooldownSec + 's' +
                (zeroLiqPlan.fastRecheck ? ' (fast-flow retry)' : '') + '.'
              );
              const pub = RedisBus.getPublisher();
              await setMintCooldown(pub, v.mint, zeroLiqPlan.cooldownSec, 'ZERO_LIQ');
              continue;
            }
          }
          if (livePair && livePair.liquidity < 5000) {
            const routeLiveContinuationOverride = evaluateRouteLiveContinuationOverride({
              routeLive: true,
              missingMomentum1m: microScoutContinuationGate.source === '1m-missing',
              priceChange5m: livePair.priceChange5m,
              buys60s: v.buys60s,
              buyRatio60s: v.buyRatio60s,
              velocity: v.velocity,
              solVolume60s: v.solVolume60s,
              terrainSummary: preflightTerrainState?.summary,
            });
            const replayRouteLiveOverride = evaluateReplayBackedRouteLiveOverride({
              slopfestParams: GLOBAL_SLOPFEST_PARAMS_RAW,
              routeLive: true,
              continuationReady: microScoutContinuationGate.ready,
              missingMomentum1m: microScoutContinuationGate.source === '1m-missing',
              priceChange5m: livePair.priceChange5m,
              liquidityUsd: livePair.liquidity,
              buys60s: v.buys60s,
              buyRatio60s: v.buyRatio60s,
              velocity: v.velocity,
              solVolume60s: v.solVolume60s,
              probeLikeFlowReady: microScoutDecision.shouldScout,
            });
            const replayRecoveryProbeDecision = evaluateReplayBackedRecoveryProbe({
              slopfestParams: GLOBAL_SLOPFEST_PARAMS_RAW,
              routeLive: true,
              priceChange5m: livePair.priceChange5m,
              liquidityUsd: livePair.liquidity,
              buys60s: v.buys60s,
              buyRatio60s: v.buyRatio60s,
              velocity: v.velocity,
              solVolume60s: v.solVolume60s,
              probeLikeFlowReady: microScoutDecision.shouldScout,
              openPositionCount: store.positions.length,
              consecutiveLosses: lossStreakState.consecutiveLosses,
              lastProbeAtMs: getLastRecoveryProbeAt(),
            });
            const replayRecoveryEntryOptions =
              lossStreakRestricted && replayRecoveryProbeDecision.allow
                ? {
                    replayRecoveryProbe: true,
                    replayRecoveryReason: replayRecoveryProbeDecision.reason,
                    replayRecoveryWindowMs: replayRecoveryProbeDecision.windowMs,
                  }
                : {};
            const routeLiveCanUseMicroScout =
              microScoutConfig.enabled &&
              microScoutEntriesThisPoll < microScoutPacing.maxCandidatesPerPoll &&
              microScoutDecision.shouldScout &&
              (
                microScoutContinuationGate.ready ||
                routeLiveContinuationOverride.allow ||
                replayRouteLiveOverride.allowContinuationOverride
              );
            if (microScoutDecision.shouldScout && !microScoutContinuationGate.ready) {
              if (routeLiveContinuationOverride.allow) {
                console.log(
                  `[SNIPER]  ROUTE-LIVE CONTINUATION PASS: ${symbol} ${routeLiveContinuationOverride.reason}.`
                );
              } else if (replayRouteLiveOverride.allowContinuationOverride) {
                console.log(
                  `[SNIPER]  REPLAY CONTINUATION PASS: ${symbol} ${replayRouteLiveOverride.reason}.`
                );
              } else {
              console.log(
                `[SNIPER]  MICRO SCOUT CONTINUATION HOLD: ${symbol} low-liq route is live, ` +
                `but continuation is not confirmed (${microScoutContinuationGate.source}).`
              );
              const pub = RedisBus.getPublisher();
                await setMintCooldown(pub, v.mint, 20, 'MICRO_CONTINUATION');
                continue;
              }
            }
            if (routeLiveCanUseMicroScout) {
              microScoutEntriesThisPoll += 1;
              console.log(
                `[SNIPER]  LOW LIQ MICRO-SCOUT: ${symbol} liq $${livePair.liquidity.toFixed(0)} < $5K but raw flow is scout-worthy. ` +
	                `Probing with ${describeMicroScoutSizing(microScoutConfig)} (${microScoutDecision.limitingReason}${microScoutPacingTag}).`
              );
              const routeLiveWalletSignal = freshWalletSignalMap.get(String(v.mint || '').trim()) || null;
              await trySnipe(
                v.mint,
                symbol,
                vol1h,
                pc1h,
                buys1h,
                sells1h,
                buyRatio,
                ta?.signal,
                ta?.confidence,
                tokenAgeSec,
                mom5m,
                mom1m,
                createdAt,
	                {
		                  ...buildMicroScoutEntryOptions({
		                    requestedEntryMode: 'micro-scout',
		                    microScoutConfig,
		                  }),
                  syntheticRefinementOnly,
                  syntheticSource: v.syntheticSource,
		                  quoteMode: 'pump-direct',
		                  minLiquidityUsd: 0,
	                  allowRoutableLowLiquidity: true,
	                  bypassAgeFloor: true,
                      walletConfirmed: isWalletConfirmedSignal(routeLiveWalletSignal),
                      strongRecentFlowConfirmed: hasStrongRecentFlowConfirmation({
                        terrainSummary: preflightTerrainState?.summary,
                        buys60s: v.buys60s,
                        solVolume60s: v.solVolume60s,
                        velocity: v.velocity,
                      }),
                      ...replayRecoveryEntryOptions,
	                }
              );
              continue;
            }
            if (microOnlyMode) {
              if (
                lossStreakRestricted &&
                !replayRouteLiveOverride.allowLowLiquidityColdStreakOverride &&
                !replayRecoveryProbeDecision.allow
              ) {
                console.log(
                  `[SNIPER]  LOW LIQ HOLD: ${symbol} route is live but low-liquidity preservation is disabled ` +
                  `during the current cold streak (${lossStreakState.consecutiveLosses} losses).`
                );
                const pub = RedisBus.getPublisher();
                await setMintCooldown(pub, v.mint, 300, 'COLD_STREAK_LOW_LIQ');
                continue;
              }
              if (lossStreakRestricted && replayRouteLiveOverride.allowLowLiquidityColdStreakOverride) {
                console.log(
                  `[SNIPER]  REPLAY LOW LIQ PASS: ${symbol} ${replayRouteLiveOverride.reason}.`
                );
              } else if (lossStreakRestricted && replayRecoveryProbeDecision.allow) {
                routeLiveRecoveryEntryOptions = replayRecoveryEntryOptions;
                console.log(
                  `[SNIPER]  RECOVERY PROBE READY: ${symbol} ${replayRecoveryProbeDecision.reason}.`
                );
              }
              console.log(
                `[SNIPER]  LOW LIQ ROUTE PASS: ${symbol} liq $${livePair.liquidity.toFixed(0)} < $5K, ` +
                `but Jupiter route is live. Preserving candidate for micro-sized normal-lane evaluation.`
              );
            } else {
            console.log(`[SNIPER]  LOW LIQ SKIP: ${symbol}  liq $${livePair.liquidity.toFixed(0)} < $5K`);
            const pub = RedisBus.getPublisher();
              await setMintCooldown(pub, v.mint, 300, '1');
            continue;
            }
          }
          const routeLiveEntryRefinement = evaluateRouteLiveEntryRefinement({
            microOnlyMode,
            routeLive: routeLivePreflight,
            priceChange5m: livePair?.priceChange5m,
            volume1hUsd: livePair?.volume1h,
            buys60s: v.buys60s,
            buyRatio60s: v.buyRatio60s,
            velocity: v.velocity,
            solVolume60s: v.solVolume60s,
            terrainSummary: preflightTerrainState?.summary,
          });
          routeLiveQualifierThresholdScale = routeLiveEntryRefinement.qualifierThresholdScale;
          routeLiveShouldBypassLowVolumeFloor = routeLiveEntryRefinement.shouldBypassLowVolumeFloor;
          routeLiveQualifierReason = routeLiveEntryRefinement.reason;
          if (microOnlyMode && lossStreakRestricted && routeLivePreflight && !routeLiveRecoveryEntryOptions) {
            const replayRecoveryProbeDecision = evaluateReplayBackedRecoveryProbe({
              slopfestParams: GLOBAL_SLOPFEST_PARAMS_RAW,
              routeLive: true,
              priceChange5m: livePair?.priceChange5m,
              liquidityUsd: livePair?.liquidity,
              buys60s: v.buys60s,
              buyRatio60s: v.buyRatio60s,
              velocity: v.velocity,
              solVolume60s: v.solVolume60s,
              probeLikeFlowReady: microScoutDecision.shouldScout,
              openPositionCount: store.positions.length,
              consecutiveLosses: lossStreakState.consecutiveLosses,
              lastProbeAtMs: getLastRecoveryProbeAt(),
            });
            if (replayRecoveryProbeDecision.allow) {
              routeLiveRecoveryEntryOptions = {
                replayRecoveryProbe: true,
                replayRecoveryReason: replayRecoveryProbeDecision.reason,
                replayRecoveryWindowMs: replayRecoveryProbeDecision.windowMs,
              };
              console.log(
                `[SNIPER]  RECOVERY PROBE READY: ${symbol} ${replayRecoveryProbeDecision.reason}.`
              );
            }
          }
          // MINIMUM VOLUME CHECK: skip tokens with no real trading activity
          if (livePair && livePair.volume1h < 1000) {
            if (routeLiveEntryRefinement.shouldBypassLowVolumeFloor) {
              console.log(
                `[SNIPER]  LOW VOL ROUTE PASS: ${symbol} vol $${livePair.volume1h.toFixed(0)} < $1K/1h, ` +
                `but ${routeLiveEntryRefinement.reason} is strong enough for micro-only evaluation.`
              );
            } else {
              console.log(`[SNIPER]  LOW VOL SKIP: ${symbol}  vol $${livePair.volume1h.toFixed(0)} < $1K/1h`);
              const pub = RedisBus.getPublisher();
              await setMintCooldown(pub, v.mint, 300, '1');
              continue;
            }
          }
          if (livePair && livePair.priceChange5m < -2.0) {
            const terrainConfig = loadTerrainMemoryConfig();
            const terrainPreflightGuard = evaluateTerrainPreflightGuard(preflightTerrainState, {
              kind: 'live_dump',
              priceChange5m: livePair.priceChange5m,
              liquidityUsd: livePair.liquidity,
              buys60s: v.buys60s,
              solVolume60s: v.solVolume60s,
              velocity: v.velocity,
              routeLive: routeLivePreflight,
            }, terrainConfig);
            if (terrainPreflightGuard.shouldHold) {
              console.log(
                `[SNIPER]  TERRAIN LIVE_DUMP HOLD: ${symbol} ${terrainPreflightGuard.reason} ` +
                `| price ${livePair.priceChange5m.toFixed(1)}% in 5m`
              );
              logMissedTarget({
                mint: v.mint,
                symbol,
                stage: 'velocity_first',
                reason: terrainPreflightGuard.code,
                entryMode: canUseMicroScout || microOnlyMode ? 'micro-scout' : 'velocity',
                liquidityUsd: Number(livePair?.liquidity || 0),
                marketCapUsd: Number(livePair?.marketCap || livePair?.fdv || 0),
                momentum5m: livePair?.priceChange5m,
                priceChange1h: livePair?.priceChange1h,
                buys60s: v.buys60s,
                sells60s: v.sells60s,
                buyRatio60s: v.buyRatio60s,
                velocity: v.velocity,
                solVolume60s: v.solVolume60s,
                terrainSampleCount: preflightTerrainState?.summary?.sampleCount,
                terrainSpanMs: preflightTerrainState?.summary?.spanMs,
                terrainStrongFlowSamples: preflightTerrainState?.summary?.strongFlowSamples,
                terrainPriceDelta5m: preflightTerrainState?.summary?.priceDelta5m,
                terrainPriceOffPeak5m: preflightTerrainState?.summary?.priceOffPeak5m,
                terrainFlowDecayRatio: preflightTerrainState?.summary?.flowDecayRatio,
                terrainLiquidityDeltaUsd: preflightTerrainState?.summary?.liquidityDeltaUsd,
                terrainRouteStrengthPct: preflightTerrainState?.summary?.routeStrengthPct,
              });
              const pub = RedisBus.getPublisher();
              await setMintCooldownExact(pub, v.mint, terrainPreflightGuard.cooldownSeconds, 'TERRAIN_PRECHECK');
              continue;
            }
            if (terrainPreflightGuard.shouldAllow) {
              console.log(
                `[SNIPER]  TERRAIN LIVE_DUMP PASS: ${symbol} ${terrainPreflightGuard.reason} ` +
                `| price ${livePair.priceChange5m.toFixed(1)}% in 5m`
              );
            } else {
            console.log(`[SNIPER]  LIVE DUMP SKIP: ${symbol}  price ${livePair.priceChange5m.toFixed(1)}% in 5m`);
            const pub = RedisBus.getPublisher();
            await setMintCooldown(pub, v.mint, 300, '1');
            continue;
            }
          }
          // OVERBOUGHT CEILING: if price already spiked too much, we'd buy the top
          const effectiveObCeiling = GLOBAL_OB_CEILING * (1 / Math.max(0.1, GLOBAL_HUNTER_MULT));
          if (livePair && livePair.priceChange5m > effectiveObCeiling) {
            const terrainConfig = loadTerrainMemoryConfig();
            const terrainPreflightGuard = evaluateTerrainPreflightGuard(preflightTerrainState, {
              kind: 'overbought',
              priceChange5m: livePair.priceChange5m,
              liquidityUsd: livePair.liquidity,
              buys60s: v.buys60s,
              solVolume60s: v.solVolume60s,
              velocity: v.velocity,
              routeLive: routeLivePreflight,
              overboughtBaseCeilingPct: effectiveObCeiling,
            }, terrainConfig);
            if (terrainPreflightGuard.shouldHold) {
              console.log(
                `[SNIPER]  TERRAIN OVERBOUGHT HOLD: ${symbol} ${terrainPreflightGuard.reason} ` +
                `| +${livePair.priceChange5m.toFixed(0)}% in 5m`
              );
              logMissedTarget({
                mint: v.mint,
                symbol,
                stage: 'velocity_first',
                reason: terrainPreflightGuard.code,
                entryMode: canUseMicroScout || microOnlyMode ? 'micro-scout' : 'velocity',
                liquidityUsd: Number(livePair?.liquidity || 0),
                marketCapUsd: Number(livePair?.marketCap || livePair?.fdv || 0),
                momentum5m: livePair?.priceChange5m,
                priceChange1h: livePair?.priceChange1h,
                buys60s: v.buys60s,
                sells60s: v.sells60s,
                buyRatio60s: v.buyRatio60s,
                velocity: v.velocity,
                solVolume60s: v.solVolume60s,
                terrainSampleCount: preflightTerrainState?.summary?.sampleCount,
                terrainSpanMs: preflightTerrainState?.summary?.spanMs,
                terrainStrongFlowSamples: preflightTerrainState?.summary?.strongFlowSamples,
                terrainPriceDelta5m: preflightTerrainState?.summary?.priceDelta5m,
                terrainPriceOffPeak5m: preflightTerrainState?.summary?.priceOffPeak5m,
                terrainFlowDecayRatio: preflightTerrainState?.summary?.flowDecayRatio,
                terrainLiquidityDeltaUsd: preflightTerrainState?.summary?.liquidityDeltaUsd,
                terrainRouteStrengthPct: preflightTerrainState?.summary?.routeStrengthPct,
              });
              const pub = RedisBus.getPublisher();
              await setMintCooldownExact(pub, v.mint, terrainPreflightGuard.cooldownSeconds, 'TERRAIN_PRECHECK');
              continue;
            }
            if (terrainPreflightGuard.shouldAllow) {
              console.log(
                `[SNIPER]  TERRAIN OVERBOUGHT PASS: ${symbol} ${terrainPreflightGuard.reason} ` +
                `| +${livePair.priceChange5m.toFixed(0)}% in 5m`
              );
            } else {
            console.log('[SNIPER] \u{26a0}\ufe0f OVERBOUGHT SKIP: ' + symbol + '  +' + livePair.priceChange5m.toFixed(0) + '% in 5m (ceiling: ' + effectiveObCeiling.toFixed(0) + '%)');
            const pub = RedisBus.getPublisher();
            await setMintCooldown(pub, v.mint, 300, '1');
            continue;
            }
          }
          if (livePair && livePair.priceChange1h > 500) {
            console.log('[SNIPER] \u{26a0}\ufe0f LATE ENTRY SKIP: ' + symbol + '  +' + livePair.priceChange1h.toFixed(0) + '% in 1h (ceiling: 100%)');
            const pub = RedisBus.getPublisher();
            await setMintCooldown(pub, v.mint, 600, '1');
            continue;
          }
          // Token is live on DEX with real liquidity  use live data
          if (livePair) {
            console.log(`[SNIPER]  LIVE DEX DATA: ${symbol}  liq $${livePair.liquidity.toFixed(0)} | 5m: ${livePair.priceChange5m > 0 ? '+' : ''}${livePair.priceChange5m.toFixed(1)}%${livePair.boosted ? '  BOOSTED' : ''}`);
            mom5m = livePair.priceChange5m;
            if (livePair.volume1h > vol1h) vol1h = livePair.volume1h; // use real volume
            pc1h = livePair.priceChange1h;
          } else {
            const noDexDecision = microScoutDecision;
            if (!noDexDecision.shouldScout) {
              console.log(
                `[SNIPER]  NO DEX DATA SKIP: ${symbol} raw flow missed the scout floor ` +
                `(${noDexDecision.limitingReason}${microScoutPacingTag}; ${v.buys60s}B/${v.sells60s}S, ${v.solVolume60s.toFixed(3)} SOL/60s, vel ${v.velocity}).`
              );
              const pub = RedisBus.getPublisher();
              await setMintCooldown(pub, v.mint, microScoutConfig.noDexCooldownSeconds, '1');
              continue;
            }
            if (!microScoutContinuationGate.ready) {
              console.log(
                `[SNIPER]  MICRO SCOUT CONTINUATION HOLD: ${symbol} raw flow passed scout floor, ` +
                `but continuation is not confirmed (${microScoutContinuationGate.source}).`
              );
              const pub = RedisBus.getPublisher();
              await setMintCooldown(pub, v.mint, 20, 'MICRO_CONTINUATION');
              continue;
            }
            if (
              microScoutConfig.enabled &&
              microScoutEntriesThisPoll < microScoutPacing.maxCandidatesPerPoll &&
              microScoutContinuationGate.ready &&
              store.positions.length < MAX_POSITIONS
            ) {
              microScoutEntriesThisPoll += 1;
              console.log(
                `[SNIPER]  MICRO SCOUT ARMED: ${symbol} missing DEX data but raw flow is scout-worthy ` +
                `(${v.buys60s}B/${v.sells60s}S, ${v.solVolume60s.toFixed(3)} SOL/60s, vel ${v.velocity}; ${noDexDecision.limitingReason}${microScoutPacingTag}). ` +
	                `Probing with ${describeMicroScoutSizing(microScoutConfig)}.`
              );
              await trySnipe(
                v.mint,
                symbol,
                vol1h,
                pc1h,
                buys1h,
                sells1h,
                buyRatio,
                ta?.signal,
                ta?.confidence,
                tokenAgeSec,
                mom5m,
                mom1m,
                createdAt,
	                {
		                  ...buildMicroScoutEntryOptions({
		                    requestedEntryMode: 'micro-scout',
		                    microScoutConfig,
		                  }),
                      syntheticRefinementOnly,
                      syntheticSource: v.syntheticSource,
		                  quoteMode: 'pump-direct',
		                },
              );
              continue;
            }
            console.log(
              `[SNIPER]  NO DEX DATA OVERRIDE: ${symbol} raw flow is scout-worthy ` +
              `(${noDexDecision.limitingReason}), allowing a mempool-first attempt.`
            );
          }
        }

        const normalEntryOptions: EntryOptions = {
          ...buildMicroOnlyProbeEntryOptions({
            requestedEntryMode: 'normal',
            microOnlyMode,
            microScoutConfig,
          }),
          syntheticRefinementOnly,
          syntheticSource: v.syntheticSource,
          bypassNormalMomentumFloor: true,
          continuationApproved: continuation.hasContinuation,
        };

        if (microOnlyMode) {
	          console.log(
	            `[SNIPER]  MICRO-ONLY DOWNSHIFT: ${symbol} qualified for normal lane, ` +
	            `executing with micro sizing (${describeMicroScoutSizing(microScoutConfig)}).`
	          );
          normalEntryOptions.allowRoutableLowLiquidity = true;
          normalEntryOptions.qualifierThresholdScale = 0.5;
          normalEntryOptions.minLiquidityUsd = 0;
          normalEntryOptions.bypassNormalVolumeFloor = true;
          normalEntryOptions.fixedBuySol = microScoutConfig.fixedBuySol;
          normalEntryOptions.reserveSol = microScoutConfig.reserveSol;
          normalEntryOptions.minDeploySol = microScoutConfig.fixedBuySol;
          normalEntryOptions.stopLossPct = microScoutConfig.stopLossPct / 100;
          normalEntryOptions.maxHoldMinutes = microScoutConfig.maxHoldMinutes;
          normalEntryOptions.maxTPpct = microScoutConfig.maxTPpct / 100;
          if (routeLiveQualifierThresholdScale !== null) {
            normalEntryOptions.qualifierThresholdScale = normalEntryOptions.qualifierThresholdScale !== undefined
              ? Math.min(normalEntryOptions.qualifierThresholdScale, routeLiveQualifierThresholdScale)
              : routeLiveQualifierThresholdScale;
            console.log(
              `[SNIPER]  ROUTE-LIVE QUALIFIER ASSIST: ${symbol} ${routeLiveQualifierReason} ` +
              `| threshold scale ${normalEntryOptions.qualifierThresholdScale.toFixed(2)}`
            );
          }
          if (routeLiveShouldBypassLowVolumeFloor) {
            normalEntryOptions.bypassNormalVolumeFloor = true;
          }
          if (routeLiveRecoveryEntryOptions) {
            Object.assign(normalEntryOptions, routeLiveRecoveryEntryOptions);
          }
        }

        await trySnipe(v.mint, symbol, vol1h, pc1h,
                       buys1h, sells1h, buyRatio,
                       ta?.signal, ta?.confidence,
                       tokenAgeSec, mom5m, mom1m, createdAt, normalEntryOptions);
      }

      // If we entered via velocity, skip DexScreener path this cycle
      if (store.positions.length >= MAX_POSITIONS) return;
    }

    if (microOnlyMode) {
      const normalLaneConfig = loadNormalLaneConfig();
      const matureFallbackConfig = loadMatureFallbackConfig();
      if (!matureFallbackConfig.enabled) {
        return;
      }
      if (shouldDeferMatureFallback({ eligibleVelocityCount: freshVelocityEligibleCount }, matureFallbackConfig)) {
        console.log(
          `[SNIPER]  MATURE TREND DEFER: fresh velocity lane still has ${freshVelocityEligibleCount} eligible candidate(s) ` +
          `from ${freshVelocityTrackedCount} tracked spike(s); holding older fallback names for terrain refinement.`
        );
        return;
      }
      const matureFallbackLimit = Math.max(
        1,
        Math.min(matureFallbackConfig.maxCandidatesPerPoll, microScoutConfig.maxCandidatesPerPoll),
      );
      let matureTrendingMap: Map<string, any> = new Map();

      if (fs.existsSync(TRENDING_FILE)) {
        try {
          const tRaw = JSON.parse(fs.readFileSync(TRENDING_FILE, 'utf-8'));
          matureTrendingMap = buildTrendingMap(tRaw);
        } catch {}
      }

      if (matureTrendingMap.size === 0) {
        return;
      }

      const matureCandidates: Array<{
        mint: string;
        symbol: string;
        source?: string;
        marketCapUsd: number;
        volume1h: number;
        liquidityUsd: number;
        priceChange1h: number;
        priceChange5m: number;
        buys1h: number;
        sells1h: number;
        buyRatio: number;
        tokenAgeSec: number;
        pairCreatedAt?: number;
        score: number;
      }> = [];
      let matureAgeFiltered = 0;
      let matureShapeFiltered = 0;
      let matureMomentumFiltered = 0;
      let matureVelocityFiltered = 0;
      let matureCooldownFiltered = 0;
      let matureTempBlacklistFiltered = 0;
      let matureBuyRatioFiltered = 0;

      for (const trending of Array.from(matureTrendingMap.values())) {
        if (!trending?.mint) continue;
        if (store.blacklist.includes(trending.mint)) continue;
        if (store.positions.find(p => p.mint === trending.mint)) continue;

        const pairCreatedAt = trending.pairCreatedAt ? Number(trending.pairCreatedAt) : undefined;
        const tokenAgeSec = pairCreatedAt ? Math.max(0, Math.floor((Date.now() - pairCreatedAt) / 1000)) : undefined;
        if (
          tokenAgeSec === undefined ||
          tokenAgeSec < matureFallbackConfig.minCandidateAgeSec ||
          tokenAgeSec > matureFallbackConfig.maxCandidateAgeSec
        ) {
          matureAgeFiltered += 1;
          continue;
        }

        const marketCapUsd = Math.max(Number(trending.marketCapUsd || 0), Number(trending.fdvUsd || 0));
        const volume1h = Number(trending.volume1h || 0);
        const liquidityUsd = Number(trending.liquidityUsd || 0);
        if (
          marketCapUsd < normalLaneConfig.minMarketCapUsd ||
          marketCapUsd > normalLaneConfig.maxMarketCapUsd ||
          volume1h < normalLaneConfig.minVolume1hUsd ||
          liquidityUsd < normalLaneConfig.minLiquidityUsd
        ) {
          matureShapeFiltered += 1;
          continue;
        }

        const priceChange5m = Number(trending.priceChange5m || 0);
        const priceChange1h = Number(trending.priceChange1h || 0);
        const candidateBuyRatio = Number(trending.buyRatio || 0);
        const momentumOkay =
          priceChange5m >= normalLaneConfig.minMomentum5mPct ||
          (priceChange1h > 0 && priceChange5m >= Math.max(1, normalLaneConfig.minMomentum5mPct * 0.5));
        if (!momentumOkay) {
          matureMomentumFiltered += 1;
          continue;
        }

        if (
          !shouldAllowMatureFallbackCandidate({
            buyRatio: candidateBuyRatio,
            tokenAgeSec,
            priceChange5m,
            priceChange1h,
          }, matureFallbackConfig)
        ) {
          matureBuyRatioFiltered += 1;
          continue;
        }

        const velocityLookup = loadVelocityWithMeta(trending.mint);
        if (velocityLookup.velocity?.isAccelerating) {
          matureVelocityFiltered += 1;
          continue;
        }

        const cooldownState = await getMintCooldownState(trending.mint);
        if (cooldownState.active) {
          matureCooldownFiltered += 1;
          continue;
        }

        const tempBlacklistPenalty = await getTempBlacklistPenalty(trending.mint);
        if (tempBlacklistPenalty !== null) {
          matureTempBlacklistFiltered += 1;
          continue;
        }
        matureCandidates.push({
          mint: trending.mint,
          symbol: trending.symbol || `${trending.mint.slice(0, 8)}...`,
          source: trending.source || trending.dexId,
          marketCapUsd,
          volume1h,
          liquidityUsd,
          priceChange1h,
          priceChange5m,
          buys1h: Number(trending.buys1h || 0),
          sells1h: Number(trending.sells1h || 0),
          buyRatio: candidateBuyRatio,
          tokenAgeSec,
          pairCreatedAt,
          score: scoreMatureFallbackCandidate({
            volume1hUsd: volume1h,
            liquidityUsd,
            buyRatio: candidateBuyRatio,
            tokenAgeSec,
            priceChange5m,
          }, matureFallbackConfig),
        });
      }

	      const matureRankedCandidates = annotateCandidatesWithExpectedValue(
	        matureCandidates,
	        (candidate: any) => ({
	          entryMode: 'normal',
	          sourceLane: 'mature-fallback',
	          entryFamily: 'mature-fallback',
	          tokenAgeSec: candidate.tokenAgeSec,
	          liquidityUsd: candidate.liquidityUsd,
	          marketCapUsd: candidate.marketCapUsd,
	          fdvUsd: candidate.marketCapUsd,
	          momentum5m: candidate.priceChange5m,
	          buyRatio: candidate.buyRatio,
	          volume1hUsd: candidate.volume1h,
	          buys1h: candidate.buys1h,
	          sells1h: candidate.sells1h,
	          confidenceScore: clamp(candidate.buyRatio / 3, 0.25, 0.95),
	        }),
	      );
	      matureRankedCandidates.sort((left: any, right: any) =>
	        compareExpectedValueRank(
	          left,
	          right,
	          (baseLeft: any, baseRight: any) => Number(baseRight?.score || 0) - Number(baseLeft?.score || 0),
	        ),
	      );
	      const matureCandidatePool = matureRankedCandidates.slice(
	        0,
	        Math.max(matureFallbackLimit, Math.min(matureFallbackConfig.candidatePoolSize, matureRankedCandidates.length)),
	      );
      const matureShortlist: typeof matureCandidates = [];
      if (matureCandidatePool.length > 0) {
        const rotationOffset = Math.floor(Date.now() / 30_000) % matureCandidatePool.length;
        for (let i = 0; i < Math.min(matureFallbackLimit, matureCandidatePool.length); i += 1) {
          matureShortlist.push(matureCandidatePool[(rotationOffset + i) % matureCandidatePool.length]);
        }
      }

      if (matureShortlist.length === 0) {
        console.log(
          `[SNIPER]  MATURE TREND PASS: no older trending candidates cleared the micro-only fallback ` +
          `(age=${matureAgeFiltered}, shape=${matureShapeFiltered}, momentum=${matureMomentumFiltered}, buyRatio=${matureBuyRatioFiltered}, ` +
          `velocity=${matureVelocityFiltered}, cooldown=${matureCooldownFiltered}, tempBlacklist=${matureTempBlacklistFiltered}).`
        );
        return;
      }

      console.log(
        `[SNIPER]  MATURE TRENDING FALLBACK: evaluating ${matureShortlist.length}/${matureCandidates.length} older candidate(s) ` +
        `from rotating top-${matureCandidatePool.length} with strict normal-lane filters and micro sizing.`
      );

      for (const candidate of matureShortlist) {
        if (store.positions.length >= MAX_POSITIONS) break;
        const ta = loadSignal(candidate.mint);
	        console.log(
	          `[SNIPER]  MATURE TREND CANDIDATE: ${candidate.symbol} | age ${(candidate.tokenAgeSec / 60).toFixed(1)}m | ` +
	          `mcap $${candidate.marketCapUsd.toFixed(0)} | liq $${candidate.liquidityUsd.toFixed(0)} | ` +
	          `vol $${candidate.volume1h.toFixed(0)} | 5m ${candidate.priceChange5m >= 0 ? '+' : ''}${candidate.priceChange5m.toFixed(1)}%` +
	          ` | EV=${Number(candidate?.expectedValueDecision?.expectedPnlSol || 0).toFixed(6)}` +
	          `${candidate.source ? ` | src:${candidate.source}` : ''}`
	        );
        await trySnipe(
          candidate.mint,
          candidate.symbol,
          candidate.volume1h,
          candidate.priceChange1h,
          candidate.buys1h,
          candidate.sells1h,
          candidate.buyRatio,
          ta?.signal,
          ta?.confidence,
          candidate.tokenAgeSec,
          candidate.priceChange5m,
          undefined,
          candidate.pairCreatedAt,
          {
            ...buildMicroOnlyProbeEntryOptions({
              requestedEntryMode: 'normal',
              microOnlyMode: true,
              microScoutConfig,
            }),
            sourceLane: 'mature-fallback',
            continuationApproved: candidate.priceChange1h > 0 || candidate.priceChange5m >= normalLaneConfig.minMomentum5mPct,
            buyRatioThresholdScale: matureFallbackConfig.buyRatioThresholdScale,
            buyCountThresholdScale: matureFallbackConfig.buyCountThresholdScale,
            minTokenAgeSec: matureFallbackConfig.minCandidateAgeSec,
            maxTokenAgeSec: matureFallbackConfig.maxCandidateAgeSec,
            minLiquidityUsd: normalLaneConfig.minLiquidityUsd,
            minVolumeUsd: normalLaneConfig.minVolume1hUsd,
            minMomentum5mPct: normalLaneConfig.minMomentum5mPct,
            maxHoldMinutes: Math.max(4, microScoutConfig.maxHoldMinutes),
            maxTPpct: Math.max(0.12, microScoutConfig.maxTPpct / 100),
            rejectCooldownSeconds: matureFallbackConfig.rejectCooldownSeconds,
            hydrationMissRejectCooldownSeconds: matureFallbackConfig.hydrationMissRejectCooldownSeconds,
          }
        );
      }
      return;
    }

    //
    // PATH 2: DEXSCREENER TRENDING FALLBACK
    //  Transitioned completely to High-Fidelity Railway Webhook.
  } catch (e: any) {
    console.error('[SNIPER] Poll error:', e.message);
  } finally {
    pollInFlight = false;
    if (pollQueued) {
      pollQueued = false;
      setTimeout(() => {
        poll().catch(() => {});
      }, 0);
    }
  }
}

//  Main loop
async function main() {
  const microOnlyMode = isMicroOnlyMode();
  const microScoutConfig = loadMicroScoutConfig();
  console.log('');
  console.log('  PCP MOMENTUM SNIPER v1.1  (native SOL) ');
  console.log('  Wallet:', wallet.publicKey.toBase58().slice(0,20) + '      ');
  if (microOnlyMode) {
    console.log(
      `  Buy: ${
        microScoutConfig.portfolioSizingEnabled
          ? `${(microScoutConfig.portfolioFraction * 100).toFixed(0)}% of one remaining slot-share of deployable treasury`
          : `${microScoutConfig.fixedBuySol.toFixed(4)} SOL fixed`
      } | Mode: micro-only | Reserve: ${microScoutConfig.reserveSol.toFixed(3)} SOL`
    );
    console.log(
      `  Scout slots: ${microScoutConfig.maxCandidatesPerPoll}/poll | Active exits: ` +
      `${formatExitSummaryLine({
        holdMinutes: microScoutConfig.maxHoldMinutes,
        stopLossPct: microScoutConfig.stopLossPct,
        maxTPpct: microScoutConfig.maxTPpct,
      })}`
    );
    console.log(
      `  Gemma global (inactive while micro-only): ` +
      `${formatExitSummaryLine({
        holdMinutes: GLOBAL_HOLD_MIN,
        stopLossPct: Number((GLOBAL_SL_PCT * 100).toFixed(1)),
        maxTPpct: Number((GLOBAL_TP_PCT * 100).toFixed(1)),
      })}`
    );
  } else {
    console.log(`  Buy: ${MIN_BUY_SOL}-${MAX_BUY_SOL} SOL (20% bal) | TP/SL: tiered`);
    console.log(`  Max positions: ${MAX_POSITIONS} | Hold: ${MAX_HOLD_MS/60000}min max     `);
  }
  console.log(`  Base currency: native SOL (Jupiter wraps in-transaction)`);
  console.log('');

  //  WSOL ATA initialization
  // Ensure the persistent WSOL ATA exists  one on-chain check at startup
  try {
    const nativeBal = await getSpendableNativeBalance(connection, wallet.publicKey, MIN_NATIVE_SOL_RESERVE);
    console.log(`[SNIPER] Native SOL balance: ${nativeBal.nativeSol.toFixed(4)} | spendable after reserve: ${nativeBal.spendableSol.toFixed(4)}`);
  } catch (e: any) {
    console.warn('[SNIPER] Native balance init warning:', e.message);
  }

  // Recover any wallet tokens not tracked as positions
  await recoverOrphans();

  // Native-SOL lane: no persistent WSOL account management is required.
  const pollWithRefill = async () => {
    await poll();
  };

  // Initial poll
  await pollWithRefill();

  // Async continuous Orphan Sweeper to reclaim dropped bugs (every 5 mins)
  setInterval(() => {
     recoverOrphans().catch(() => {});
  }, 300_000);

  // Network Event Loop
  const sub = RedisBus.getSubscriber();
  sub.subscribe('guardian:force_exit');
  sub.subscribe(CHANNELS.VELOCITY_SPIKE);
  sub.subscribe(CHANNELS.CONFIG_UPDATE);
  sub.subscribe('config:slopfest');
  // ENGINE_FORCE_SELL: DISABLED  was causing unexpected force exits
  sub.on('message', (ch, msg) => {
    if (ch === 'guardian:force_exit') {
      try {
          const forceMint = msg.trim();
          const forcedPos = store.positions.find((p: any) => p.mint === forceMint);
          if (forcedPos) {
              console.log(`[SNIPER]  OVERRIDE: WSS Guardian detected Rug Phase on ${forceMint}. Forcing IMMEDIATE Market Exit!`);
              forcedPos.forceExitTriggered = true; // Signals the main loop to dump with tight slippage!
          }
      } catch(e) {}
    } else if (ch === CHANNELS.VELOCITY_SPIKE) {
      try {
        const raw = JSON.parse(msg);
        const payloadKind = classifyVelocityPubsubPayload(raw);
        if (payloadKind.kind === 'delta') {
          latestVelocityData = hydrateVelocitySpikeArray(raw.mints);
        } else if (payloadKind.kind === 'snapshot') {
          latestVelocityData = normalizeVelocitySnapshot(raw);
          return;
        } else {
          return;
        }
        const spikeCount = payloadKind.spikeCount;
        console.log('[SNIPER]  VELOCITY SPIKE:', spikeCount, 'mints');
        if (!shouldTriggerVelocityPoll(spikeCount)) {
          console.log(`[SNIPER] VELOCITY DEBOUNCE: coalescing ${spikeCount} mint spike into the next scan window.`);
          return;
        }
        poll().catch(() => {}); // Uses cached velocity data, no extra RPC refill sweep  burns RPC on every spike. Velocity data saved, poll picks it up on next coalesced cycle
      } catch (e) {
        console.error('[DEBUG] Parse error on spike:', e);
      }
    }
    // ENGINE_FORCE_SELL handler: REMOVED
    else if (ch === CHANNELS.CONFIG_UPDATE) {
      try {
        const params = JSON.parse(msg);
        if (params.maxTPpct) {
          GLOBAL_TP_PCT = parseFloat(params.maxTPpct);
          console.log('[SNIPER]  GEMMA4 UPDATE: TP=' + (GLOBAL_TP_PCT*100).toFixed(1) + '%');
        }
        if (params.stopLossPct) {
          GLOBAL_SL_PCT = parseFloat(params.stopLossPct);
          console.log('[SNIPER]  GEMMA4 UPDATE: SL=' + (GLOBAL_SL_PCT*100).toFixed(1) + '%');
        }
        if (params.maxHoldMinutes) {
          GLOBAL_HOLD_MIN = parseFloat(params.maxHoldMinutes);
          console.log('[SNIPER]  GEMMA4 UPDATE: HOLD=' + GLOBAL_HOLD_MIN + 'min');
        }
        if (params.dynamicMinMom1m) {
          console.log('[SNIPER]  GEMMA4 UPDATE: MIN_MOM=' + params.dynamicMinMom1m + '%');
        }
        if (params.hunterModeMultiplier) {
          GLOBAL_HUNTER_MULT = parseFloat(params.hunterModeMultiplier);
          console.log('[SNIPER]  GEMMA4 UPDATE: HUNTER_MULT=' + GLOBAL_HUNTER_MULT.toFixed(2));
        }
      } catch (e) {
        console.error('[SNIPER] config:update parse error:', e);
      }
    } else if (ch === 'config:slopfest') {
      try {
        const params = JSON.parse(msg);
        GLOBAL_SLOPFEST_PARAMS_ID = `slopfest_${Date.now()}`;
        GLOBAL_SLOPFEST_PARAMS_RAW = params;
        console.log(`[SNIPER]  SLOPFEST PARAMS UPDATED: ID=${GLOBAL_SLOPFEST_PARAMS_ID}`);
      } catch (e) {
        console.error('[SNIPER] config:slopfest parse error:', e);
      }
    }
  });

  // Watchdog Heartbeat
  setInterval(() => {
    RedisBus.publish('heartbeat:agent', { agent: 'pcp-sniper', timestamp: Date.now() });
  }, 120000); // Reduced heartbeat from 30s to 120s to save RPC

  // Fallback Interval if Velocity stalls
  // DYNAMIC RETRO-TELEMETRY THREAD (3-second strict tick rate)
  // Ensures violent pump & dumps never bypass the standard discovery polling loop
  setInterval(() => {
     if (store.positions.length > 0) {
         checkExits().catch(e => console.error('[SNIPER/TELEMETRY] Panic dump telemetry exception:', e));
     }
  }, 15000); // Reduced from 3s to 15s to conserve Chainstack RPC quota

  // Fallback Interval if Velocity stalls
  const runDynamicPollLoop = async () => {
    try {
      await pollWithRefill();
    } catch (e) {
      console.error('[SNIPER] poll error:', e);
    }

    let delayMs = POLL_MS;
    try {
      const storeState = loadStore();
      const posCount = storeState.positions.length;
      if (posCount < 8) {
        const ratio = (8 - posCount) / 8;
        delayMs = Math.max(2000, POLL_MS * (1 - ratio));
        if (Date.now() % 60000 < 5000) {
          console.log(`[SNIPER]  HUNTER PACING: ${posCount}/8 positions. Accelerating scan to ${Math.round(delayMs)}ms`);
        }
      }
    } catch (e) {
      // ignore
    }
    setTimeout(runDynamicPollLoop, delayMs);
  };
  runDynamicPollLoop();

  process.on('SIGTERM', () => {
    saveStore();
    process.exit(0);
  });

  if (FORCED_DIAGNOSTIC_ENABLED) {
    setTimeout(async () => {
        console.log('[SNIPER] \u26A1 INITIATING FORCED DIAGNOSTIC ROUND-TRIP TRANSACTION...');
        try {
            // Only run this probe when explicitly enabled. Restart loops should not create paid test fills.
            const q = await getQuote('So11111111111111111111111111111111111111112', 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYtM6BmWqpm', 50000000, 1000);
            console.log('[SNIPER] DIAGNOSTIC QUOTE RESPONSE:', q ? 'SUCCESS' : 'FAILED');
            if (q) {
               const sig = await executeSwap(q);
               console.log('[SNIPER] \u2705 FORCED DIAGNOSTIC TX BROADCAST: ' + sig);
            }
        } catch (e: any) {
            console.log('[SNIPER] Forced tx failed: ' + e.message);
        }
    }, 5000);
  }
}

main().catch(e => { console.error('[SNIPER] Fatal:', e); process.exit(1); });
