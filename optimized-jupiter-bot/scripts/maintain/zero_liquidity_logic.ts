type ZeroLiquidityRecheckInput = {
  continuationApproved?: boolean;
  buys60s?: number | null;
  buyRatio60s?: number | null;
  velocity?: number | null;
  solVolume60s?: number | null;
  tokenAgeSec?: number | null;
  terrainSummary?: {
    sampleCount?: number | null;
    liquidityDeltaUsd?: number | null;
    routeStrengthPct?: number | null;
    priceDelta5m?: number | null;
  } | null;
};

type ZeroLiquidityRecheckPlan = {
  cooldownSec: number;
  fastRecheck: boolean;
};

export interface RouteLiveZeroLiquidityConfig {
  enabled: boolean;
  minSamplesForDecision: number;
  enableFastTrack: boolean;
  maxFastTrackSamples: number;
  maxFastTrackTokenAgeSec: number;
  minFastTrackBuyRatio60s: number;
  minFastTrackBuys60s: number;
  minFastTrackSolVolume60s: number;
  minFastTrackVelocity: number;
  minFastTrackPriceChange5mPct: number;
  maxFastTrackPriceChange5mPct: number;
  minFastTrackPriceChange1hPct: number;
  minPositivePriceDelta5mPct: number;
  minRouteStrengthPct: number;
  maxNegativePriceChange1hPct: number;
  minRecoveryPriceChange5mPct: number;
  minSamplesForPriceOnlyAllow: number;
  minLivePriceChange5mPctForPriceOnlyAllow: number;
  minSamplesForPriceResponseAllow: number;
  maxTokenAgeSecForPriceResponseAllow: number;
  minPriceChange1hPctForPriceResponseAllow: number;
  minPriceDelta5mPctForPriceResponseAllow: number;
  maxPriceOffPeak5mPctForPriceResponseAllow: number;
  minFlowDecayRatioForPriceResponseAllow: number;
  minBuyRatio60sForPriceResponseAllow: number;
  minBuys60sForPriceResponseAllow: number;
  minSolVolume60sForPriceResponseAllow: number;
  minVelocityForPriceResponseAllow: number;
  confirmationCooldownSec: number;
  stalledCooldownSec: number;
  repeatedCooldownSec: number;
}

type RouteLiveZeroLiquidityInput = {
  priceChange5m?: number | null;
  priceChange1h?: number | null;
  tokenAgeSec?: number | null;
  buys60s?: number | null;
  buyRatio60s?: number | null;
  velocity?: number | null;
  solVolume60s?: number | null;
  terrainSummary?: {
    sampleCount?: number | null;
    liquidityDeltaUsd?: number | null;
    routeStrengthPct?: number | null;
    priceDelta5m?: number | null;
    priceOffPeak5m?: number | null;
    flowDecayRatio?: number | null;
  } | null;
};

type RouteLiveZeroLiquidityDecision = {
  allowEntry: boolean;
  shouldHold: boolean;
  shouldBlock: boolean;
  cooldownSec: number;
  code: string | null;
  reason: string | null;
};

