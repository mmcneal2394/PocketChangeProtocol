// @ts-nocheck
import fs from 'fs';
import path from 'path';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { Connection, Keypair } from '@solana/web3.js';
import { getSpendableNativeBalance, MIN_NATIVE_SOL_RESERVE } from '../../src/utils/native_sol_balance';

const {
  resolveQuotaAssistLevel,
  sortWalletQuotaSignals,
  isWalletSignalFresh,
  computeWalletQuotaSignalScore,
} = require('./quota_assist_logic.ts');

dotenv.config({ path: path.join(process.cwd(), '.env') });
dotenv.config({ path: path.join(process.cwd(), '..', '.env') });

const SIGNALS_DIR = path.join(process.cwd(), 'signals');
const ROOT_DIR = process.cwd();
const ALLOCATION_FILE = path.join(SIGNALS_DIR, 'allocation.json');
const ARB_HINTS_FILE = path.join(ROOT_DIR, '.swarm', 'arb-engine', 'arb-hints.json');
const REALIZED_PROFIT_FILE = path.join(SIGNALS_DIR, process.env.PAPER_MODE === 'true' ? 'realized_profit_paper.json' : 'realized_profit.json');
const STRATEGY_PROFILE_PATH = path.resolve(
  process.cwd(),
  process.env.STRATEGY_PROFILE_PATH || 'config/strategy-profiles/active.strategy.json',
);
const POLL_MS = Math.max(15_000, Number(process.env.CAPITAL_ALLOCATOR_POLL_MS || 60_000));
const DEFAULT_ARB_TARGET_LIMIT = Math.max(4, Number(process.env.ARB_TARGET_LIMIT || 8));
const ARMED_SHARE = Math.max(0.1, Math.min(0.9, Number(process.env.ARMED_SHARED_CAPITAL_FRACTION || 0.5)));
const ARB_LIVE_MIN_PROFIT_SOL = Math.max(0, Number(process.env.ARB_LIVE_MIN_PROFIT_SOL || 0.5));
const ARB_LIVE_MIN_BUDGET_SOL = Math.max(0.01, Number(process.env.ARB_LIVE_MIN_BUDGET_SOL || 0.5));
const REINVESTMENT_RATIO = Math.max(0, Math.min(1, Number(process.env.ARB_PROFIT_REINVESTMENT_RATIO || 0.8)));
const RUN_ONCE = process.argv.includes('--once');
const NON_ALLOCATOR_TARGET_MINTS = new Set<string>([
  'So11111111111111111111111111111111111111112',
]);

type JsonRecord = Record<string, any>;

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function roundSol(value: number) {
  return Number((Number.isFinite(value) ? value : 0).toFixed(6));
}

function readJsonIfExists(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, payload: any) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function isAllocatorEligibleMint(mint: string | null | undefined): boolean {
  const normalizedMint = String(mint || '').trim();
  return normalizedMint.length > 0 && !NON_ALLOCATOR_TARGET_MINTS.has(normalizedMint);
}

function loadWallet(): Keypair | null {
  const secretLike = String(
    process.env.PRIVATE_KEY ||
    process.env.WALLET_PRIVATE_KEY ||
    process.env.WALLET_SECRET_KEY ||
    '',
  ).trim();

  if (secretLike) {
    try {
      return Keypair.fromSecretKey(bs58.decode(secretLike));
    } catch (error: any) {
      console.warn(`[ALLOCATOR] Failed to decode base58 wallet secret from env: ${error?.message || error}`);
    }
  }

  const candidates = [
    process.env.WALLET_KEYPAIR_PATH,
    process.env.KEYPAIR_PATH,
    './wallet.json',
    '../wallet.json',
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = path.resolve(process.cwd(), candidate);
    if (!fs.existsSync(resolved)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
      if (Array.isArray(raw) && raw.length >= 64) {
        return Keypair.fromSecretKey(Uint8Array.from(raw));
      }
    } catch (error: any) {
      console.warn(`[ALLOCATOR] Failed to load wallet from ${resolved}: ${error?.message || error}`);
    }
  }

  return null;
}

function loadStrategyProfile(): JsonRecord {
  const fallback = {
    id: 'pcprotocol-target',
    microScout: {
      reserveSol: MIN_NATIVE_SOL_RESERVE,
    },
  };
  return readJsonIfExists(STRATEGY_PROFILE_PATH, fallback) || fallback;
}

