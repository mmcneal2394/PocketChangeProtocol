const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(process.cwd(), '.env') });

const WSOL = 'So11111111111111111111111111111111111111112';
const DEFAULT_QUOTE_URL = process.env.JUPITER_QUOTE_URL || 'https://public.jupiterapi.com/quote';
const DEFAULT_MIN_EDGE_BPS = Math.max(0, Number(process.env.ARB_MIN_EDGE_BPS || 12));
const DEFAULT_MIN_TRADE_LAMPORTS = Math.max(1_000_000, Number(process.env.ARB_MIN_TRADE_LAMPORTS || 1_000_000));
const DEFAULT_TARGET_LIMIT = Math.max(4, Number(process.env.ARB_TARGET_LIMIT || 8));

const ROOT_SIGNALS_DIR = path.join(process.cwd(), 'signals');
const ALLOCATION_FILE = process.env.PCP_ALLOCATION_FILE || path.join(ROOT_SIGNALS_DIR, 'allocation.json');
const STATUS_DIR = path.join(process.cwd(), '.swarm', 'arb-scout');
const STATUS_FILE = path.join(STATUS_DIR, 'latest-scout.json');
const ENGINE_STATUS_FILE = path.join(ROOT_SIGNALS_DIR, 'arb_engine_status.json');

