#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } = require('@solana/web3.js');
require('dotenv').config({ path: path.join(process.cwd(), '.env') });
const {
  getLatestOpportunity,
  getCapitalSummary,
  setCapitalReservation,
  summarizeCoordinator,
  upsertEngineState,
} = require('./engine_state_store');
const { deriveYieldEconomicResult } = require('./maintain/wiggum_economic_logic');

const METEORA_POOLS_URL = 'https://dlmm.datapi.meteora.ag/pools';
const METEORA_POOL_DETAIL = 'https://dlmm.datapi.meteora.ag/pools';
const METEORA_WALLET_EARNING = 'https://dlmm-api.meteora.ag/wallet';
const METEORA_DLMM_PROGRAM_ID = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const POSITION_ACCOUNT_LB_PAIR_OFFSET = 8;
const POSITION_ACCOUNT_OWNER_OFFSET = 8 + 32;
const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 Codex/1.0',
  Accept: 'application/json',
};
const MICRO_STATE_DIR = path.join(process.cwd(), '.swarm', 'yield-cycle');
const MICRO_EXECUTION_LOG = path.join(MICRO_STATE_DIR, 'micro-execution-log.json');
const ALPHA_READINESS_HISTORY_LOG = path.join(MICRO_STATE_DIR, 'alpha-readiness-history.json');
const ALPHA_EXECUTION_STATE_LOG = path.join(MICRO_STATE_DIR, 'alpha-execution-log.json');

function fail(message) {
  console.error(`[YIELD] ${message}`);
  process.exit(1);
}

function loadProfile() {
  const profilePath = path.resolve(process.cwd(), process.env.STRATEGY_PROFILE_PATH || 'config/strategy-profiles/active.strategy.json');
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  return { profile, profilePath };
}

function readJsonIfExists(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function addSecondsToIso(isoString, seconds) {
  return new Date(new Date(isoString).getTime() + (Math.max(0, Number(seconds || 0)) * 1000)).toISOString();
}

function deriveYieldCoordinationState({ timestamp, actionable, profile, inspection, walletRebalance, microTransaction, alphaExecution, alphaSafety }) {
  const microLamports = Math.max(0, Math.floor(Number(profile?.yieldCycle?.microTransaction?.amountLamports || 0)));
  const inventoryCooldownSeconds = Math.max(60, Number(profile?.yieldCycle?.microTransaction?.inventoryMaintenance?.cooldownSeconds || 300));
  const alphaLamports = Math.max(0, Math.floor(Number(alphaExecution?.suggestedLamports || 0)));

  let state = 'idle';
  let reason = walletRebalance?.action || 'monitor';
  let reservationLamports = 0;
  let cooldownUntil = null;

  if (alphaSafety?.status === 'tripped') {
    state = 'kill_switch';
    reason = (alphaSafety.gateReasons || []).join(',') || 'alpha-safety-tripped';
  } else if (inspection?.status === 'fetch-failed') {
    state = 'degraded';
    reason = inspection.error || 'inspection-fetch-failed';
  } else if (!actionable) {
    state = 'blocked';
    reason = 'below-min-cycle-wallet-sol';
  } else if (walletRebalance?.action === 'rebalance-quote-inventory') {
    reservationLamports = microLamports;
    if (microTransaction?.status === 'ready-to-send' || microTransaction?.status === 'simulated-only' || microTransaction?.status === 'sent') {
      state = 'armed';
      reason = 'quote-rebalance-ready';
    } else if (microTransaction?.status === 'blocked') {
      state = 'cooldown';
      reason = microTransaction.blockReason || 'micro-transaction-blocked';
      cooldownUntil = addSecondsToIso(timestamp, inventoryCooldownSeconds);
    } else if (microTransaction?.status === 'probe-error' || microTransaction?.status === 'send-failed') {
      state = 'degraded';
      reason = microTransaction.error || microTransaction.status;
    } else {
      state = 'idle';
      reason = microTransaction?.status || 'rebalance-monitor';
    }
  } else if (alphaExecution?.status === 'armed' && alphaExecution?.ready === true) {
    state = 'armed';
    reason = alphaExecution.suggestedDirection || 'alpha-opportunity-ready';
    reservationLamports = alphaLamports;
  } else if (microTransaction?.status === 'blocked') {
    state = 'cooldown';
    reason = microTransaction.blockReason || 'micro-transaction-blocked';
    cooldownUntil = addSecondsToIso(timestamp, inventoryCooldownSeconds);
  }

  return {
    state,
    reason,
    reservationLamports,
    cooldownUntil,
    metadata: {
      inspectionStatus: inspection?.status || null,
      walletRebalanceAction: walletRebalance?.action || null,
      microStatus: microTransaction?.status || null,
      alphaExecutionStatus: alphaExecution?.status || null,
      alphaExecutionMode: alphaExecution?.effectiveMode || alphaExecution?.mode || null,
      alphaSafetyStatus: alphaSafety?.status || null,
    },
  };
}

async function fetchJson(url, init) {
  const response = await fetch(url, { headers: REQUEST_HEADERS, ...init });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  return { ok: response.ok, status: response.status, data };
}

async function fetchMeteoraPools() {
  const response = await fetchJson(METEORA_POOLS_URL);
  if (!response.ok) throw new Error(`Meteora pools request failed with HTTP ${response.status}`);
  return Array.isArray(response.data?.data) ? response.data.data : [];
}

async function fetchPoolDetail(poolAddress) {
  const response = await fetchJson(`${METEORA_POOL_DETAIL}/${poolAddress}`);
  if (!response.ok) throw new Error(`Meteora pool detail failed with HTTP ${response.status}`);
  return response.data;
}

async function fetchPoolOhlcv(poolAddress, timeframe) {
  const response = await fetchJson(`${METEORA_POOL_DETAIL}/${poolAddress}/ohlcv?timeframe=${encodeURIComponent(timeframe)}`);
  if (!response.ok) throw new Error(`Meteora OHLCV failed with HTTP ${response.status} (${timeframe})`);
  return Array.isArray(response.data?.data) ? response.data.data : [];
}

async function fetchWalletEarning(wallet, poolAddress) {
  const response = await fetchJson(`${METEORA_WALLET_EARNING}/${wallet}/${poolAddress}/earning`);
  if (response.status === 404) {
    return {
      status: 'not-found',
      source: `${METEORA_WALLET_EARNING}/${wallet}/${poolAddress}/earning`,
      positionDetected: false,
      earningDetected: false,
    };
  }
  if (!response.ok) {
    return {
      status: 'fetch-failed',
      source: `${METEORA_WALLET_EARNING}/${wallet}/${poolAddress}/earning`,
      positionDetected: false,
      earningDetected: false,
      error: `HTTP ${response.status}`,
    };
  }
  return {
    status: 'ok',
    source: `${METEORA_WALLET_EARNING}/${wallet}/${poolAddress}/earning`,
    positionDetected: true,
    earningDetected: true,
    data: response.data,
  };
}

async function fetchOnChainPositionSignal(connection, walletPublicKey, poolAddress) {
  const programId = new PublicKey(METEORA_DLMM_PROGRAM_ID);
  const ownerFilter = {
    memcmp: {
      offset: POSITION_ACCOUNT_OWNER_OFFSET,
      bytes: walletPublicKey.toBase58(),
    },
  };
  const poolFilter = poolAddress ? { memcmp: { offset: POSITION_ACCOUNT_LB_PAIR_OFFSET, bytes: poolAddress } } : null;

  try {
    const [allPositions, matchingPoolPositions] = await Promise.all([
      connection.getProgramAccounts(programId, { filters: [ownerFilter], dataSlice: { offset: 0, length: 0 } }),
      poolFilter ? connection.getProgramAccounts(programId, { filters: [ownerFilter, poolFilter], dataSlice: { offset: 0, length: 0 } }) : Promise.resolve([]),
    ]);

    return {
      status: 'ok',
      source: 'solana-rpc:getProgramAccounts',
      programId: programId.toBase58(),
      owner: walletPublicKey.toBase58(),
      poolAddress: poolAddress || null,
      positionCount: allPositions.length,
      matchingPoolPositionCount: matchingPoolPositions.length,
      positionPublicKeys: allPositions.map((account) => account.pubkey.toBase58()),
      matchingPoolPositionPublicKeys: matchingPoolPositions.map((account) => account.pubkey.toBase58()),
      positionDetected: allPositions.length > 0,
      matchingPoolPositionDetected: matchingPoolPositions.length > 0,
    };
  } catch (error) {
    return {
      status: 'fetch-failed',
      source: 'solana-rpc:getProgramAccounts',
      programId: programId.toBase58(),
      owner: walletPublicKey.toBase58(),
      poolAddress: poolAddress || null,
      positionDetected: false,
      matchingPoolPositionDetected: false,
      error: error.message,
    };
  }
}

async function fetchMintBalance(connection, owner, mintAddress, decimalsHint) {
  const mint = new PublicKey(mintAddress);
  const tokenProgramId = new PublicKey(TOKEN_PROGRAM_ID);
  const response = await connection.getParsedTokenAccountsByOwner(owner, { mint, programId: tokenProgramId }, 'confirmed');
  const accounts = response.value || [];
  if (accounts.length === 0) {
    return {
      mint: mintAddress,
      accountCount: 0,
      amountRaw: '0',
      uiAmount: 0,
      decimals: decimalsHint,
      ataExists: false,
    };
  }

  const aggregate = accounts.reduce(
    (acc, entry) => {
      const parsed = entry.account.data?.parsed?.info?.tokenAmount || {};
      acc.amountRaw += BigInt(parsed.amount || '0');
      acc.uiAmount += Number(parsed.uiAmount || 0);
      acc.decimals = Number.isFinite(parsed.decimals) ? parsed.decimals : acc.decimals;
      acc.accountPubkeys.push(entry.pubkey.toBase58());
      return acc;
    },
    { mint: mintAddress, accountCount: accounts.length, amountRaw: 0n, uiAmount: 0, decimals: decimalsHint, ataExists: true, accountPubkeys: [] }
  );

  return {
    mint: aggregate.mint,
    accountCount: aggregate.accountCount,
    amountRaw: aggregate.amountRaw.toString(),
    uiAmount: aggregate.uiAmount,
    decimals: aggregate.decimals,
    ataExists: aggregate.ataExists,
    accountPubkeys: aggregate.accountPubkeys,
  };
}

async function fetchWalletInventory(connection, walletPublicKey, nativeLamports, cycle) {
  const quoteMint = cycle.quoteToken === 'USDC' ? USDC_MINT : (cycle.quoteMint || USDC_MINT);
  const baseMint = cycle.baseToken === 'SOL' ? WSOL_MINT : (cycle.baseMint || WSOL_MINT);
  const [quoteBalance, baseWrappedBalance] = await Promise.all([
    fetchMintBalance(connection, walletPublicKey, quoteMint, 6),
    fetchMintBalance(connection, walletPublicKey, baseMint, 9),
  ]);

  return {
    nativeSol: {
      mint: WSOL_MINT,
      lamports: nativeLamports,
      sol: nativeLamports / LAMPORTS_PER_SOL,
    },
    wrappedBase: baseWrappedBalance,
    quote: quoteBalance,
  };
}

function computeWalletRebalance(profile, cycle, inventory, inspection) {
  const micro = cycle.microTransaction || {};
  const desiredQuoteUi = Number(micro.targetQuoteUiAmount || 1);
  const currentQuoteUi = Number(inventory?.quote?.uiAmount || 0);
  const needQuoteTopUp = currentQuoteUi < desiredQuoteUi;
  const noPoolPosition = inspection?.positionSummary?.selectedPoolPositionDetected !== true;
  const hasBaseForTopUp = Number(inventory?.nativeSol?.sol || 0) > Number(cycle.minNativeSolReserve || 0) + ((Number(micro.amountLamports || 0) / LAMPORTS_PER_SOL) || 0);

  let action = 'monitor';
  if (noPoolPosition && needQuoteTopUp && hasBaseForTopUp) {
    action = 'rebalance-quote-inventory';
  } else if (noPoolPosition && !hasBaseForTopUp) {
    action = 'preserve-native-reserve';
  } else if (noPoolPosition && !needQuoteTopUp) {
    action = 'quote-inventory-ready';
  } else if (!noPoolPosition) {
    action = 'position-exists-monitor';
  }

  return {
    status: 'ok',
    desiredQuoteUi,
    currentQuoteUi,
    deficitQuoteUi: Math.max(0, desiredQuoteUi - currentQuoteUi),
    noPoolPosition,
    needQuoteTopUp,
    hasBaseForTopUp,
    action,
  };
}

function selectPool(pools, desiredPool) {
  const normalized = String(desiredPool || '').trim().toUpperCase();
  const matches = pools.filter((pool) => String(pool?.name || '').toUpperCase() === normalized);
  const ranked = (matches.length > 0 ? matches : pools).slice().sort((a, b) => Number(b?.tvl || 0) - Number(a?.tvl || 0));
  return ranked[0] || null;
}

function buildInspection(pool, cycle, actionable, poolDetail, walletPosition, onChainPosition) {
  if (!pool) {
    return {
      status: 'pool-not-found',
      recommendedAction: 'update-profile-pool-name',
      walletPosition,
      onChainPosition,
    };
  }

  const apr = Number(poolDetail?.apr ?? pool.apr ?? 0);
  const apy = Number(poolDetail?.apy ?? pool.apy ?? 0);
  const tvl = Number(poolDetail?.tvl ?? pool.tvl ?? 0);
  const currentPrice = Number(poolDetail?.current_price ?? pool.current_price ?? 0);
  const threshold = Number(cycle.rebalanceThreshold || 0);
  const positionWidthBps = Number(cycle.positionWidthBps || 0);
  const matchingPoolPositionDetected = onChainPosition?.matchingPoolPositionDetected === true;

  let recommendedAction = 'monitor';
  if (!actionable) {
    recommendedAction = 'await-more-capital-or-reduce-thresholds';
  } else if (!matchingPoolPositionDetected) {
    recommendedAction = 'no-live-position-detected-paper-prepare-only';
  } else if (apr < 0.01 && apy < 0.01) {
    recommendedAction = 'review-pool-yield-before-positioning';
  } else if (tvl < 100000) {
    recommendedAction = 'review-liquidity-depth';
  } else if (threshold <= 0 || positionWidthBps <= 0) {
    recommendedAction = 'fix-strategy-parameters';
  } else {
    recommendedAction = 'inspect-and-plan-rebalance';
  }

  return {
    status: 'ok',
    source: METEORA_POOLS_URL,
    poolAddress: pool.address,
    poolName: pool.name,
    tvl,
    apr,
    apy,
    currentPrice,
    binStep: poolDetail?.pool_config?.bin_step ?? pool.pool_config?.bin_step,
    baseFeePct: poolDetail?.pool_config?.base_fee_pct ?? pool.pool_config?.base_fee_pct,
    dynamicFeePct: poolDetail?.dynamic_fee_pct ?? pool.dynamic_fee_pct,
    volume24h: Number(poolDetail?.volume?.day ?? poolDetail?.trade_volume_24h ?? pool.volume?.day ?? pool.trade_volume_24h ?? 0),
    fees24h: Number(poolDetail?.fees?.day ?? poolDetail?.fees_24h ?? pool.fees?.day ?? pool.fees_24h ?? 0),
    hasFarm: Boolean(poolDetail?.has_farm ?? pool.has_farm),
    walletPosition,
    onChainPosition,
    positionSummary: {
      anyDlmmPositionDetected: onChainPosition?.positionDetected === true,
      selectedPoolPositionDetected: matchingPoolPositionDetected,
      apiEarningDetected: walletPosition?.earningDetected === true,
    },
    recommendedAction,
  };
}

function loadMicroExecutionState() {
  return readJsonIfExists(MICRO_EXECUTION_LOG, { byDate: {} });
}

function loadAlphaReadinessHistory() {
  return readJsonIfExists(ALPHA_READINESS_HISTORY_LOG, { entries: [] });
}

function loadAlphaExecutionState() {
  return readJsonIfExists(ALPHA_EXECUTION_STATE_LOG, { byDate: {} });
}

async function sendTelegramAlert(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  if (!token || !chatId || !message) return { sent: false, reason: 'telegram-not-configured' };
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
      }),
    });
    return { sent: response.ok, status: response.status };
  } catch (error) {
    return { sent: false, reason: error.message };
  }
}