function finiteNumber(value: any, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function clampNumber(value: any, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function normalizeRouteLiveZeroLiquidityConfig(raw: any): RouteLiveZeroLiquidityConfig {
  return {
    enabled: raw?.enabled !== false,
    minSamplesForDecision: Math.round(clampNumber(raw?.minSamplesForDecision, 2, 1, 10)),
    enableFastTrack: raw?.enableFastTrack !== false,
    maxFastTrackSamples: Math.round(clampNumber(raw?.maxFastTrackSamples, 1, 1, 4)),
    maxFastTrackTokenAgeSec: Math.round(clampNumber(raw?.maxFastTrackTokenAgeSec, 20 * 60, 30, 6 * 60 * 60)),
    minFastTrackBuyRatio60s: clampNumber(raw?.minFastTrackBuyRatio60s, 0.95, 0.5, 1),
    minFastTrackBuys60s: Math.round(clampNumber(raw?.minFastTrackBuys60s, 10, 1, 200)),
    minFastTrackSolVolume60s: clampNumber(raw?.minFastTrackSolVolume60s, 5, 0.1, 500),
    minFastTrackVelocity: Math.round(clampNumber(raw?.minFastTrackVelocity, 10, 1, 500)),
    minFastTrackPriceChange5mPct: clampNumber(raw?.minFastTrackPriceChange5mPct, 35, 0, 500),
    maxFastTrackPriceChange5mPct: clampNumber(raw?.maxFastTrackPriceChange5mPct, 100, 1, 1000),
    minFastTrackPriceChange1hPct: clampNumber(raw?.minFastTrackPriceChange1hPct, -5, -99, 500),
    minPositivePriceDelta5mPct: clampNumber(raw?.minPositivePriceDelta5mPct, 2, 0, 50),
    minRouteStrengthPct: clampNumber(raw?.minRouteStrengthPct, 1.5, 0, 50),
    maxNegativePriceChange1hPct: clampNumber(raw?.maxNegativePriceChange1hPct, -15, -99, 0),
    minRecoveryPriceChange5mPct: clampNumber(raw?.minRecoveryPriceChange5mPct, 2, 0, 50),
    minSamplesForPriceOnlyAllow: Math.round(clampNumber(raw?.minSamplesForPriceOnlyAllow, 3, 1, 10)),
    minLivePriceChange5mPctForPriceOnlyAllow: clampNumber(raw?.minLivePriceChange5mPctForPriceOnlyAllow, 5, 0, 100),
    minSamplesForPriceResponseAllow: Math.round(clampNumber(raw?.minSamplesForPriceResponseAllow, 2, 1, 10)),
    maxTokenAgeSecForPriceResponseAllow: Math.round(clampNumber(raw?.maxTokenAgeSecForPriceResponseAllow, 30 * 60, 60, 6 * 60 * 60)),
    minPriceChange1hPctForPriceResponseAllow: clampNumber(raw?.minPriceChange1hPctForPriceResponseAllow, -25, -99, 500),
    minPriceDelta5mPctForPriceResponseAllow: clampNumber(raw?.minPriceDelta5mPctForPriceResponseAllow, 8, 0, 100),
    maxPriceOffPeak5mPctForPriceResponseAllow: clampNumber(raw?.maxPriceOffPeak5mPctForPriceResponseAllow, 3, 0, 50),
    minFlowDecayRatioForPriceResponseAllow: clampNumber(raw?.minFlowDecayRatioForPriceResponseAllow, 0.7, 0, 2),
    minBuyRatio60sForPriceResponseAllow: clampNumber(raw?.minBuyRatio60sForPriceResponseAllow, 0.6, 0, 1),
    minBuys60sForPriceResponseAllow: Math.round(clampNumber(raw?.minBuys60sForPriceResponseAllow, 8, 1, 500)),
    minSolVolume60sForPriceResponseAllow: clampNumber(raw?.minSolVolume60sForPriceResponseAllow, 1.5, 0, 500),
    minVelocityForPriceResponseAllow: Math.round(clampNumber(raw?.minVelocityForPriceResponseAllow, 8, 1, 500)),
    confirmationCooldownSec: Math.round(clampNumber(raw?.confirmationCooldownSec, 6, 1, 120)),
    stalledCooldownSec: Math.round(clampNumber(raw?.stalledCooldownSec, 60, 5, 3600)),
    repeatedCooldownSec: Math.round(clampNumber(raw?.repeatedCooldownSec, 300, 10, 7200)),
  };
}

export function planZeroLiquidityRecheck(input: ZeroLiquidityRecheckInput): ZeroLiquidityRecheckPlan {
  const buys60s = finiteNumber(input.buys60s, 0);
  const buyRatio60s = finiteNumber(input.buyRatio60s, 0);
  const velocity = finiteNumber(input.velocity, 0);
  const solVolume60s = finiteNumber(input.solVolume60s, 0);
  const sampleCount = finiteNumber(input.terrainSummary?.sampleCount, 0);
  const liquidityDeltaUsd = finiteNumber(input.terrainSummary?.liquidityDeltaUsd, 0);
  const routeStrengthPct = finiteNumber(input.terrainSummary?.routeStrengthPct, 0);
  const priceDelta5m = finiteNumber(input.terrainSummary?.priceDelta5m, 0);
  const tokenAgeSec = finiteNumber(input.tokenAgeSec, 0);
  const hasFreshImprovement =
    liquidityDeltaUsd > 0 ||
    routeStrengthPct >= 1.5 ||
    priceDelta5m >= 2;

  const strongFlow =
    buyRatio60s >= 0.9 &&
    (
      (buys60s >= 12 && solVolume60s >= 2.0) ||
      (buys60s >= 9 && solVolume60s >= 3.5 && velocity >= 8) ||
      (!!input.continuationApproved && buys60s >= 8 && solVolume60s >= 1.5 && velocity >= 8)
    );

  if (!hasFreshImprovement && sampleCount >= 3) {
    return { cooldownSec: 300, fastRecheck: false };
  }

  if (!hasFreshImprovement && sampleCount >= 2) {
    return { cooldownSec: tokenAgeSec > 0 && tokenAgeSec <= 3600 ? 20 : 60, fastRecheck: false };
  }

  if (strongFlow) {
    return { cooldownSec: 10, fastRecheck: true };
  }

  const moderateFlow =
    buyRatio60s >= 0.8 &&
    buys60s >= 8 &&
    solVolume60s >= 1.0;

  if (moderateFlow) {
    return { cooldownSec: 20, fastRecheck: false };
  }

  return { cooldownSec: 45, fastRecheck: false };
}

export function evaluateRouteLiveZeroLiquidityEntry(
  input: RouteLiveZeroLiquidityInput,
  config: RouteLiveZeroLiquidityConfig,
): RouteLiveZeroLiquidityDecision {
  if (!config.enabled) {
    return { allowEntry: true, shouldHold: false, shouldBlock: false, cooldownSec: 0, code: null, reason: null };
  }

  const sampleCount = finiteNumber(input.terrainSummary?.sampleCount, 0);
  const liquidityDeltaUsd = finiteNumber(input.terrainSummary?.liquidityDeltaUsd, 0);
  const routeStrengthPct = finiteNumber(input.terrainSummary?.routeStrengthPct, 0);
  const summaryPriceDelta5m = finiteNumber(input.terrainSummary?.priceDelta5m, 0);
  const priceOffPeak5m = finiteNumber(input.terrainSummary?.priceOffPeak5m, Number.POSITIVE_INFINITY);
  const flowDecayRatio = finiteNumber(input.terrainSummary?.flowDecayRatio, Number.POSITIVE_INFINITY);
  const livePriceChange5m = finiteNumber(input.priceChange5m, 0);
  const livePriceChange1h = finiteNumber(input.priceChange1h, 0);
  const tokenAgeSec = finiteNumber(input.tokenAgeSec, 0);
  const buys60s = finiteNumber(input.buys60s, 0);
  const buyRatio60s = finiteNumber(input.buyRatio60s, 0);
  const velocity = finiteNumber(input.velocity, 0);
  const solVolume60s = finiteNumber(input.solVolume60s, 0);

  const liquidityGrowing = liquidityDeltaUsd > 0;
  const routeImproving = routeStrengthPct >= config.minRouteStrengthPct;
  const exceptionalFirstSampleFlow =
    buyRatio60s >= config.minFastTrackBuyRatio60s &&
    buys60s >= config.minFastTrackBuys60s &&
    solVolume60s >= config.minFastTrackSolVolume60s &&
    velocity >= config.minFastTrackVelocity;
  const fastTrackMomentumWindow =
    livePriceChange5m >= config.minFastTrackPriceChange5mPct &&
    livePriceChange5m <= config.maxFastTrackPriceChange5mPct;
  const fastTrackEligible =
    config.enableFastTrack &&
    sampleCount > 0 &&
    sampleCount <= config.maxFastTrackSamples &&
    tokenAgeSec > 0 &&
    tokenAgeSec <= config.maxFastTrackTokenAgeSec &&
    livePriceChange1h >= config.minFastTrackPriceChange1hPct &&
    exceptionalFirstSampleFlow &&
    fastTrackMomentumWindow;
  const priceOnlyRecovery =
    sampleCount >= config.minSamplesForPriceOnlyAllow &&
    summaryPriceDelta5m >= config.minPositivePriceDelta5mPct &&
    livePriceChange5m >= config.minLivePriceChange5mPctForPriceOnlyAllow;
  const priceResponseScalpAllow =
    sampleCount >= config.minSamplesForPriceResponseAllow &&
    (tokenAgeSec <= 0 || tokenAgeSec <= config.maxTokenAgeSecForPriceResponseAllow) &&
    livePriceChange1h >= config.minPriceChange1hPctForPriceResponseAllow &&
    summaryPriceDelta5m >= config.minPriceDelta5mPctForPriceResponseAllow &&
    livePriceChange5m >= Math.max(config.minLivePriceChange5mPctForPriceOnlyAllow, config.minRecoveryPriceChange5mPct) &&
    priceOffPeak5m <= config.maxPriceOffPeak5mPctForPriceResponseAllow &&
    (
      !Number.isFinite(flowDecayRatio) ||
      flowDecayRatio >= config.minFlowDecayRatioForPriceResponseAllow
    ) &&
    buyRatio60s >= config.minBuyRatio60sForPriceResponseAllow &&
    buys60s >= config.minBuys60sForPriceResponseAllow &&
    solVolume60s >= config.minSolVolume60sForPriceResponseAllow &&
    velocity >= config.minVelocityForPriceResponseAllow;
  const routeLiveNegativeTrend =
    livePriceChange1h <= config.maxNegativePriceChange1hPct &&
    livePriceChange5m < config.minRecoveryPriceChange5mPct &&
    !liquidityGrowing &&
    !routeImproving;

  if (liquidityGrowing || routeImproving) {
    return { allowEntry: true, shouldHold: false, shouldBlock: false, cooldownSec: 0, code: null, reason: null };
  }

  if (fastTrackEligible) {
    return {
      allowEntry: true,
      shouldHold: false,
      shouldBlock: false,
      cooldownSec: 0,
      code: 'route_live_zero_liq_fast_track',
      reason: 'exceptional first-sample route-live burst fits the validated scalp window',
    };
  }

  if (priceResponseScalpAllow) {
    return {
      allowEntry: true,
      shouldHold: false,
      shouldBlock: false,
      cooldownSec: 0,
      code: 'route_live_zero_liq_price_response',
      reason: 'route-live zero-liquidity price response stayed near peak across rolling terrain samples',
    };
  }

  if (routeLiveNegativeTrend) {
    return {
      allowEntry: false,
      shouldHold: false,
      shouldBlock: true,
      cooldownSec: sampleCount >= config.minSamplesForDecision ? config.repeatedCooldownSec : config.stalledCooldownSec,
      code: 'route_live_zero_liq_negative_trend',
      reason: 'route-live zero-liquidity flow is still negative and not recovering',
    };
  }

  if (priceOnlyRecovery) {
    return { allowEntry: true, shouldHold: false, shouldBlock: false, cooldownSec: 0, code: null, reason: null };
  }

  if (sampleCount < config.minSamplesForDecision) {
    return {
      allowEntry: false,
      shouldHold: true,
      shouldBlock: false,
      cooldownSec: config.confirmationCooldownSec,
      code: 'route_live_zero_liq_confirm',
      reason: 'route-live zero-liquidity snapshot needs confirmation',
    };
  }

  return {
    allowEntry: false,
    shouldHold: false,
    shouldBlock: true,
    cooldownSec: sampleCount >= config.minSamplesForDecision + 1 ? config.repeatedCooldownSec : config.stalledCooldownSec,
    code: 'route_live_zero_liq_stalled',
    reason: 'route-live zero-liquidity path is not improving',
  };
}
