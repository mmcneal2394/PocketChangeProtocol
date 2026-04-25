type MaybeNumber = number | null | undefined;

function toFiniteNumber(value: MaybeNumber, fallback = 0): number {
  const numeric = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

type BundlerSignalConfig = {
  enabled?: boolean;
  warnScore?: MaybeNumber;
  blockScore?: MaybeNumber;
  blockLiquidityUsdCeiling?: MaybeNumber;
  blockHolderCountCeiling?: MaybeNumber;
  maxFreshTokenAgeSec?: MaybeNumber;
  cooldownWarnSeconds?: MaybeNumber;
  cooldownBlockSeconds?: MaybeNumber;
  strongFlowBuys60s?: MaybeNumber;
  strongFlowSolVolume60s?: MaybeNumber;
  strongFlowVelocity?: MaybeNumber;
  flatMomentum5mPct?: MaybeNumber;
  flatMomentum1mPct?: MaybeNumber;
  highTurnoverToLiquidityRatio?: MaybeNumber;
  lowHolderCountThreshold?: MaybeNumber;
  heavyTop10PctThreshold?: MaybeNumber;
  blockEntryModes?: string[];
};

type BundlerSignalInput = {
  entryMode?: string | null;
  tokenAgeSec?: MaybeNumber;
  marketCapUsd?: MaybeNumber;
  liquidityUsd?: MaybeNumber;
  volume1hUsd?: MaybeNumber;
  momentum5mPct?: MaybeNumber;
  momentum1mPct?: MaybeNumber;
  momentum1hPct?: MaybeNumber;
  buys1h?: MaybeNumber;
  sells1h?: MaybeNumber;
  buyRatio?: MaybeNumber;
  buys60s?: MaybeNumber;
  sells60s?: MaybeNumber;
  buyRatio60s?: MaybeNumber;
  velocity?: MaybeNumber;
  solVolume60s?: MaybeNumber;
  holderCount?: MaybeNumber;
  top10Pct?: MaybeNumber;
  isJitterBundle?: boolean;
};

function evaluateBundlerSuspicion(input: BundlerSignalInput, config: BundlerSignalConfig = {}) {
  const entryMode = String(input.entryMode || 'normal');
  const liquidityUsd = Math.max(0, toFiniteNumber(input.liquidityUsd, 0));
  const volume1hUsd = Math.max(0, toFiniteNumber(input.volume1hUsd, 0));
  const momentum5mPct = toFiniteNumber(input.momentum5mPct, 0);
  const momentum1mPct = toFiniteNumber(input.momentum1mPct, 0);
  const buys60s = Math.max(0, toFiniteNumber(input.buys60s, 0));
  const sells60s = Math.max(0, toFiniteNumber(input.sells60s, 0));
  const buyRatio60s = Math.max(0, toFiniteNumber(input.buyRatio60s, 0));
  const velocity = Math.max(0, toFiniteNumber(input.velocity, 0));
  const solVolume60s = Math.max(0, toFiniteNumber(input.solVolume60s, 0));
  const holderCount = Math.max(0, toFiniteNumber(input.holderCount, 0));
  const top10Pct = Math.max(0, toFiniteNumber(input.top10Pct, 0));
  const tokenAgeSec = Math.max(0, toFiniteNumber(input.tokenAgeSec, 0));

  const warnScore = clamp01(toFiniteNumber(config.warnScore, 0.45));
  const blockScore = clamp01(toFiniteNumber(config.blockScore, 0.72));
  const blockLiquidityUsdCeiling = Math.max(0, toFiniteNumber(config.blockLiquidityUsdCeiling, 50000));
  const blockHolderCountCeiling = Math.max(1, toFiniteNumber(config.blockHolderCountCeiling, 200));
  const maxFreshTokenAgeSec = Math.max(0, toFiniteNumber(config.maxFreshTokenAgeSec, 900));
  const cooldownWarnSeconds = Math.max(10, Math.round(toFiniteNumber(config.cooldownWarnSeconds, 180)));
  const cooldownBlockSeconds = Math.max(cooldownWarnSeconds, Math.round(toFiniteNumber(config.cooldownBlockSeconds, 900)));
  const strongFlowBuys60s = Math.max(1, toFiniteNumber(config.strongFlowBuys60s, 8));
  const strongFlowSolVolume60s = Math.max(0.1, toFiniteNumber(config.strongFlowSolVolume60s, 2));
  const strongFlowVelocity = Math.max(1, toFiniteNumber(config.strongFlowVelocity, 10));
  const flatMomentum5mPct = Math.max(0.1, toFiniteNumber(config.flatMomentum5mPct, 2));
  const flatMomentum1mPct = Math.max(0.05, toFiniteNumber(config.flatMomentum1mPct, 0.75));
  const highTurnoverToLiquidityRatio = Math.max(0.1, toFiniteNumber(config.highTurnoverToLiquidityRatio, 2.5));
  const lowHolderCountThreshold = Math.max(1, toFiniteNumber(config.lowHolderCountThreshold, 120));
  const heavyTop10PctThreshold = Math.max(1, toFiniteNumber(config.heavyTop10PctThreshold, 35));
  const blockEntryModes = Array.isArray(config.blockEntryModes) && config.blockEntryModes.length > 0
    ? config.blockEntryModes.map((mode) => String(mode))
    : ['normal', 'micro-scout', 'last-stand'];

  const turnoverToLiquidityRatio = liquidityUsd > 0 ? volume1hUsd / liquidityUsd : 0;
  const priceResponsePerSol = Math.abs(momentum5mPct) / Math.max(0.25, solVolume60s);
  const flatTape =
    Math.abs(momentum5mPct) <= flatMomentum5mPct &&
    Math.abs(momentum1mPct) <= flatMomentum1mPct;
  const strongFlow =
    buys60s >= strongFlowBuys60s &&
    (solVolume60s >= strongFlowSolVolume60s || velocity >= strongFlowVelocity);
  const freshLaunch = tokenAgeSec > 0 && tokenAgeSec <= maxFreshTokenAgeSec;

  const flags: string[] = [];
  let score = 0;

  if (strongFlow && flatTape && buyRatio60s >= 0.82) {
    score += 0.35;
    flags.push('buy_pressure_without_price_response');
  }

  if (
    strongFlow &&
    flatTape &&
    buyRatio60s >= 0.52 &&
    buyRatio60s <= 0.72 &&
    buys60s >= strongFlowBuys60s + 2
  ) {
    score += 0.2;
    flags.push('balanced_churn_without_price_response');
  }

  if (turnoverToLiquidityRatio >= highTurnoverToLiquidityRatio && flatTape) {
    score += 0.18;
    flags.push('turnover_without_followthrough');
  }

  if (freshLaunch && strongFlow && holderCount > 0 && holderCount <= lowHolderCountThreshold) {
    score += 0.14;
    flags.push('fresh_high_traffic_low_holders');
  }

  if (input.isJitterBundle) {
    score += 0.18;
    flags.push('jitter_bundle_holder_shape');
  }

  if (top10Pct >= heavyTop10PctThreshold) {
    score += 0.12;
    flags.push('concentrated_holder_shape');
  }

  if (liquidityUsd > 0 && liquidityUsd <= blockLiquidityUsdCeiling && strongFlow) {
    score += 0.1;
    flags.push('thin_liquidity_amplifier');
  }

  if (momentum5mPct >= flatMomentum5mPct * 3 || momentum1mPct >= flatMomentum1mPct * 3) {
    score -= 0.18;
    flags.push('real_price_response_present');
  }

  if (holderCount >= lowHolderCountThreshold * 2 && top10Pct <= Math.max(10, heavyTop10PctThreshold * 0.7)) {
    score -= 0.08;
    flags.push('holder_distribution_supportive');
  }

  score = clamp01(score);

  const blockEligible =
    blockEntryModes.includes(entryMode) &&
    liquidityUsd > 0 &&
    liquidityUsd <= blockLiquidityUsdCeiling &&
    (holderCount <= blockHolderCountCeiling || Boolean(input.isJitterBundle) || top10Pct >= heavyTop10PctThreshold);

  const shouldBlock = score >= blockScore && blockEligible;
  const shouldWarn = !shouldBlock && score >= warnScore;
  const severity = shouldBlock ? 'block' : shouldWarn ? 'warn' : 'none';

  return {
    score,
    severity,
    shouldWarn,
    shouldBlock,
    cooldownSeconds: shouldBlock ? cooldownBlockSeconds : shouldWarn ? cooldownWarnSeconds : 0,
    flags,
    metrics: {
      entryMode,
      marketCapUsd: Math.max(0, toFiniteNumber(input.marketCapUsd, 0)),
      liquidityUsd,
      volume1hUsd,
      momentum5mPct,
      momentum1mPct,
      momentum1hPct: toFiniteNumber(input.momentum1hPct, 0),
      buys1h: Math.max(0, toFiniteNumber(input.buys1h, 0)),
      sells1h: Math.max(0, toFiniteNumber(input.sells1h, 0)),
      buyRatio: Math.max(0, toFiniteNumber(input.buyRatio, 0)),
      buys60s,
      sells60s,
      buyRatio60s,
      velocity,
      solVolume60s,
      holderCount,
      top10Pct,
      tokenAgeSec,
      turnoverToLiquidityRatio,
      priceResponsePerSol,
      flatTape,
      strongFlow,
      freshLaunch,
      blockEligible,
    },
  };
}

module.exports = {
  evaluateBundlerSuspicion,
};

export {};