function getMicroProfitabilityConfig(profile) {
  const micro = profile?.yieldCycle?.microTransaction || {};
  const profitability = micro.profitability || {};
  return {
    enabled: profitability.enabled !== false,
    minimumEdgeLamports: Number(profitability.minimumEdgeLamports || 10000),
    estimatedPriorityFeeLamports: Number(profitability.estimatedPriorityFeeLamports || 10000),
    stableQuoteMints: Array.isArray(profitability.stableQuoteMints) && profitability.stableQuoteMints.length > 0
      ? profitability.stableQuoteMints
      : [USDC_MINT],
  };
}

function getMicroMaintenanceConfig(profile) {
  const micro = profile?.yieldCycle?.microTransaction || {};
  const maintenance = micro.inventoryMaintenance || {};
  const dynamic = maintenance.dynamic || {};
  return {
    enabled: maintenance.enabled === true,
    mode: maintenance.mode || 'static',
    staticTarget: Number(maintenance.staticTarget || maintenance.minQuoteTarget || 0),
    maxAcceptableLossLamports: Number(maintenance.maxAcceptableLossLamports || 0),
    checkBalanceBeforeAttempt: maintenance.checkBalanceBeforeAttempt !== false,
    cooldownSeconds: Number(maintenance.cooldownSeconds || 3600),
    dynamic: {
      baseTradeSizeSol: Number(dynamic.baseTradeSizeSol || 0),
      safetyFactor: Number(dynamic.safetyFactor || 1),
      minFloorUsdc: Number(dynamic.minFloorUsdc || 0),
      maxCeilingUsdc: Number(dynamic.maxCeilingUsdc || 0),
    },
  };
}

function computeMaintenanceTargetUsdc(maintenance, impliedSolPriceUsd, amountLamports, quoteUi, quotePriceImpactPct, tradeSizeSol) {
  const mode = maintenance.mode || 'static';
  if (mode !== 'dynamic') {
    return {
      mode: 'static',
      targetUsdc: maintenance.staticTarget,
      tradeSizeSol: null,
      safetyFactor: null,
      liquidityAdjustment: 1,
      impliedSolPriceUsd,
    };
  }

  const baseTradeSizeSol = Number(tradeSizeSol || 0) > 0
    ? Number(tradeSizeSol)
    : (maintenance.dynamic.baseTradeSizeSol > 0
      ? maintenance.dynamic.baseTradeSizeSol
      : (amountLamports / LAMPORTS_PER_SOL));
  const baseSafetyFactor = maintenance.dynamic.safetyFactor > 0 ? maintenance.dynamic.safetyFactor : 1;
  const priceImpactPct = Number(quotePriceImpactPct || 0);
  const liquidityAdjustment = priceImpactPct > 0 ? (1 + (priceImpactPct * 10)) : 1;
  const tradeUsdcValue = baseTradeSizeSol * Math.max(0, Number(impliedSolPriceUsd || 0));
  let targetUsdc = tradeUsdcValue * baseSafetyFactor * liquidityAdjustment;
  const floor = maintenance.dynamic.minFloorUsdc;
  const ceiling = maintenance.dynamic.maxCeilingUsdc;
  if (Number.isFinite(floor) && floor > 0) targetUsdc = Math.max(floor, targetUsdc);
  if (Number.isFinite(ceiling) && ceiling > 0) targetUsdc = Math.min(ceiling, targetUsdc);
  return {
    mode: 'dynamic',
    targetUsdc,
    tradeSizeSol: baseTradeSizeSol,
    safetyFactor: baseSafetyFactor,
    liquidityAdjustment,
    impliedSolPriceUsd,
    quotePriceImpactPct: priceImpactPct,
  };
}