function loadWalletSignals() {
  const payload = readJsonIfExists(path.join(SIGNALS_DIR, 'wallet_signals.json'), { buy_signals: [] }) || { buy_signals: [] };
  return Array.isArray(payload.buy_signals) ? payload.buy_signals : [];
}

function loadTrendingSignals() {
  const payload = readJsonIfExists(path.join(SIGNALS_DIR, 'trending.json'), { mints: [] }) || { mints: [] };
  return Array.isArray(payload.mints) ? payload.mints : [];
}

function loadOpenPositionsCount() {
  const positionsPayload = readJsonIfExists(path.join(SIGNALS_DIR, 'sniper_positions.json'), { positions: [] }) || { positions: [] };
  return Array.isArray(positionsPayload.positions) ? positionsPayload.positions.length : 0;
}

function loadRealizedProfit() {
  const payload = readJsonIfExists(REALIZED_PROFIT_FILE, {});
  return {
    totalRealizedPnlSol: roundSol(Number(payload?.totalRealizedPnlSol || 0)),
    eligibleProfitSol: roundSol(Number(payload?.eligibleProfitSol || 0)),
    reinvestmentRatio: Math.max(0, Math.min(1, Number(payload?.reinvestmentRatio || REINVESTMENT_RATIO))),
    updatedAt: payload?.generatedAt || null,
  };
}

export function resolveSharedCapitalPlan(input: {
  deployableSol: number;
  totalRealizedPnlSol?: number;
  eligibleProfitSol?: number;
  minArbLiveProfitSol?: number;
  minArbLiveBudgetSol?: number;
  armedShare?: number;
}) {
  const deployableSol = Math.max(0, Number(input?.deployableSol || 0));
  const totalRealizedPnlSol = Number(input?.totalRealizedPnlSol || 0);
  const eligibleProfitSol = Math.max(0, Number(input?.eligibleProfitSol || 0));
  const minArbLiveProfitSol = Math.max(0, Number(input?.minArbLiveProfitSol || ARB_LIVE_MIN_PROFIT_SOL));
  const minArbLiveBudgetSol = Math.max(0.01, Number(input?.minArbLiveBudgetSol || ARB_LIVE_MIN_BUDGET_SOL));
  const armedShare = Math.max(0.1, Math.min(0.9, Number(input?.armedShare || ARMED_SHARE)));
  const liveBudgetCapacitySol = roundSol(Math.min(deployableSol, eligibleProfitSol));
  const arbLiveEligible =
    totalRealizedPnlSol >= minArbLiveProfitSol &&
    liveBudgetCapacitySol >= minArbLiveBudgetSol;
  const arbWeight = arbLiveEligible ? armedShare : 0;
  const sniperWeight = roundSol(Math.max(0, 1 - arbWeight));

  return {
    arbLiveEligible,
    liveBudgetCapacitySol,
    sniperWeight,
    arbWeight,
    sniperBudgetSol: roundSol(deployableSol * sniperWeight),
    arbBudgetSol: roundSol(deployableSol * arbWeight),
    executionModeRecommendation: arbLiveEligible ? 'live-eligible' : 'scout-only',
  };
}

function buildArbTargets(walletSignals: any[], trendingSignals: any[]) {
  const targets: any[] = [];
  const seen = new Set<string>();

  const pushTarget = (mint: string, target: any) => {
    const normalizedMint = String(mint || '').trim();
    if (!isAllocatorEligibleMint(normalizedMint) || seen.has(normalizedMint)) return;
    seen.add(normalizedMint);
    targets.push(target);
  };

  for (const signal of walletSignals.slice(0, DEFAULT_ARB_TARGET_LIMIT)) {
    pushTarget(signal.mint, {
      mint: signal.mint,
      symbol: signal.symbol || signal.ticker || signal.mint?.slice(0, 6) || 'UNKNOWN',
      source: signal.sourceLane || 'wallet',
      priority: signal.priority || null,
      score: roundSol(computeWalletQuotaSignalScore(signal)),
      quotaAssistLevel: Number(signal.quotaAssistLevel || 0),
      walletCount: Array.isArray(signal.wallets) ? signal.wallets.length : Number(signal.walletCount || 0),
      kolConfirmed: Boolean(signal.kolConfirmed),
    });
  }

  for (const trend of trendingSignals.slice(0, 4)) {
    pushTarget(trend.mint, {
      mint: trend.mint,
      symbol: trend.symbol || trend.mint?.slice(0, 6) || 'UNKNOWN',
      source: trend.source || 'trending',
      priority: null,
      score: roundSol(Number(trend.buyRatio || 0) * 0.1 + Number(trend.velocity || 0) * 0.05),
      quotaAssistLevel: 0,
      walletCount: 0,
      kolConfirmed: false,
    });
  }

  return targets.slice(0, DEFAULT_ARB_TARGET_LIMIT);
}