const BASE_TARGETS = [
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', source: 'base' },
  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', symbol: 'RAY', source: 'base' },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', source: 'base' },
  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', symbol: 'WIF', source: 'base' },
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonIfExists(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueTargets(allocation) {
  const seen = new Set();
  const targets = [];
  const hintedTargets = Array.isArray(allocation?.arb_targets) ? allocation.arb_targets : [];
  for (const target of [...hintedTargets, ...BASE_TARGETS]) {
    const mint = String(target?.mint || '').trim();
    if (!mint || seen.has(mint)) continue;
    seen.add(mint);
    targets.push({
      mint,
      symbol: target?.symbol || mint.slice(0, 6),
      source: target?.source || 'wallet-fed',
      score: Number(target?.score || 0),
      priority: target?.priority || null,
    });
    if (targets.length >= DEFAULT_TARGET_LIMIT) break;
  }
  return targets;
}

async function fetchQuote(inputMint, outputMint, amountLamports) {
  const url = new URL(DEFAULT_QUOTE_URL);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', String(amountLamports));
  url.searchParams.set('slippageBps', String(Math.max(5, Number(process.env.ARB_SLIPPAGE_BPS || 25))));
  url.searchParams.set('restrictIntermediateTokens', 'true');

  const response = await fetch(url.toString(), {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    throw new Error(`quote:${response.status}`);
  }

  const payload = await response.json();
  if (!payload?.outAmount) {
    throw new Error('quote:no-out-amount');
  }

  return payload;
}

async function evaluateTarget(target, inputLamports) {
  const firstLeg = await fetchQuote(WSOL, target.mint, inputLamports);
  const tokenOut = Number(firstLeg.outAmount || 0);
  if (!Number.isFinite(tokenOut) || tokenOut <= 0) {
    throw new Error('quote:no-first-leg');
  }

  const secondLeg = await fetchQuote(target.mint, WSOL, tokenOut);
  const solOut = Number(secondLeg.outAmount || 0);
  if (!Number.isFinite(solOut) || solOut <= 0) {
    throw new Error('quote:no-second-leg');
  }

  const netLamports = solOut - inputLamports;
  const netEdgeBps = (netLamports / inputLamports) * 10_000;
  return {
    ...target,
    inputLamports,
    firstLegOutLamports: tokenOut,
    secondLegOutLamports: solOut,
    estimatedProfitLamports: Math.floor(netLamports),
    estimatedProfitSol: Number((netLamports / 1_000_000_000).toFixed(6)),
    netEdgeBps: Number(netEdgeBps.toFixed(2)),
  };
}

async function runCycle() {
  const allocation = readJsonIfExists(ALLOCATION_FILE, {});
  const arbBudgetSol = Number(allocation?.arb_budget_sol || 0);
  const deployableSol = Number(allocation?.deployable_sol || 0);
  const targetUniverse = uniqueTargets(allocation);
  const generatedAt = new Date().toISOString();
  const liveEligible = allocation?.executionModeRecommendation === 'live-eligible' && allocation?.arb_live_eligible === true;

  if (!Number.isFinite(arbBudgetSol) || arbBudgetSol <= 0) {
    const idlePayload = {
      generatedAt,
      state: 'idle',
      reason: allocation?.reason || 'arb-budget-unavailable',
      executionMode: 'scout-only',
      liveEligible: false,
      walletBudgetSol: 0,
      deployableSol: Number.isFinite(deployableSol) ? Number(deployableSol.toFixed(6)) : 0,
      targets: targetUniverse,
      best: null,
      opportunities: [],
    };
    writeJson(STATUS_FILE, idlePayload);
    writeJson(ENGINE_STATUS_FILE, idlePayload);
    console.log('[ARB] IDLE | no arb budget available from shared allocator');
    return;
  }

  const maxBudgetLamports = Math.max(DEFAULT_MIN_TRADE_LAMPORTS, Math.floor(arbBudgetSol * 1_000_000_000));
  const tradeLamports = Math.max(
    DEFAULT_MIN_TRADE_LAMPORTS,
    Math.min(maxBudgetLamports, Math.floor(maxBudgetLamports * 0.5)),
  );

  const opportunities = [];
  for (const target of targetUniverse) {
    try {
      const candidate = await evaluateTarget(target, tradeLamports);
      opportunities.push(candidate);
    } catch (error) {
      opportunities.push({
        ...target,
        inputLamports: tradeLamports,
        estimatedProfitLamports: 0,
        estimatedProfitSol: 0,
        netEdgeBps: -Infinity,
        error: String(error?.message || error),
      });
    }
    await sleep(125);
  }

  const ranked = opportunities
    .filter((candidate) => Number.isFinite(candidate.netEdgeBps))
    .sort((left, right) => right.netEdgeBps - left.netEdgeBps);

  const best = ranked[0] || null;
  const state = best && best.netEdgeBps >= DEFAULT_MIN_EDGE_BPS ? 'armed' : 'idle';
  const reason = best
    ? (state === 'armed'
      ? `wallet-fed arb target ${best.symbol} cleared ${DEFAULT_MIN_EDGE_BPS} bps threshold`
      : `best target ${best.symbol} only reached ${best.netEdgeBps.toFixed(2)} bps`)
    : 'no-quotable-arb-targets';

  const payload = {
    generatedAt,
    state,
    reason,
    executionMode: 'scout-only',
    liveEligible,
    liveEligibilityReason: allocation?.reason || null,
    walletBudgetSol: Number(arbBudgetSol.toFixed(6)),
    deployableSol: Number(deployableSol.toFixed(6)),
    quotaAssistLevel: Number(allocation?.quotaAssistLevel || 0),
    sharedReason: allocation?.reason || null,
    best,
    opportunities: ranked.slice(0, 6),
    targets: targetUniverse,
  };

  writeJson(STATUS_FILE, payload);
  writeJson(ENGINE_STATUS_FILE, payload);

  if (best) {
    console.log(
      `[ARB] ${state.toUpperCase()} | best ${best.symbol} | edge ${best.netEdgeBps.toFixed(2)} bps | ` +
      `profit ${best.estimatedProfitSol >= 0 ? '+' : ''}${best.estimatedProfitSol.toFixed(6)} SOL | ` +
      `budget ${payload.walletBudgetSol.toFixed(4)} SOL | liveEligible=${liveEligible}`,
    );
  } else {
    console.log('[ARB] IDLE | no quotable targets');
  }
}

async function main() {
  ensureDir(STATUS_DIR);
  ensureDir(ROOT_SIGNALS_DIR);
  await runCycle();
}

main().catch((error) => {
  console.error(`[ARB] FATAL | ${error?.message || error}`);
  process.exit(1);
});