function hasRecentMaintenanceExecution(microState, cooldownSeconds) {
  if (!microState || !microState.byDate) return false;
  const cooldownMs = Math.max(0, Number(cooldownSeconds || 0)) * 1000;
  if (cooldownMs <= 0) return false;
  const now = Date.now();
  for (const day of Object.values(microState.byDate || {})) {
    const records = Array.isArray(day?.maintenanceExecutions) ? day.maintenanceExecutions : [];
    for (const record of records) {
      const ts = new Date(record?.timestamp || 0).getTime();
      if (Number.isFinite(ts) && now - ts >= 0 && now - ts <= cooldownMs) return true;
    }
  }
  return false;
}

function evaluateMicroProfitability({ profile, inputMint, outputMint, amountLamports, quote, swapResponse, slippageBps, rebalanceState, microState }) {
  const config = getMicroProfitabilityConfig(profile);
  const result = {
    enabled: config.enabled,
    quoteMint: outputMint || null,
    minimumEdgeLamports: config.minimumEdgeLamports,
    estimatedPriorityFeeLamports: config.estimatedPriorityFeeLamports,
    slippageBps,
    passes: true,
    reason: 'profitability-check-disabled',
  };

  if (!config.enabled) return result;

  const stableQuoteMints = new Set(config.stableQuoteMints);
  if (!stableQuoteMints.has(outputMint)) {
    result.passes = false;
    result.reason = 'quote-asset-not-stable';
    return result;
  }

  const quoteOutAtomic = Number(quote?.outAmount || 0);
  const quoteDecimals = outputMint === USDC_MINT ? 6 : 6;
  const quoteUi = quoteOutAtomic / (10 ** quoteDecimals);
  const inputSol = amountLamports / LAMPORTS_PER_SOL;
  const impliedSolPriceUsd = inputSol > 0 ? quoteUi / inputSol : 0;
  const quoteValueLamports = impliedSolPriceUsd > 0 ? Math.round((quoteUi / impliedSolPriceUsd) * LAMPORTS_PER_SOL) : 0;
  const txBaseCostLamports = 5000 + config.estimatedPriorityFeeLamports;
  const slippageCostLamports = Math.floor(amountLamports * (Number(slippageBps || 0) / 10000));
  const totalCostLamports = txBaseCostLamports + slippageCostLamports;
  const netGainLamports = quoteValueLamports - totalCostLamports - amountLamports;

  result.quoteOutAtomic = quoteOutAtomic;
  result.quoteUi = quoteUi;
  result.impliedSolPriceUsd = impliedSolPriceUsd;
  result.quoteValueLamports = quoteValueLamports;
  result.txBaseCostLamports = txBaseCostLamports;
  result.slippageCostLamports = slippageCostLamports;
  result.totalCostLamports = totalCostLamports;
  result.netGainLamports = netGainLamports;
  result.prioritizationFeeLamports = Number(swapResponse?.prioritizationFeeLamports || config.estimatedPriorityFeeLamports);

  if (netGainLamports >= config.minimumEdgeLamports) {
    result.mode = 'alpha';
    result.passes = true;
    result.reason = `profitable-net-${netGainLamports}`;
    return result;
  }

  const maintenance = getMicroMaintenanceConfig(profile);
  result.maintenance = {
    enabled: maintenance.enabled,
    currentQuoteUi: Number(rebalanceState?.currentQuoteUi || 0),
    minQuoteTarget: maintenance.minQuoteTarget,
    maxAcceptableLossLamports: maintenance.maxAcceptableLossLamports,
    recentExecutionBlocked: hasRecentMaintenanceExecution(microState, maintenance.cooldownSeconds),
  };

  const maintenanceTarget = computeMaintenanceTargetUsdc(maintenance, impliedSolPriceUsd, amountLamports, quoteUi, quote?.priceImpactPct);
  result.maintenance.target = maintenanceTarget;
  result.maintenance.minQuoteTarget = maintenanceTarget.targetUsdc;

  const quoteBelowTarget = result.maintenance.currentQuoteUi < maintenanceTarget.targetUsdc;
  const acceptableLoss = Math.abs(netGainLamports) <= maintenance.maxAcceptableLossLamports;

  if (maintenance.enabled && quoteBelowTarget && acceptableLoss && !result.maintenance.recentExecutionBlocked) {
    result.mode = 'maintenance';
    result.passes = true;
    result.reason = `maintenance-override-net-${netGainLamports}`;
    result.maintenance.overrideUsed = true;
    return result;
  }

  result.mode = 'blocked';
  result.passes = false;
  if (maintenance.enabled && quoteBelowTarget && result.maintenance.recentExecutionBlocked) {
    result.reason = 'maintenance-cooldown-active';
  } else if (maintenance.enabled && quoteBelowTarget && !acceptableLoss) {
    result.reason = `maintenance-loss-${Math.abs(netGainLamports)}-exceeds-${maintenance.maxAcceptableLossLamports}`;
  } else {
    result.reason = `net-${netGainLamports}-below-edge-${config.minimumEdgeLamports}`;
  }
  return result;
}

function summarizeDailyBudget(state, todayKey) {
  const day = state.byDate?.[todayKey] || { executions: 0, lamports: 0, signatures: [] };
  return {
    executions: Number(day.executions || 0),
    lamports: Number(day.lamports || 0),
    signatures: Array.isArray(day.signatures) ? day.signatures : [],
    maintenanceExecutions: Array.isArray(day.maintenanceExecutions) ? day.maintenanceExecutions : [],
  };
}

function hasFreshPreflight() {
  const statePath = path.join(process.cwd(), '.swarm', 'wiggum', 'strategy-gate', 'state.json');
  if (!fs.existsSync(statePath)) return { ok: false, reason: 'strategy-gate-state-missing' };
  const state = readJsonIfExists(statePath, {});
  if (state.result !== 'success') return { ok: false, reason: 'strategy-gate-not-successful' };
  const iterations = Array.isArray(state.iterations) ? state.iterations : [];
  const successful = iterations.filter((item) => item?.validator?.judge?.passed === true);
  const last = successful[successful.length - 1];
  if (!last?.finishedAt) return { ok: false, reason: 'strategy-gate-finishedAt-missing' };
  const ageMs = Date.now() - new Date(last.finishedAt).getTime();
  const maxAgeMs = 24 * 60 * 60 * 1000;
  return {
    ok: Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeMs,
    reason: Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= maxAgeMs ? 'fresh' : 'strategy-gate-stale',
    ageMs,
  };
}

async function fetchBagsQuote(inputMint, outputMint, amountLamports, slippageBps) {
  const apiBase = 'https://public-api-v2.bags.fm/api/v1';
  const apiKey = process.env.BAGS_API_KEY || '';
  const headers = {};
  if (apiKey) headers['x-api-key'] = apiKey;
  const quoteUrl = `${apiBase}/trade/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageMode=auto&slippageBps=${slippageBps}`;
  const response = await fetch(quoteUrl, { headers });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok || !data.success || !data.response?.outAmount) throw new Error(`Bags quote failed: ${(data && (data.error || data.message || data.raw)) || `HTTP ${response.status}`}`);
  return { quoteUrl, quote: data.response, raw: data };
}

async function fetchJupiterQuote(inputMint, outputMint, amountLamports, slippageBps) {
  const apiBase = process.env.JUPITER_ENDPOINT || 'https://api.jup.ag/swap/v1';
  const apiKey = process.env.JUPITER_API_KEY || '';
  const headers = { Accept: 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  const quoteUrl = `${apiBase}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`;
  const response = await fetch(quoteUrl, { headers });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`Jupiter quote failed: ${(data && (data.error || data.message || data.raw)) || `HTTP ${response.status}`}`);
  return { quoteUrl, quote: data };
}

async function buildJupiterSwapTransaction(wallet, quoteResponse, memo) {
  const apiBase = process.env.JUPITER_ENDPOINT || 'https://api.jup.ag/swap/v1';
  const apiKey = process.env.JUPITER_API_KEY || '';
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['x-api-key'] = apiKey;
  const response = await fetch(`${apiBase}/swap`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 10000,
      dynamicSlippage: false,
      memo: memo || undefined,
    }),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok || !data.swapTransaction) throw new Error(`Jupiter swap build failed: ${(data && (data.error || data.message || data.raw)) || `HTTP ${response.status}`}`);
  const transaction = VersionedTransaction.deserialize(Buffer.from(data.swapTransaction, 'base64'));
  transaction.sign([wallet]);
  return { transaction, swapResponse: data };
}

function getMicroSizingConfig(profile, micro) {
  const sizing = micro?.sizing || profile?.yieldCycle?.microTransaction?.sizing || {};
  const kelly = sizing.kelly || {};
  return {
    mode: sizing.mode || 'fixed',
    fixedSizeSol: Number(sizing.fixedSizeSol || (Number(micro?.amountLamports || 0) / LAMPORTS_PER_SOL) || 0.001),
    kelly: {
      maxRiskPerTrade: Number(kelly.maxRiskPerTrade || 0.02),
      kellyFraction: Number(kelly.kellyFraction || 0.5),
      minTradeSizeSol: Number(kelly.minTradeSizeSol || 0.0005),
      maxTradeSizeSol: Number(kelly.maxTradeSizeSol || 0.01),
      volatilityWindowDays: Number(kelly.volatilityWindowDays || 7),
      fallbackAnnualizedVolatilityPct: Number(kelly.fallbackAnnualizedVolatilityPct || 80),
    },
  };
}

function getAlphaSignalConfig(profile) {
  const alpha = profile?.yieldCycle?.alphaSignal || {};
  return {
    enabled: alpha.enabled !== false,
    shortTimeframe: alpha.shortTimeframe || '5m',
    longTimeframe: alpha.longTimeframe || '1h',
    shortWindowCandles: Math.max(2, Number(alpha.shortWindowCandles || 6)),
    longWindowCandles: Math.max(2, Number(alpha.longWindowCandles || 6)),
    deviationThresholdPct: Math.max(0, Number(alpha.deviationThresholdPct || 0.5)),
    momentumConfirmPct: Math.max(0, Number(alpha.momentumConfirmPct || 0.2)),
  };
}