function buildReason(summary: {
  deployableSol: number;
  reserveSol: number;
  quotaAssistLevel: number;
  executableWalletSignals: number;
  arbTargets: any[];
  totalRealizedPnlSol: number;
  eligibleProfitSol: number;
  arbLiveEligible: boolean;
  liveBudgetCapacitySol: number;
}) {
  return [
    `Wallet remains the capital source of truth with ${summary.reserveSol.toFixed(4)} SOL protected reserve.`,
    `Deployable treasury is ${summary.deployableSol.toFixed(4)} SOL.`,
    `Closed-trade realized PnL is ${summary.totalRealizedPnlSol >= 0 ? '+' : ''}${summary.totalRealizedPnlSol.toFixed(4)} SOL, with ${summary.eligibleProfitSol.toFixed(4)} SOL eligible for reinvestment.`,
    summary.arbLiveEligible
      ? `Arb lane is live-eligible with ${summary.liveBudgetCapacitySol.toFixed(4)} SOL of profit-backed capacity, so treasury is split evenly between sniper and arb.`
      : `Arb lane remains scout-only until profit-backed capacity reaches ${ARB_LIVE_MIN_BUDGET_SOL.toFixed(4)} SOL; sniper keeps full deployable capital.`,
    `Quota assist level ${summary.quotaAssistLevel} with ${summary.executableWalletSignals} executable wallet signals feeding ${summary.arbTargets.length} arb targets.`,
  ].join(' ');
}