function getAlphaReadinessConfig(profile) {
  const alpha = profile?.yieldCycle?.alphaReadiness || {};
  return {
    enabled: alpha.enabled !== false,
    minimumScore: clamp(Number(alpha.minimumScore || 60), 0, 100),
    requireQualifiedSpread: alpha.requireQualifiedSpread !== false,
    requireDirectionalSignal: alpha.requireDirectionalSignal !== false,
    historyLimit: Math.max(10, Number(alpha.historyLimit || 72)),
    minConsecutiveReadyCycles: Math.max(1, Number(alpha.minConsecutiveReadyCycles || 3)),
  };
}

function getAlphaExecutionConfig(profile) {
  const alpha = profile?.yieldCycle?.alphaExecution || {};
  return {
    enabled: alpha.enabled === true,
    mode: alpha.mode || 'observe',
    maxDailyExecutions: Math.max(0, Number(alpha.maxDailyExecutions || 1)),
    maxDailyLamports: Math.max(0, Number(alpha.maxDailyLamports || 0)),
    requireReadyStreak: alpha.requireReadyStreak !== false,
    requireQualifiedSpread: alpha.requireQualifiedSpread !== false,
    requireDirectionalSignal: alpha.requireDirectionalSignal !== false,
    paperOnly: alpha.paperOnly !== false,
    maxConsecutiveFailures: Math.max(1, Number(alpha.maxConsecutiveFailures || 3)),
    maxDailyLossLamports: Math.max(0, Number(alpha.maxDailyLossLamports || 0)),
  };
}

function getAlphaPromotionConfig(profile) {
  const promotion = profile?.yieldCycle?.alphaPromotion || {};
  return {
    enabled: promotion.enabled !== false,
    minimumAverageScore: Math.max(0, Number(promotion.minimumAverageScore || 70)),
    minimumReadyInWindow: Math.max(1, Number(promotion.minimumReadyInWindow || 3)),
    windowSize: Math.max(3, Number(promotion.windowSize || 5)),
    allowAutoLive: promotion.allowAutoLive === true,
    requireExecutionModePaper: promotion.requireExecutionModePaper !== false,
  };
}

function average(values) {
  const valid = (values || []).filter((value) => Number.isFinite(value));
  if (valid.length === 0) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function pctChange(current, baseline) {
  if (!(Number.isFinite(current) && Number.isFinite(baseline) && baseline !== 0)) return 0;
  return ((current - baseline) / baseline) * 100;
}

function evaluateAlphaSignal({ profile, inspection, shortCandles, longCandles }) {
  const config = getAlphaSignalConfig(profile);
  const currentPrice = Number(inspection?.currentPrice || 0);
  const result = {
    status: 'not-enabled',
    signal: 'neutral',
    currentPrice,
    shortTimeframe: config.shortTimeframe,
    longTimeframe: config.longTimeframe,
    shortWindowCandles: config.shortWindowCandles,
    longWindowCandles: config.longWindowCandles,
    deviationThresholdPct: config.deviationThresholdPct,
    momentumConfirmPct: config.momentumConfirmPct,
  };

  if (!config.enabled) {
    result.reason = 'disabled';
    return result;
  }

  if (!(currentPrice > 0)) {
    result.status = 'insufficient-data';
    result.reason = 'missing-current-price';
    return result;
  }

  const shortCloses = (shortCandles || [])
    .slice(-config.shortWindowCandles)
    .map((candle) => Number(candle?.close || 0))
    .filter((value) => value > 0);
  const longCloses = (longCandles || [])
    .slice(-config.longWindowCandles)
    .map((candle) => Number(candle?.close || 0))
    .filter((value) => value > 0);

  result.shortSampleCount = shortCloses.length;
  result.longSampleCount = longCloses.length;
  if (shortCloses.length < 2 || longCloses.length < 2) {
    result.status = 'insufficient-data';
    result.reason = 'not-enough-candles';
    return result;
  }

  result.shortSma = average(shortCloses);
  result.longSma = average(longCloses);
  result.deviationFromLongPct = pctChange(currentPrice, result.longSma);
  result.shortVsLongPct = pctChange(result.shortSma, result.longSma);
  result.shortTrendPct = pctChange(shortCloses[shortCloses.length - 1], shortCloses[0]);
  result.longTrendPct = pctChange(longCloses[longCloses.length - 1], longCloses[0]);
  result.status = 'ok';

  const buyDeviation = result.deviationFromLongPct <= (-1 * config.deviationThresholdPct);
  const buyMomentum = result.shortVsLongPct <= (-1 * config.momentumConfirmPct);
  const sellDeviation = result.deviationFromLongPct >= config.deviationThresholdPct;
  const sellMomentum = result.shortVsLongPct >= config.momentumConfirmPct;

  if (buyDeviation && buyMomentum) {
    result.signal = 'buy-base';
    result.bias = 'mean-reversion-long-base';
    result.reason = `price ${result.deviationFromLongPct.toFixed(3)}% below ${config.longTimeframe} SMA with short-term weakness confirmed`;
  } else if (sellDeviation && sellMomentum) {
    result.signal = 'sell-base';
    result.bias = 'mean-reversion-reduce-base';
    result.reason = `price ${result.deviationFromLongPct.toFixed(3)}% above ${config.longTimeframe} SMA with short-term strength confirmed`;
  } else {
    result.signal = 'neutral';
    result.bias = 'no-setup';
    result.reason = 'deviation and momentum thresholds not jointly satisfied';
  }

  const signalStrength = Math.abs(result.deviationFromLongPct) + Math.abs(result.shortVsLongPct);
  result.confidence = signalStrength >= (config.deviationThresholdPct * 3)
    ? 'high'
    : signalStrength >= (config.deviationThresholdPct * 1.5)
      ? 'medium'
      : 'low';
  return result;
}

function evaluateAlphaReadiness({ profile, alphaSignal, alphaCandidate }) {
  const config = getAlphaReadinessConfig(profile);
  const candidate = alphaCandidate || {};
  const signal = alphaSignal || {};
  const best = candidate.best || null;

  const result = {
    status: config.enabled ? 'ok' : 'not-enabled',
    ready: false,
    minimumScore: config.minimumScore,
    requireQualifiedSpread: config.requireQualifiedSpread,
    requireDirectionalSignal: config.requireDirectionalSignal,
    historyLimit: config.historyLimit,
    minConsecutiveReadyCycles: config.minConsecutiveReadyCycles,
    candidateQualified: Boolean(candidate.qualifies),
    directionalSignal: signal.signal || 'neutral',
    scoreBreakdown: {
      spreadScore: 0,
      signalScore: 0,
    },
    score: 0,
    reasons: [],
  };

  if (!config.enabled) {
    result.reasons.push('alpha-readiness-disabled');
    return result;
  }

  if (candidate.status !== 'ok' || !best) {
    result.status = 'insufficient-data';
    result.reasons.push('alpha-candidate-unavailable');
  } else {
    const spreadScore = clamp(Math.round((Number(best.netEdgeBps || 0) + 25) * 2), 0, 100);
    result.scoreBreakdown.spreadScore = spreadScore;
    result.bestCandidate = {
      name: best.name,
      direction: best.direction,
      netEdgeBps: Number(best.netEdgeBps || 0),
      netEdgeLamports: Number(best.netEdgeLamports || 0),
    };
    if (!candidate.qualifies) result.reasons.push('spread-not-positive');
  }

  if (signal.status !== 'ok') {
    result.status = 'insufficient-data';
    result.reasons.push('alpha-signal-unavailable');
  } else {
    let signalScore = 20;
    if (signal.signal === 'buy-base' || signal.signal === 'sell-base') signalScore = 70;
    if (signal.confidence === 'medium') signalScore += 10;
    if (signal.confidence === 'high') signalScore += 20;
    result.scoreBreakdown.signalScore = clamp(signalScore, 0, 100);
    result.signalSummary = {
      signal: signal.signal,
      confidence: signal.confidence || 'low',
      deviationFromLongPct: Number(signal.deviationFromLongPct || 0),
      shortVsLongPct: Number(signal.shortVsLongPct || 0),
    };
    if (signal.signal === 'neutral') result.reasons.push('signal-neutral');
  }

  result.score = Math.round((result.scoreBreakdown.spreadScore * 0.6) + (result.scoreBreakdown.signalScore * 0.4));

  if (config.requireQualifiedSpread && !candidate.qualifies) {
    result.reasons.push('qualified-spread-required');
  }
  if (config.requireDirectionalSignal && !(signal.signal === 'buy-base' || signal.signal === 'sell-base')) {
    result.reasons.push('directional-signal-required');
  }
  if (result.score < config.minimumScore) {
    result.reasons.push('score-below-threshold');
  }

  result.ready = result.status === 'ok'
    && result.score >= config.minimumScore
    && (!config.requireQualifiedSpread || Boolean(candidate.qualifies))
    && (!config.requireDirectionalSignal || signal.signal === 'buy-base' || signal.signal === 'sell-base');

  if (result.ready) {
    result.reasons = ['alpha-ready'];
  }

  return result;
}

function updateAlphaReadinessHistory({ timestamp, alphaReadiness, alphaSignal, alphaCandidate }) {
  const history = loadAlphaReadinessHistory();
  const entries = Array.isArray(history.entries) ? history.entries : [];
  const nextEntry = {
    timestamp,
    ready: Boolean(alphaReadiness?.ready),
    status: alphaReadiness?.status || 'unknown',
    score: Number(alphaReadiness?.score || 0),
    signal: alphaSignal?.signal || 'neutral',
    signalConfidence: alphaSignal?.confidence || 'unknown',
    candidateQualified: Boolean(alphaReadiness?.candidateQualified),
    bestCandidate: alphaReadiness?.bestCandidate?.name || alphaCandidate?.best?.name || null,
    reasons: Array.isArray(alphaReadiness?.reasons) ? alphaReadiness.reasons : [],
  };
  entries.push(nextEntry);

  const limit = Math.max(10, Number(alphaReadiness?.historyLimit || 72));
  const trimmed = entries.slice(-limit);
  const consecutiveReady = (() => {
    let count = 0;
    for (let index = trimmed.length - 1; index >= 0; index -= 1) {
      if (!trimmed[index]?.ready) break;
      count += 1;
    }
    return count;
  })();

  const summary = {
    lastUpdatedAt: timestamp,
    totalEntries: trimmed.length,
    consecutiveReadyCycles: consecutiveReady,
    readyInLast10: trimmed.slice(-10).filter((entry) => entry.ready).length,
    averageScoreLast10: average(trimmed.slice(-10).map((entry) => Number(entry.score || 0))),
  };

  const nextHistory = { entries: trimmed, summary };
  fs.writeFileSync(ALPHA_READINESS_HISTORY_LOG, JSON.stringify(nextHistory, null, 2), 'utf8');
  return nextHistory;
}

function evaluateAlphaExecutionPlan({ profile, alphaReadiness, alphaSignal, alphaCandidate }) {
  const config = getAlphaExecutionConfig(profile);
  const state = loadAlphaExecutionState();
  const todayKey = getTodayKey();
  const today = summarizeDailyBudget(state, todayKey);
  const bestCandidate = alphaCandidate?.best || null;
  const signal = alphaSignal?.signal || 'neutral';
  const readyStreak = Number(alphaReadiness?.history?.consecutiveReadyCycles || 0);
  const requiredStreak = Number(alphaReadiness?.minConsecutiveReadyCycles || 1);
  const gateReasons = [];

  if (!config.enabled) gateReasons.push('alpha-execution-disabled');
  if (config.mode !== 'live' && config.mode !== 'paper') gateReasons.push('alpha-execution-mode-invalid');
  if (config.paperOnly && config.mode === 'live') gateReasons.push('alpha-paper-only');
  if (config.requireReadyStreak && !(readyStreak >= requiredStreak)) gateReasons.push('alpha-ready-streak-missing');
  if (config.requireQualifiedSpread && !alphaCandidate?.qualifies) gateReasons.push('alpha-spread-not-qualified');
  if (config.requireDirectionalSignal && !(signal === 'buy-base' || signal === 'sell-base')) gateReasons.push('alpha-directional-signal-missing');
  if (today.executions >= config.maxDailyExecutions) gateReasons.push('alpha-daily-count-reached');

  const suggestedDirection = signal === 'buy-base'
    ? 'buy-base'
    : signal === 'sell-base'
      ? 'sell-base'
      : (bestCandidate?.direction || 'none');

  const suggestedAmountLamports = Math.max(
    0,
    Math.round(
      Number(
        profile?.yieldCycle?.microTransaction?.sizing?.kelly?.minTradeSizeSol || 0.0005
      ) * LAMPORTS_PER_SOL
    )
  );

  if (config.maxDailyLamports > 0 && (today.lamports + suggestedAmountLamports) > config.maxDailyLamports) {
    gateReasons.push('alpha-daily-lamports-reached');
  }

  return {
    status: gateReasons.length === 0 ? 'armed' : 'blocked',
    enabled: config.enabled,
    mode: config.mode,
    paperOnly: config.paperOnly,
    ready: gateReasons.length === 0,
    gateReasons,
    suggestedDirection,
    suggestedAmountLamports,
    suggestedAmountSol: suggestedAmountLamports / LAMPORTS_PER_SOL,
    bestCandidate: bestCandidate ? {
      name: bestCandidate.name,
      netEdgeBps: Number(bestCandidate.netEdgeBps || 0),
      netEdgeLamports: Number(bestCandidate.netEdgeLamports || 0),
      direction: bestCandidate.direction || 'none',
    } : null,
    directionalSignal: signal,
    score: Number(alphaReadiness?.score || 0),
    readyStreak,
    requiredStreak,
    budget: {
      executions: today.executions,
      lamports: today.lamports,
      maxDailyExecutions: config.maxDailyExecutions,
      maxDailyLamports: config.maxDailyLamports,
    },
  };
}

function recordAlphaExecutionPlan({ timestamp, plan }) {
  const state = loadAlphaExecutionState();
  const todayKey = getTodayKey();
  const today = summarizeDailyBudget(state, todayKey);
  state.byDate = state.byDate || {};
  state.byDate[todayKey] = {
    executions: today.executions,
    lamports: today.lamports,
    signatures: today.signatures,
    consecutiveFailures: Number(today.consecutiveFailures || 0),
    realizedLossLamports: Number(today.realizedLossLamports || 0),
    lastEffectiveMode: plan.effectiveMode || today.lastEffectiveMode || null,
    lastPlan: {
      timestamp,
      status: plan.status,
      ready: plan.ready,
      suggestedDirection: plan.suggestedDirection,
      suggestedAmountLamports: plan.suggestedAmountLamports,
      score: plan.score,
      gateReasons: plan.gateReasons,
      effectiveMode: plan.effectiveMode || plan.mode,
    },
  };
  fs.writeFileSync(ALPHA_EXECUTION_STATE_LOG, JSON.stringify(state, null, 2), 'utf8');
  return state.byDate[todayKey];
}

function evaluateAlphaSafety({ profile, alphaExecutionState, alphaExecution, alphaPromotion }) {
  const config = getAlphaExecutionConfig(profile);
  const state = alphaExecutionState || {};
  const consecutiveFailures = Number(state.consecutiveFailures || 0);
  const realizedLossLamports = Number(state.realizedLossLamports || 0);
  const gateReasons = [];

  if (config.maxConsecutiveFailures > 0 && consecutiveFailures >= config.maxConsecutiveFailures) {
    gateReasons.push('safety-max-consecutive-failures-reached');
  }
  if (config.maxDailyLossLamports > 0 && realizedLossLamports >= config.maxDailyLossLamports) {
    gateReasons.push('safety-max-daily-loss-reached');
  }

  const forcedPaper = gateReasons.length > 0;
  return {
    status: gateReasons.length > 0 ? 'tripped' : 'ok',
    forcedPaper,
    gateReasons,
    consecutiveFailures,
    maxConsecutiveFailures: config.maxConsecutiveFailures,
    realizedLossLamports,
    maxDailyLossLamports: config.maxDailyLossLamports,
    effectiveMode: forcedPaper ? 'paper' : (alphaPromotion?.effectiveMode || alphaExecution?.effectiveMode || alphaExecution?.mode || 'paper'),
  };
}

async function maybeNotifyAlphaState({ wallet, alphaExecutionState, alphaSafety }) {
  const previousMode = alphaExecutionState?.lastEffectiveMode || null;
  const nextMode = alphaSafety?.effectiveMode || null;
  const alerts = [];

  if (previousMode && nextMode && previousMode !== nextMode) {
    alerts.push(await sendTelegramAlert(`[pcprotocol] alpha mode changed for ${wallet}: ${previousMode} -> ${nextMode}`));
  }

  if (alphaSafety?.status === 'tripped') {
    alerts.push(await sendTelegramAlert(`[pcprotocol] alpha safety tripped for ${wallet}: ${alphaSafety.gateReasons.join(', ')}`));
  }

  return alerts;
}

function evaluateAlphaPromotion({ profile, alphaReadiness, alphaReadinessHistory, alphaExecution }) {
  const config = getAlphaPromotionConfig(profile);
  const summary = alphaReadinessHistory?.summary || {};
  const entries = Array.isArray(alphaReadinessHistory?.entries) ? alphaReadinessHistory.entries : [];
  const recent = entries.slice(-config.windowSize);
  const readyInWindow = recent.filter((entry) => entry.ready).length;
  const averageScoreInWindow = average(recent.map((entry) => Number(entry.score || 0)));
  const gateReasons = [];

  if (!config.enabled) gateReasons.push('promotion-disabled');
  if (config.requireExecutionModePaper && alphaExecution?.mode !== 'paper') gateReasons.push('promotion-requires-paper-mode');
  if (!(Number(summary.consecutiveReadyCycles || 0) >= Number(alphaReadiness?.minConsecutiveReadyCycles || 1))) gateReasons.push('promotion-ready-streak-missing');
  if (!(readyInWindow >= config.minimumReadyInWindow)) gateReasons.push('promotion-window-ready-count-missing');
  if (!(averageScoreInWindow >= config.minimumAverageScore)) gateReasons.push('promotion-average-score-too-low');
  if (!(alphaExecution?.ready)) gateReasons.push('promotion-execution-not-ready');

  const eligible = gateReasons.length === 0;
  const effectiveMode = eligible && config.allowAutoLive ? 'live' : (alphaExecution?.mode || 'paper');

  return {
    status: config.enabled ? 'ok' : 'not-enabled',
    eligible,
    allowAutoLive: config.allowAutoLive,
    effectiveMode,
    currentExecutionMode: alphaExecution?.mode || 'paper',
    windowSize: config.windowSize,
    minimumAverageScore: config.minimumAverageScore,
    minimumReadyInWindow: config.minimumReadyInWindow,
    readyInWindow,
    averageScoreInWindow,
    consecutiveReadyCycles: Number(summary.consecutiveReadyCycles || 0),
    requiredConsecutiveReadyCycles: Number(alphaReadiness?.minConsecutiveReadyCycles || 1),
    gateReasons,
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function estimatePortfolioEquitySol(lamports, inventory, impliedSolPriceUsd) {
  const nativeSol = Number(lamports || 0) / LAMPORTS_PER_SOL;
  const wrappedBaseSol = Number(inventory?.wrappedBase?.uiAmount || 0);
  const quoteUi = Number(inventory?.quote?.uiAmount || 0);
  const quoteAsSol = impliedSolPriceUsd > 0 ? (quoteUi / impliedSolPriceUsd) : 0;
  return nativeSol + wrappedBaseSol + quoteAsSol;
}

function estimateAnnualizedVolatilityPct(windowDays, fallbackPct) {
  try {
    const dir = path.join(process.cwd(), '.swarm', 'yield-cycle');
    if (!fs.existsSync(dir)) return fallbackPct;
    const now = Date.now();
    const cutoff = now - (Math.max(1, Number(windowDays || 7)) * 24 * 60 * 60 * 1000);
    const files = fs.readdirSync(dir).filter((file) => file.startsWith('cycle-') && file.endsWith('.json')).sort();
    const points = [];
    for (const file of files) {
      const full = path.join(dir, file);
      const raw = readJsonIfExists(full, null);
      if (!raw?.generatedAt) continue;
      const ts = new Date(raw.generatedAt).getTime();
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      const implied = Number(raw?.microTransaction?.profitability?.impliedSolPriceUsd || 0);
      if (implied > 0) points.push({ ts, price: implied });
    }
    if (points.length < 2) return fallbackPct;
    points.sort((a, b) => a.ts - b.ts);
    let sumSquared = 0;
    let sumYearFraction = 0;
    for (let i = 1; i < points.length; i += 1) {
      const prev = points[i - 1];
      const curr = points[i];
      if (!(prev.price > 0 && curr.price > 0)) continue;
      const dtMs = curr.ts - prev.ts;
      if (!(dtMs > 0)) continue;
      const yearFraction = dtMs / (365 * 24 * 60 * 60 * 1000);
      const logReturn = Math.log(curr.price / prev.price);
      sumSquared += logReturn * logReturn;
      sumYearFraction += yearFraction;
    }
    if (!(sumSquared > 0) || !(sumYearFraction > 0)) return fallbackPct;
    return Math.sqrt(sumSquared / sumYearFraction) * 100;
  } catch {
    return fallbackPct;
  }
}

function evaluateAlphaCandidate({ inspection, amountLamports, quote, profitability, bagsQuote }) {
  const jupiterImpliedSolUsd = Number(profitability?.impliedSolPriceUsd || 0);
  const meteoraPoolPrice = Number(inspection?.currentPrice || 0);
  const jupiterPriceImpactPct = Number(quote?.priceImpactPct || 0);
  const meteoraBaseFeePct = Number(inspection?.baseFeePct || 0);
  const meteoraDynamicFeePct = Number(inspection?.dynamicFeePct || 0);
  const bagsOutAmount = Number(bagsQuote?.outAmount || 0);
  const bagsImpliedSolUsd = amountLamports > 0 ? ((bagsOutAmount / 1e6) / (amountLamports / LAMPORTS_PER_SOL)) : 0;
  const bagsPriceImpactPct = Number(bagsQuote?.priceImpactPct || 0);
  const bagsPlatformFeeBps = Number(bagsQuote?.platformFee?.feeBps || 0);
  const amountSol = Number(amountLamports || 0) / LAMPORTS_PER_SOL;

  const result = {
    status: 'not-available',
    amountLamports,
    amountSol,
    jupiterImpliedSolUsd,
    meteoraPoolPrice,
    bagsImpliedSolUsd,
    jupiterPriceImpactPct,
    bagsPriceImpactPct,
    bagsPlatformFeeBps,
    meteoraBaseFeePct,
    meteoraDynamicFeePct,
    candidates: [],
  };

  function pushCandidate(name, referencePrice, priceImpactPct, extraCostBps) {
    if (!(referencePrice > 0) || !(jupiterImpliedSolUsd > 0)) return;
    const grossSpreadPct = ((referencePrice - jupiterImpliedSolUsd) / jupiterImpliedSolUsd) * 100;
    const grossSpreadBps = grossSpreadPct * 100;
    const estimatedCostBps = (jupiterPriceImpactPct * 100) + (Number(priceImpactPct || 0) * 100) + Number(extraCostBps || 0);
    const netEdgeBps = grossSpreadBps - estimatedCostBps;
    const netEdgeLamports = Math.round(amountLamports * (netEdgeBps / 10000));
    result.candidates.push({
      name,
      referencePrice,
      grossSpreadPct,
      grossSpreadBps,
      estimatedCostBps,
      netEdgeBps,
      netEdgeLamports,
      qualifies: netEdgeLamports > 0,
      direction: netEdgeBps > 0 ? `buy-jupiter-sell-${name}` : 'no-positive-spread',
    });
  }

  pushCandidate('meteora', meteoraPoolPrice, 0, (meteoraBaseFeePct * 100) + (meteoraDynamicFeePct * 100));
  pushCandidate('bags', bagsImpliedSolUsd, bagsPriceImpactPct, bagsPlatformFeeBps);

  if (result.candidates.length === 0) {
    result.status = 'insufficient-data';
    return result;
  }

  result.status = 'ok';
  result.best = result.candidates.slice().sort((a, b) => b.netEdgeLamports - a.netEdgeLamports)[0] || null;
  result.qualifies = Boolean(result.best?.qualifies);
  result.direction = result.best?.direction || 'no-positive-spread';
  result.netEdgeLamports = Number(result.best?.netEdgeLamports || 0);
  result.netEdgeBps = Number(result.best?.netEdgeBps || 0);
  return result;
}

function computeDynamicTradeSizeSol({ profile, micro, lamports, inventory, probeAmountLamports, quote, profitability }) {
  const sizing = getMicroSizingConfig(profile, micro);
  const fixedSizeSol = sizing.fixedSizeSol > 0 ? sizing.fixedSizeSol : (probeAmountLamports / LAMPORTS_PER_SOL);
  const minTradeSizeSol = Math.max(0, sizing.kelly.minTradeSizeSol || 0);
  const maxTradeSizeSol = Math.max(minTradeSizeSol || fixedSizeSol, sizing.kelly.maxTradeSizeSol || fixedSizeSol);
  const impliedSolPriceUsd = Number(profitability?.impliedSolPriceUsd || 0);
  const portfolioEquitySol = estimatePortfolioEquitySol(lamports, inventory, impliedSolPriceUsd);
  const estimatedEdgePct = probeAmountLamports > 0 && Number.isFinite(profitability?.netGainLamports)
    ? (Number(profitability.netGainLamports) / probeAmountLamports) * 100
    : 0;
  const annualizedVolatilityPct = estimateAnnualizedVolatilityPct(sizing.kelly.volatilityWindowDays, sizing.kelly.fallbackAnnualizedVolatilityPct);

  const result = {
    mode: sizing.mode,
    portfolioEquitySol,
    estimatedEdgePct,
    annualizedVolatilityPct,
    probeAmountLamports,
    fixedSizeSol,
    minTradeSizeSol,
    maxTradeSizeSol,
    amountSol: clamp(fixedSizeSol, minTradeSizeSol || fixedSizeSol, maxTradeSizeSol || fixedSizeSol),
    reason: 'fixed-size',
  };

  if (sizing.mode !== 'kelly') {
    result.amountLamports = Math.max(1, Math.round(result.amountSol * LAMPORTS_PER_SOL));
    return result;
  }

  const minutesPerYear = 525600;
  const tradeHorizonMinutes = 5;
  const volPerTradeDecimal = (annualizedVolatilityPct / 100) * Math.sqrt(tradeHorizonMinutes / minutesPerYear);
  const variance = volPerTradeDecimal * volPerTradeDecimal;
  const edgeDecimal = estimatedEdgePct / 100;
  result.volPerTradePct = volPerTradeDecimal * 100;
  result.variance = variance;

  if (!(edgeDecimal > 0) || !(variance > 0) || !(portfolioEquitySol > 0)) {
    result.reason = 'kelly-fallback-non-positive-edge';
    result.amountSol = clamp(fixedSizeSol, minTradeSizeSol || fixedSizeSol, maxTradeSizeSol || fixedSizeSol);
    result.amountLamports = Math.max(1, Math.round(result.amountSol * LAMPORTS_PER_SOL));
    return result;
  }

  const rawKellyFraction = edgeDecimal / variance;
  const scaledKellyFraction = rawKellyFraction * sizing.kelly.kellyFraction;
  const cappedRiskFraction = Math.min(Math.max(0, scaledKellyFraction), sizing.kelly.maxRiskPerTrade);
  const computedSizeSol = portfolioEquitySol * cappedRiskFraction;
  result.rawKellyFraction = rawKellyFraction;
  result.scaledKellyFraction = scaledKellyFraction;
  result.cappedRiskFraction = cappedRiskFraction;
  result.amountSol = clamp(computedSizeSol, minTradeSizeSol || fixedSizeSol, maxTradeSizeSol || fixedSizeSol);
  result.reason = 'kelly-sized';
  result.amountLamports = Math.max(1, Math.round(result.amountSol * LAMPORTS_PER_SOL));
  return result;
}

async function runMicroTransactionProbe(connection, wallet, profile, lamports, minReserve, rebalanceState, inventory) {
  const cycle = profile.yieldCycle || {};
  const micro = cycle.microTransaction || {};
  const inputMint = profile.preflight?.inputMint;
  const outputMint = profile.preflight?.outputMint;
  const configuredAmountLamports = Number(micro.amountLamports || 0);
  const slippageBps = Number(micro.maxSlippageBps || cycle.maxSlippageBps || 50);
  const todayKey = getTodayKey();
  const microState = loadMicroExecutionState();
  const dailyBudget = summarizeDailyBudget(microState, todayKey);
  const preflightState = micro.requireFreshPreflight === false ? { ok: true, reason: 'not-required' } : hasFreshPreflight();
  const forceNoSend = String(process.env.YIELD_FORCE_NO_SEND || '').toLowerCase() === 'true';
  const liveEnabled = !forceNoSend && profile.mode === 'live' && cycle.executionEnabled === true && micro.enabled === true;
  const reserveLamports = Math.floor(Number(minReserve || 0) * LAMPORTS_PER_SOL);
  const sizingSeed = getMicroSizingConfig(profile, micro);
  const probeAmountLamports = Math.max(1, Math.round((sizingSeed.fixedSizeSol > 0 ? sizingSeed.fixedSizeSol : (configuredAmountLamports / LAMPORTS_PER_SOL || 0.001)) * LAMPORTS_PER_SOL));

  const gateReasons = [];
  if (!inputMint || !outputMint) gateReasons.push('preflight-route-missing');
  if (!preflightState.ok) gateReasons.push(preflightState.reason);
  if (rebalanceState?.action !== 'rebalance-quote-inventory') gateReasons.push('wallet-rebalance-not-needed');

  const primaryBlockReason = gateReasons[0] || null;
  const result = {
    status: 'not-run',
    liveEnabled,
    inputMint: inputMint || null,
    outputMint: outputMint || null,
    configuredAmountLamports,
    probeAmountLamports,
    amountLamports: probeAmountLamports,
    amountSol: probeAmountLamports / LAMPORTS_PER_SOL,
    slippageBps,
    reserveTargetSol: Number(minReserve || 0),
    dailyBudget,
    gateReasons,
    blockReason: primaryBlockReason,
    preflightState,
    rebalanceAction: rebalanceState?.action || 'unknown',
  };

  if (gateReasons.length > 0 && !(gateReasons.length === 1 && gateReasons[0] === 'wallet-rebalance-not-needed')) {
    result.status = 'blocked';
    result.blockReason = primaryBlockReason;
    return result;
  }

  if (rebalanceState?.action !== 'rebalance-quote-inventory') {
    result.status = 'not-needed';
    result.blockReason = 'wallet-rebalance-not-needed';
    return result;
  }

  const probeQuoteResponse = await fetchJupiterQuote(inputMint, outputMint, probeAmountLamports, slippageBps);
  let probeBagsQuote = null;
  try {
    const bagsProbeResponse = await fetchBagsQuote(inputMint, outputMint, probeAmountLamports, slippageBps);
    probeBagsQuote = bagsProbeResponse.quote;
    result.bagsQuote = {
      outAmount: probeBagsQuote.outAmount,
      priceImpactPct: probeBagsQuote.priceImpactPct,
      platformFeeBps: probeBagsQuote?.platformFee?.feeBps || 0,
      routePlanLength: Array.isArray(probeBagsQuote.routePlan) ? probeBagsQuote.routePlan.length : 0,
      venue: Array.isArray(probeBagsQuote.routePlan) && probeBagsQuote.routePlan[0]?.venue ? probeBagsQuote.routePlan[0].venue : null,
    };
  } catch (error) {
    result.bagsQuote = { error: error.message };
  }
  const probeQuote = probeQuoteResponse.quote;
  const probeProfitability = evaluateMicroProfitability({
    profile,
    inputMint,
    outputMint,
    amountLamports: probeAmountLamports,
    quote: probeQuote,
    swapResponse: { prioritizationFeeLamports: 10000 },
    slippageBps,
    rebalanceState,
    microState,
  });
  const sizing = computeDynamicTradeSizeSol({
    profile,
    micro,
    lamports,
    inventory,
    probeAmountLamports,
    quote: probeQuote,
    profitability: probeProfitability,
  });
  const amountLamports = Math.max(1, Number(sizing.amountLamports || probeAmountLamports));
  result.sizing = sizing;
  result.amountLamports = amountLamports;
  result.amountSol = amountLamports / LAMPORTS_PER_SOL;
  result.alphaCandidate = evaluateAlphaCandidate({
    inspection: {
      currentPrice: Number(rebalanceState?.inspectionCurrentPrice || 0),
      baseFeePct: Number(rebalanceState?.inspectionBaseFeePct || 0),
      dynamicFeePct: Number(rebalanceState?.inspectionDynamicFeePct || 0),
    },
    amountLamports,
    quote: probeQuote,
    profitability: probeProfitability,
    bagsQuote: probeBagsQuote,
  });

  const remainingAfterTrade = lamports - amountLamports;
  const budgetAllowsCount = dailyBudget.executions < Number(micro.maxDailyExecutions || 0);
  const budgetAllowsLamports = dailyBudget.lamports + amountLamports <= Number(micro.maxDailyLamports || 0);
  if (!Number.isFinite(amountLamports) || amountLamports <= 0) result.gateReasons.push('amount-invalid');
  if (remainingAfterTrade < reserveLamports) result.gateReasons.push('reserve-would-be-breached');
  if (!budgetAllowsCount) result.gateReasons.push('daily-execution-count-reached');
  if (!budgetAllowsLamports) result.gateReasons.push('daily-lamports-budget-reached');

  if (result.gateReasons.length > 0 && !(result.gateReasons.length === 1 && result.gateReasons[0] === 'wallet-rebalance-not-needed')) {
    result.status = 'blocked';
    result.blockReason = result.gateReasons[0] || null;
    return result;
  }

  let quoteUrl = probeQuoteResponse.quoteUrl;
  let quote = probeQuote;
  if (amountLamports !== probeAmountLamports) {
    const finalQuoteResponse = await fetchJupiterQuote(inputMint, outputMint, amountLamports, slippageBps);
    quoteUrl = finalQuoteResponse.quoteUrl;
    quote = finalQuoteResponse.quote;
  }

  result.quote = {
    url: quoteUrl,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    otherAmountThreshold: quote.otherAmountThreshold,
    priceImpactPct: quote.priceImpactPct,
    routePlanLength: Array.isArray(quote.routePlan) ? quote.routePlan.length : 0,
  };

  const { transaction, swapResponse } = await buildJupiterSwapTransaction(wallet, quote, micro.memo);
  const simulation = await connection.simulateTransaction(transaction, { commitment: 'confirmed' });
  result.simulation = {
    err: simulation.value.err,
    unitsConsumed: simulation.value.unitsConsumed || 0,
    logsTail: Array.isArray(simulation.value.logs) ? simulation.value.logs.slice(-10) : [],
  };

  if (simulation.value.err) {
    result.status = 'simulation-failed';
    return result;
  }

  result.status = liveEnabled ? 'ready-to-send' : 'simulated-only';
  result.swapBuild = {
    lastValidBlockHeight: swapResponse.lastValidBlockHeight || null,
    prioritizationFeeLamports: swapResponse.prioritizationFeeLamports || null,
  };

  result.profitability = evaluateMicroProfitability({
    profile,
    inputMint,
    outputMint,
    amountLamports,
    quote,
    swapResponse,
    slippageBps,
    rebalanceState,
    microState,
  });
  result.alphaCandidate = evaluateAlphaCandidate({
    inspection: {
      currentPrice: Number(rebalanceState?.inspectionCurrentPrice || 0),
      baseFeePct: Number(rebalanceState?.inspectionBaseFeePct || 0),
      dynamicFeePct: Number(rebalanceState?.inspectionDynamicFeePct || 0),
    },
    amountLamports,
    quote,
    profitability: result.profitability,
    bagsQuote: probeBagsQuote,
  });
  result.profitability.maintenance = result.profitability.maintenance || {};
  if (result.profitability.maintenance) {
    result.profitability.maintenance.target = computeMaintenanceTargetUsdc(
      getMicroMaintenanceConfig(profile),
      result.profitability.impliedSolPriceUsd,
      amountLamports,
      result.profitability.quoteUi,
      quote?.priceImpactPct,
      amountLamports / LAMPORTS_PER_SOL,
    );
    result.profitability.maintenance.minQuoteTarget = result.profitability.maintenance.target.targetUsdc;
  }

  if (liveEnabled && result.profitability?.passes === false) {
    result.status = 'skipped-unprofitable';
    result.blockReason = result.profitability.reason;
    return result;
  }

  if (!liveEnabled) return result;

  const signature = await connection.sendTransaction(transaction, { skipPreflight: false, maxRetries: 3 });
  const confirmation = await connection.confirmTransaction(signature, micro.confirmCommitment || 'confirmed');
  result.signature = signature;
  result.confirmation = { value: confirmation.value };
  result.status = confirmation.value?.err ? 'send-failed' : 'sent';

  const nextState = loadMicroExecutionState();
  const nextDay = summarizeDailyBudget(nextState, todayKey);
  nextState.byDate = nextState.byDate || {};
  const maintenanceExecutions = Array.isArray(nextDay.maintenanceExecutions) ? nextDay.maintenanceExecutions : [];
  nextState.byDate[todayKey] = {
    executions: nextDay.executions + 1,
    lamports: nextDay.lamports + amountLamports,
    signatures: [...nextDay.signatures, signature],
    maintenanceExecutions: result.profitability?.mode === 'maintenance'
      ? [...maintenanceExecutions, { timestamp: new Date().toISOString(), signature, amountLamports }]
      : maintenanceExecutions,
  };
  fs.writeFileSync(MICRO_EXECUTION_LOG, JSON.stringify(nextState, null, 2), 'utf8');

  return result;
}

async function main() {
  const { profile, profilePath } = loadProfile();
  const cycle = profile.yieldCycle || {};
  const walletPath = path.resolve(process.cwd(), profile.walletKeypairPath || process.env.WALLET_KEYPAIR_PATH || './wallet.json');
  const walletSecret = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(walletSecret));
  const connection = new Connection(process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com', 'confirmed');
  const lamports = await connection.getBalance(wallet.publicKey);
  const sol = lamports / LAMPORTS_PER_SOL;

  fs.mkdirSync(MICRO_STATE_DIR, { recursive: true });
  const timestamp = new Date().toISOString();

  const liveMode = profile.mode === 'live';
  const executionEnabled = cycle.executionEnabled === true && liveMode;
  const minCycleWalletSol = Number(cycle.minCycleWalletSol || 0.005);
  const minReserve = Number(cycle.minNativeSolReserve || 0.02);
  const actionable = sol >= minCycleWalletSol;

  let pools = [];
  let selectedPool = null;
  let inspection = { status: 'not-run', recommendedAction: 'none' };
  try {
    pools = await fetchMeteoraPools();
    selectedPool = selectPool(pools, cycle.pool || '');
    let poolDetail = null;
    let walletPosition = null;
    let onChainPosition = null;
    if (selectedPool?.address) {
      poolDetail = await fetchPoolDetail(selectedPool.address);
      [walletPosition, onChainPosition] = await Promise.all([
        fetchWalletEarning(wallet.publicKey.toBase58(), selectedPool.address),
        fetchOnChainPositionSignal(connection, wallet.publicKey, selectedPool.address),
      ]);
    }
    inspection = buildInspection(selectedPool, cycle, actionable, poolDetail, walletPosition, onChainPosition);
  } catch (error) {
    inspection = { status: 'fetch-failed', recommendedAction: 'review-meteora-connectivity', error: error.message, source: METEORA_POOLS_URL };
  }

  const inventory = await fetchWalletInventory(connection, wallet.publicKey, lamports, cycle);
  const walletRebalance = computeWalletRebalance(profile, cycle, inventory, inspection);
  if (inspection.status === 'ok' && walletRebalance.action === 'rebalance-quote-inventory') {
    inspection.recommendedAction = 'rebalance-wallet-for-positioning';
  }
  walletRebalance.inspectionCurrentPrice = Number(inspection.currentPrice || 0);
  walletRebalance.inspectionBaseFeePct = Number(inspection.baseFeePct || 0);
  walletRebalance.inspectionDynamicFeePct = Number(inspection.dynamicFeePct || 0);

  let microTransaction = { status: 'not-configured', liveEnabled: false };
  if (cycle.microTransaction) {
    try {
      microTransaction = await runMicroTransactionProbe(connection, wallet, profile, lamports, minReserve, walletRebalance, inventory);
    } catch (error) {
      microTransaction = { status: 'probe-error', liveEnabled: liveMode && cycle.executionEnabled === true && cycle.microTransaction.enabled === true, error: error.message };
    }
  }

  let alphaSignal = { status: 'not-run', signal: 'neutral', reason: 'inspection-unavailable' };
  if (selectedPool?.address && inspection.status === 'ok') {
    try {
      const alphaConfig = getAlphaSignalConfig(profile);
      if (alphaConfig.enabled) {
        const [shortCandles, longCandles] = await Promise.all([
          fetchPoolOhlcv(selectedPool.address, alphaConfig.shortTimeframe),
          fetchPoolOhlcv(selectedPool.address, alphaConfig.longTimeframe),
        ]);
        alphaSignal = evaluateAlphaSignal({ profile, inspection, shortCandles, longCandles });
      } else {
        alphaSignal = evaluateAlphaSignal({ profile, inspection, shortCandles: [], longCandles: [] });
      }
    } catch (error) {
      alphaSignal = { status: 'fetch-failed', signal: 'neutral', reason: error.message };
    }
  }

  const alphaReadiness = evaluateAlphaReadiness({
    profile,
    alphaSignal,
    alphaCandidate: microTransaction.alphaCandidate || null,
  });
  const alphaReadinessHistory = updateAlphaReadinessHistory({
    timestamp,
    alphaReadiness,
    alphaSignal,
    alphaCandidate: microTransaction.alphaCandidate || null,
  });
  alphaReadiness.history = alphaReadinessHistory.summary;
  alphaReadiness.ready = alphaReadiness.ready
    && alphaReadinessHistory.summary.consecutiveReadyCycles >= Number(alphaReadiness.minConsecutiveReadyCycles || 1);
  if (!alphaReadiness.ready && alphaReadinessHistory.summary.consecutiveReadyCycles < Number(alphaReadiness.minConsecutiveReadyCycles || 1)) {
    alphaReadiness.reasons = Array.from(new Set([...(alphaReadiness.reasons || []), 'insufficient-ready-streak']));
  }
  const alphaExecution = evaluateAlphaExecutionPlan({
    profile,
    alphaReadiness,
    alphaSignal,
    alphaCandidate: microTransaction.alphaCandidate || null,
  });
  const alphaPromotion = evaluateAlphaPromotion({
    profile,
    alphaReadiness,
    alphaReadinessHistory,
    alphaExecution,
  });
  alphaExecution.effectiveMode = alphaPromotion.effectiveMode;
  const previousAlphaExecutionState = loadAlphaExecutionState().byDate?.[getTodayKey()] || null;
  const alphaExecutionState = recordAlphaExecutionPlan({ timestamp, plan: alphaExecution });
  const alphaSafety = evaluateAlphaSafety({
    profile,
    alphaExecutionState,
    alphaExecution,
    alphaPromotion,
  });
  alphaExecution.effectiveMode = alphaSafety.effectiveMode;
  alphaPromotion.effectiveMode = alphaSafety.effectiveMode;
  const alphaAlerts = await maybeNotifyAlphaState({
    wallet: wallet.publicKey.toBase58(),
    alphaExecutionState: previousAlphaExecutionState,
    alphaSafety,
  });

  const reserveLamports = Math.floor(minReserve * LAMPORTS_PER_SOL);
  const coordinationState = deriveYieldCoordinationState({
    timestamp,
    actionable,
    profile,
    inspection,
    walletRebalance,
    microTransaction,
    alphaExecution,
    alphaSafety,
  });
  const yieldEngineState = upsertEngineState('yield-cycle', {
    state: coordinationState.state,
    reason: coordinationState.reason,
    cooldownUntil: coordinationState.cooldownUntil,
    metadata: coordinationState.metadata,
  });
  const capitalReservation = setCapitalReservation('yield-cycle', coordinationState.reservationLamports, {
    reason: coordinationState.reason,
    metadata: {
      walletRebalanceAction: walletRebalance.action,
      alphaSuggestedDirection: alphaExecution?.suggestedDirection || null,
    },
    expiresAt: coordinationState.reservationLamports > 0 ? addSecondsToIso(timestamp, 15 * 60) : null,
  });
  const capitalSummary = getCapitalSummary({
    walletLamports: lamports,
    reserveLamports,
  });
  const latestScoutOpportunity = getLatestOpportunity({ source: 'arb-scout' });
  const economicResult = deriveYieldEconomicResult({
    executionEnabled,
    actionable,
    walletRebalance,
    microTransaction,
    alphaExecution,
    alphaSafety,
  });

  const report = {
    generatedAt: timestamp,
    profilePath,
    strategyId: profile.id,
    strategyType: profile.strategyType || 'unknown',
    mode: profile.mode,
    protocol: cycle.protocol || 'unknown',
    pool: cycle.pool || 'unknown',
    wallet: wallet.publicKey.toBase58(),
    balances: {
      lamports,
      sol,
      reserveTargetSol: minReserve,
      minCycleWalletSol,
    },
    walletInventory: inventory,
    walletRebalance,
    execution: {
      executionEnabled,
      actionable,
      status: economicResult.executionStatus,
      nextAction: inspection.recommendedAction || (actionable ? 'inspect-and-plan-rebalance' : 'await-more-capital-or-reduce-thresholds'),
    },
    strategy: {
      positionWidthBps: cycle.positionWidthBps,
      rebalanceThreshold: cycle.rebalanceThreshold,
      maxSlippageBps: cycle.maxSlippageBps,
      compoundFrequencyMinutes: cycle.compoundFrequencyMinutes,
    },
    inspection,
    microTransaction,
    alphaCandidate: microTransaction.alphaCandidate || null,
    alphaSignal,
    alphaReadiness,
    alphaReadinessHistory: alphaReadinessHistory.summary,
    alphaExecution,
    alphaPromotion,
    alphaExecutionState,
    alphaSafety,
    alphaAlerts,
    outcomeCode: economicResult.outcomeCode,
    economicAcceptance: economicResult.economicAcceptance,
    coordination: {
      yieldEngineState,
      capitalReservation,
      capitalSummary,
      latestScoutOpportunity,
      snapshot: summarizeCoordinator({
        walletLamports: lamports,
        reserveLamports,
      }),
    },
    notes: [
      'This worker is a bounded scaffold for a future Meteora-style DLMM strategy.',
      'The microtransaction path now only sends when wallet inventory actually needs quote-side rebalancing.',
      'Pool inspection uses Meteora public data endpoints and direct Solana RPC position discovery.',
      'Alpha signal is read-only and uses Meteora OHLCV mean-reversion thresholds to surface directional setups before enabling new live paths.',
      'Alpha readiness combines directional signal quality and spread quality into a scored, non-executing recommendation layer.',
      'A rolling readiness history now tracks persistence so future live alpha deployment can require repeated readiness instead of a single spike.',
      'Alpha execution is now deployment-ready but remains gated; it records what it would do without sending a second live alpha trade path yet.',
      'Alpha promotion computes when the paper alpha path has earned the right to elevate to live mode through sustained, repeatable readiness.',
      'Alpha safety adds unattended guardrails for failure streaks, daily loss ceilings, and alerting when the effective alpha mode changes or safety trips.'
    ],
    outcome: economicResult.outcome,
  };

  const latestPath = path.join(MICRO_STATE_DIR, 'latest-cycle.json');
  const historyPath = path.join(MICRO_STATE_DIR, `cycle-${timestamp.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(latestPath, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(historyPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(`[YIELD] Strategy: ${report.strategyId}`);
  console.log(`[YIELD] Wallet: ${report.wallet}`);
  console.log(`[YIELD] SOL balance: ${sol.toFixed(6)}`);
  console.log(`[YIELD] Mode: ${report.mode}`);
  console.log(`[YIELD] Execution status: ${report.execution.status}`);
  console.log(`[YIELD] Pool inspection: ${inspection.status}`);
  if (inspection.poolName) console.log(`[YIELD] Selected pool: ${inspection.poolName} (${inspection.poolAddress}) TVL=${inspection.tvl}`);
  console.log(`[YIELD] Quote inventory: ${Number(inventory?.quote?.uiAmount || 0).toFixed(6)} ${cycle.quoteToken || 'QUOTE'}`);
  console.log(`[YIELD] Wallet rebalance action: ${walletRebalance.action}`);
  console.log(`[YIELD] Microtransaction status: ${microTransaction.status}`);
  console.log(`[YIELD] Economic acceptance: ${report.economicAcceptance.status} (${report.economicAcceptance.orchestrationOutcome})`);
  console.log(`[YIELD] Alpha signal: ${alphaSignal.signal} (${alphaSignal.status})`);
  console.log(`[YIELD] Alpha readiness: ${alphaReadiness.ready ? 'ready' : 'not-ready'} score=${alphaReadiness.score}`);
  console.log(`[YIELD] Alpha streak: ${alphaReadinessHistory.summary.consecutiveReadyCycles}/${alphaReadiness.minConsecutiveReadyCycles}`);
  console.log(`[YIELD] Alpha execution: ${alphaExecution.status} (${alphaExecution.suggestedDirection})`);
  console.log(`[YIELD] Alpha promotion: ${alphaPromotion.eligible ? 'eligible' : 'not-eligible'} effectiveMode=${alphaPromotion.effectiveMode}`);
  console.log(`[YIELD] Alpha safety: ${alphaSafety.status} effectiveMode=${alphaSafety.effectiveMode}`);
  console.log(`[YIELD] Coordinator state: ${yieldEngineState.state}`);
  console.log(`[YIELD] Coordinator available lamports: ${capitalSummary.availableLamports}`);
  if (microTransaction.quote) console.log(`[YIELD] Micro quote out amount: ${microTransaction.quote.outAmount}`);
  if (microTransaction.signature) console.log(`[YIELD] Micro signature: ${microTransaction.signature}`);
  console.log(report.outcome);
  console.log('YIELD_CYCLE_COMPLETED');
}

main().catch((error) => fail(error.message));