async function runCycle() {
  const profile = loadStrategyProfile();
  const wallet = loadWallet();
  const walletSignals = loadWalletSignals();
  const trendingSignals = loadTrendingSignals();
  const openPositions = loadOpenPositionsCount();
  const realizedProfit = loadRealizedProfit();
  const freshWalletSignals = sortWalletQuotaSignals(
    walletSignals.filter((signal: any) =>
      isAllocatorEligibleMint(signal?.mint) &&
      signal.expired !== true &&
      isWalletSignalFresh(signal),
    ),
  );
  const executableWalletSignals = freshWalletSignals.filter((signal: any) => signal.executable === true);
  const quotaAssistLevel = Number(resolveQuotaAssistLevel(openPositions));
  const arbTargets = buildArbTargets(executableWalletSignals, trendingSignals);

  let walletPublicKey = null;
  let nativeSol = 0;
  let reserveSol = Math.max(
    MIN_NATIVE_SOL_RESERVE,
    Number(profile?.microScout?.reserveSol || profile?.lastStand?.reserveSol || MIN_NATIVE_SOL_RESERVE),
  );
  let deployableSol = 0;
  let status = 'idle';
  let warning = null;

  if (!wallet) {
    status = 'degraded';
    warning = 'Missing wallet keypair in environment or wallet.json; allocator wrote zero budgets.';
  } else {
    try {
      walletPublicKey = wallet.publicKey.toBase58();
      const connection = new Connection(
        process.env.SOLANA_RPC_URL || process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
        { commitment: 'confirmed' },
      );
      const balance = await getSpendableNativeBalance(connection, wallet.publicKey, reserveSol);
      nativeSol = Number(balance.nativeSol || 0);
      deployableSol = Math.max(0, Number(balance.spendableSol || 0));
      status = deployableSol > 0 ? 'armed' : 'idle';
    } catch (error: any) {
      status = 'degraded';
      warning = `Balance read failed; allocator wrote zero budgets (${error?.message || error}).`;
      console.warn(`[ALLOCATOR] ${warning}`);
    }
  }

  const capitalPlan = resolveSharedCapitalPlan({
    deployableSol,
    totalRealizedPnlSol: realizedProfit.totalRealizedPnlSol,
    eligibleProfitSol: realizedProfit.eligibleProfitSol,
    minArbLiveProfitSol: ARB_LIVE_MIN_PROFIT_SOL,
    minArbLiveBudgetSol: ARB_LIVE_MIN_BUDGET_SOL,
    armedShare: ARMED_SHARE,
  });

  const payload = {
    generatedAt: new Date().toISOString(),
    status,
    warning,
    mode: 'profit-gated-shared-wallet',
    strategyId: String(profile?.id || 'pcprotocol-target'),
    walletPublicKey,
    wallet_balance_sol: roundSol(nativeSol),
    reserve_sol: roundSol(reserveSol),
    deployable_sol: roundSol(deployableSol),
    total_realized_pnl_sol: realizedProfit.totalRealizedPnlSol,
    eligible_profit_sol: realizedProfit.eligibleProfitSol,
    profit_updated_at: realizedProfit.updatedAt,
    reinvestment_ratio: realizedProfit.reinvestmentRatio,
    arb_live_min_profit_sol: roundSol(ARB_LIVE_MIN_PROFIT_SOL),
    arb_live_min_budget_sol: roundSol(ARB_LIVE_MIN_BUDGET_SOL),
    arb_live_eligible: capitalPlan.arbLiveEligible,
    live_budget_capacity_sol: capitalPlan.liveBudgetCapacitySol,
    executionModeRecommendation: capitalPlan.executionModeRecommendation,
    sniper_weight: capitalPlan.sniperWeight,
    pf_weight: 0,
    arb_weight: capitalPlan.arbWeight,
    sniper_budget_sol: capitalPlan.sniperBudgetSol,
    arb_budget_sol: capitalPlan.arbBudgetSol,
    open_positions: openPositions,
    quotaAssistLevel,
    executable_wallet_signals: executableWalletSignals.length,
    fresh_wallet_signals: freshWalletSignals.length,
    arb_targets: arbTargets,
    reason: buildReason({
      deployableSol,
      reserveSol,
      quotaAssistLevel,
      executableWalletSignals: executableWalletSignals.length,
      arbTargets,
      totalRealizedPnlSol: realizedProfit.totalRealizedPnlSol,
      eligibleProfitSol: realizedProfit.eligibleProfitSol,
      arbLiveEligible: capitalPlan.arbLiveEligible,
      liveBudgetCapacitySol: capitalPlan.liveBudgetCapacitySol,
    }),
  };

  writeJson(ALLOCATION_FILE, payload);
  writeJson(ARB_HINTS_FILE, {
    generatedAt: payload.generatedAt,
    status: payload.status,
    walletPublicKey,
    arb_budget_sol: payload.arb_budget_sol,
    arb_live_eligible: payload.arb_live_eligible,
    executionModeRecommendation: payload.executionModeRecommendation,
    quotaAssistLevel: payload.quotaAssistLevel,
    targets: payload.arb_targets,
  });

  console.log(
    `[ALLOCATOR] ${payload.status.toUpperCase()} | wallet ${payload.wallet_balance_sol.toFixed(4)} SOL | ` +
    `deploy ${payload.deployable_sol.toFixed(4)} | pnl ${payload.total_realized_pnl_sol >= 0 ? '+' : ''}${payload.total_realized_pnl_sol.toFixed(4)} | ` +
    `mode ${payload.executionModeRecommendation} | split sniper ${payload.sniper_budget_sol.toFixed(4)} / arb ${payload.arb_budget_sol.toFixed(4)}`,
  );
}

async function main() {
  ensureDir(SIGNALS_DIR);
  ensureDir(path.dirname(ARB_HINTS_FILE));
  await runCycle();
  if (RUN_ONCE) return;
  setInterval(() => {
    runCycle().catch((error: any) => {
      console.error(`[ALLOCATOR] Cycle failed: ${error?.message || error}`);
    });
  }, POLL_MS);
}

if (require.main === module) {
  main().catch((error: any) => {
    console.error(`[ALLOCATOR] Fatal: ${error?.message || error}`);
    process.exit(1);
  });
}

module.exports = {
  resolveSharedCapitalPlan,
};
