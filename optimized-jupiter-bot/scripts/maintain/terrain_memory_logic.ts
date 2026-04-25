export interface TerrainObservation {
  ts: number;
  symbol?: string;
  entryMode?: string;
  sourceLane?: string;
  priceChange5m?: number | null;
  priceChange1h?: number | null;
  liquidityUsd?: number | null;
  marketCapUsd?: number | null;
  fdvUsd?: number | null;
  volume1hUsd?: number | null;
  buys60s?: number | null;
  sells60s?: number | null;
  buyRatio60s?: number | null;
  velocity?: number | null;
  solVolume60s?: number | null;
  routeLive?: boolean | null;
  routeOutAmount?: number | null;
}

export interface TerrainSummary {
  sampleCount: number;
  spanMs: number;
  strongFlowSamples: number;
  routeLiveSamples: number;
  avgBuys60s: number;
  avgSolVolume60s: number;
  avgVelocity: number;
  peakBuys60s: number;
  peakSolVolume60s: number;
  peakVelocity: number;
  currentBuys60s: number;
  currentSolVolume60s: number;
  currentVelocity: number;
  currentPriceChange5m: number;
  maxPriceChange5m: number;
  minPriceChange5m: number;
  priceDelta5m: number;
  priceOffPeak5m: number;
  flowDecayRatio: number | null;
  liquidityDeltaUsd: number;
  routeStrengthPct: number | null;
  flatPriceResponse: boolean;
}

export interface TerrainState {
  samples: TerrainObservation[];
  updatedAt: number;
  lastSymbol?: string;
  summary: TerrainSummary;
}

export interface TerrainMemoryConfig {
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

export interface TerrainGuardResult {
  shouldHold: boolean;
  shouldWarn: boolean;
  shouldBlock: boolean;
  cooldownSeconds: number;
  code: string | null;
  reason: string | null;
}

export interface TerrainPreflightGuardResult {
  shouldHold: boolean;
  shouldAllow: boolean;
  cooldownSeconds: number;
  code: string | null;
  reason: string | null;
}

function finiteNumber(value: any, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ratioToPeak(currentValue: number, peakValue: number): number | null {
  if (!Number.isFinite(currentValue) || !Number.isFinite(peakValue) || peakValue <= 0) {
    return null;
  }
  return Math.max(0, Math.min(1, currentValue / peakValue));
}

function isStrongFlowTerrainSample(
  sample: Pick<TerrainObservation, 'buys60s' | 'solVolume60s' | 'velocity' | 'routeLive'>,
  config: TerrainMemoryConfig,
): boolean {
  const buys60s = finiteNumber(sample.buys60s, 0);
  const solVolume60s = finiteNumber(sample.solVolume60s, 0);
  const velocity = finiteNumber(sample.velocity, 0);
  const relaxedRouteFlowBuysFloor = Math.max(1, config.minStrongFlowBuys60s - 2);
  const meetsBaseFlow =
    solVolume60s >= config.minStrongFlowSolVolume60s &&
    velocity >= config.minStrongFlowVelocity;
  if (!meetsBaseFlow) return false;
  if (buys60s >= config.minStrongFlowBuys60s) return true;
  return sample.routeLive === true && buys60s >= relaxedRouteFlowBuysFloor;
}

function summarizeTerrain(samples: TerrainObservation[], config: TerrainMemoryConfig): TerrainSummary {
  if (!samples.length) {
    return {
      sampleCount: 0,
      spanMs: 0,
      strongFlowSamples: 0,
      routeLiveSamples: 0,
      avgBuys60s: 0,
      avgSolVolume60s: 0,
      avgVelocity: 0,
      peakBuys60s: 0,
      peakSolVolume60s: 0,
      peakVelocity: 0,
      currentBuys60s: 0,
      currentSolVolume60s: 0,
      currentVelocity: 0,
      currentPriceChange5m: 0,
      maxPriceChange5m: 0,
      minPriceChange5m: 0,
      priceDelta5m: 0,
      priceOffPeak5m: 0,
      flowDecayRatio: null,
      liquidityDeltaUsd: 0,
      routeStrengthPct: null,
      flatPriceResponse: false,
    };
  }

  const first = samples[0];
  const last = samples[samples.length - 1];
  const priceSeries = samples.map(sample => finiteNumber(sample.priceChange5m, 0));
  const liquiditySeries = samples.map(sample => finiteNumber(sample.liquidityUsd, 0));
  const buysSeries = samples.map(sample => finiteNumber(sample.buys60s, 0));
  const solSeries = samples.map(sample => finiteNumber(sample.solVolume60s, 0));
  const velocitySeries = samples.map(sample => finiteNumber(sample.velocity, 0));
  const routeSamples = samples.filter(sample => sample.routeLive === true && Number.isFinite(sample.routeOutAmount));
  const strongFlowSamples = samples.filter(sample => isStrongFlowTerrainSample(sample, config)).length;

  const routeStrengthPct =
    routeSamples.length >= 2 && finiteNumber(routeSamples[0].routeOutAmount, 0) > 0
      ? ((finiteNumber(routeSamples[0].routeOutAmount, 0) - finiteNumber(routeSamples[routeSamples.length - 1].routeOutAmount, 0)) /
          finiteNumber(routeSamples[0].routeOutAmount, 0)) * 100
      : null;

  const peakBuys60s = Math.max(...buysSeries);
  const peakSolVolume60s = Math.max(...solSeries);
  const peakVelocity = Math.max(...velocitySeries);
  const currentBuys60s = finiteNumber(last.buys60s, 0);
  const currentSolVolume60s = finiteNumber(last.solVolume60s, 0);
  const currentVelocity = finiteNumber(last.velocity, 0);
  const currentPriceChange5m = finiteNumber(last.priceChange5m, 0);
  const maxPriceChange5m = Math.max(...priceSeries);
  const minPriceChange5m = Math.min(...priceSeries);
  const priceDelta5m = currentPriceChange5m - finiteNumber(first.priceChange5m, 0);
  const priceOffPeak5m = Math.max(0, maxPriceChange5m - currentPriceChange5m);
  const flowDecayRatios = [
    ratioToPeak(currentBuys60s, peakBuys60s),
    ratioToPeak(currentSolVolume60s, peakSolVolume60s),
    ratioToPeak(currentVelocity, peakVelocity),
  ].filter((value): value is number => Number.isFinite(value));
  const flowDecayRatio = flowDecayRatios.length ? average(flowDecayRatios) : null;
  const flatPriceResponse = routeStrengthPct !== null
    ? routeStrengthPct < config.minRouteStrengthPct
    : maxPriceChange5m < config.flatPrice5mPct && Math.abs(priceDelta5m) < config.flatPrice5mPct;

  return {
    sampleCount: samples.length,
    spanMs: Math.max(0, finiteNumber(last.ts, 0) - finiteNumber(first.ts, 0)),
    strongFlowSamples,
    routeLiveSamples: routeSamples.length,
    avgBuys60s: average(buysSeries),
    avgSolVolume60s: average(solSeries),
    avgVelocity: average(velocitySeries),
    peakBuys60s,
    peakSolVolume60s,
    peakVelocity,
    currentBuys60s,
    currentSolVolume60s,
    currentVelocity,
    currentPriceChange5m,
    maxPriceChange5m,
    minPriceChange5m,
    priceDelta5m,
    priceOffPeak5m,
    flowDecayRatio,
    liquidityDeltaUsd: finiteNumber(last.liquidityUsd, 0) - finiteNumber(first.liquidityUsd, 0),
    routeStrengthPct,
    flatPriceResponse,
  };
}

export function ingestTerrainObservation(
  previousState: TerrainState | null | undefined,
  observation: TerrainObservation,
  config: TerrainMemoryConfig,
): TerrainState {
  const now = finiteNumber(observation.ts, Date.now());
  const lookbackMs = Math.max(1_000, finiteNumber(config.lookbackSeconds, 180) * 1000);
  const existingSamples = Array.isArray(previousState?.samples) ? previousState!.samples : [];
  const samples = [...existingSamples, observation]
    .filter(sample => now - finiteNumber(sample.ts, 0) <= lookbackMs)
    .slice(-12);

  return {
    samples,
    updatedAt: now,
    lastSymbol: observation.symbol || previousState?.lastSymbol,
    summary: summarizeTerrain(samples, config),
  };
}

export function evaluateTerrainGuard(
  state: TerrainState | null | undefined,
  candidate: {
    entryMode?: string;
    probeLike?: boolean | null;
    liquidityUsd?: number | null;
    routeLive?: boolean | null;
  },
  config: TerrainMemoryConfig,
): TerrainGuardResult {
  if (!config.enabled || !state?.summary) {
    return { shouldHold: false, shouldWarn: false, shouldBlock: false, cooldownSeconds: 0, code: null, reason: null };
  }

  const summary = state.summary;
  const liquidityUsd = finiteNumber(candidate.liquidityUsd, 0);
  const routeLive = candidate.routeLive === true;
  const isProbeLike = candidate.probeLike === true || candidate.entryMode === 'micro-scout';

  if (
    isProbeLike &&
    routeLive &&
    liquidityUsd <= config.maxLiquidityUsdForDecisionHold &&
    summary.sampleCount < config.minSamplesForDecision
  ) {
    return {
      shouldHold: true,
      shouldWarn: false,
      shouldBlock: false,
      cooldownSeconds: config.cooldownConfirmSeconds,
      code: 'terrain_confirmation_pending',
      reason: 'collecting multi-sample terrain confirmation',
    };
  }

  const structuralRecovery =
    (Number.isFinite(summary.routeStrengthPct) && Number(summary.routeStrengthPct) >= config.minRouteStrengthPctToIgnoreFlowDecay) ||
    summary.liquidityDeltaUsd >= config.minLiquidityDeltaUsdToIgnoreFlowDecay;
  const hasFlowDecayRisk =
    isProbeLike &&
    routeLive &&
    summary.sampleCount >= config.minSamplesForFlowDecayDecision &&
    summary.strongFlowSamples >= config.minStrongFlowSamples &&
    Number.isFinite(summary.flowDecayRatio) &&
    Number(summary.flowDecayRatio) <= config.maxFlowDecayRatioForHold &&
    summary.priceOffPeak5m >= config.minPriceOffPeak5mPctForHold &&
    !structuralRecovery;

  if (hasFlowDecayRisk) {
    if (
      summary.sampleCount >= config.minSamplesForBlock &&
      Number(summary.flowDecayRatio) <= config.maxFlowDecayRatioForBlock &&
      summary.priceOffPeak5m >= config.minPriceOffPeak5mPctForBlock
    ) {
      return {
        shouldHold: false,
        shouldWarn: false,
        shouldBlock: true,
        cooldownSeconds: config.cooldownBlockSeconds,
        code: 'terrain_flow_decay_blocked',
        reason: 'traffic has decayed from its recent peak and price is already off the high',
      };
    }
    return {
      shouldHold: true,
      shouldWarn: false,
      shouldBlock: false,
      cooldownSeconds: config.cooldownConfirmSeconds,
      code: 'terrain_flow_decay_hold',
      reason: 'flow is fading from the local peak before entry confirmation',
    };
  }

  const strongEnough =
    summary.strongFlowSamples >= config.minStrongFlowSamples &&
    summary.sampleCount >= config.minSamplesForWarn;

  if (!strongEnough || !summary.flatPriceResponse) {
    return { shouldHold: false, shouldWarn: false, shouldBlock: false, cooldownSeconds: 0, code: null, reason: null };
  }

  if (
    summary.sampleCount >= config.minSamplesForBlock &&
    (summary.routeLiveSamples >= config.minStrongFlowSamples || summary.liquidityDeltaUsd <= 0)
  ) {
    return {
      shouldHold: false,
      shouldWarn: false,
      shouldBlock: true,
      cooldownSeconds: config.cooldownBlockSeconds,
      code: 'terrain_flat_response_blocked',
      reason: 'strong flow persisted without confirming price or liquidity response',
    };
  }

  return {
    shouldHold: false,
    shouldWarn: true,
    shouldBlock: false,
    cooldownSeconds: config.cooldownWarnSeconds,
    code: 'terrain_flat_response_warn',
    reason: 'flow is outrunning observed price response',
  };
}

export function evaluateTerrainPreflightGuard(
  state: TerrainState | null | undefined,
  candidate: {
    kind: 'live_dump' | 'overbought';
    priceChange5m?: number | null;
    buys60s?: number | null;
    solVolume60s?: number | null;
    velocity?: number | null;
    routeLive?: boolean | null;
    liquidityUsd?: number | null;
    overboughtBaseCeilingPct?: number | null;
  },
  config: TerrainMemoryConfig,
): TerrainPreflightGuardResult {
  if (!config.enabled || !state?.summary || candidate.routeLive !== true) {
    return { shouldHold: false, shouldAllow: false, cooldownSeconds: 0, code: null, reason: null };
  }

  const summary = state.summary;
  const liquidityUsd = finiteNumber(candidate.liquidityUsd, 0);
  const priceChange5m = finiteNumber(candidate.priceChange5m, 0);
  const strongFlowNow = isStrongFlowTerrainSample(candidate, config);
  if (!strongFlowNow || liquidityUsd > config.maxLiquidityUsdForPreflightHold) {
    return { shouldHold: false, shouldAllow: false, cooldownSeconds: 0, code: null, reason: null };
  }

  if (candidate.kind === 'live_dump') {
    if (priceChange5m >= -2 || priceChange5m < config.liveDumpHardFloorPct) {
      return { shouldHold: false, shouldAllow: false, cooldownSeconds: 0, code: null, reason: null };
    }
    if (summary.sampleCount < config.minSamplesForDecision) {
      return {
        shouldHold: true,
        shouldAllow: false,
        cooldownSeconds: config.cooldownConfirmSeconds,
        code: 'terrain_live_dump_confirmation_pending',
        reason: 'route-live dump snapshot needs confirmation',
      };
    }
    const routeImproving = Number.isFinite(summary.routeStrengthPct) && summary.routeStrengthPct >= config.minRouteStrengthPct;
    const priceRecovering = summary.priceDelta5m >= config.flatPrice5mPct;
    if (summary.strongFlowSamples >= config.minStrongFlowSamples && (routeImproving || priceRecovering)) {
      return {
        shouldHold: false,
        shouldAllow: true,
        cooldownSeconds: 0,
        code: 'terrain_live_dump_recovered',
        reason: 'terrain shows route or price recovery after early dump print',
      };
    }
    return { shouldHold: false, shouldAllow: false, cooldownSeconds: 0, code: null, reason: null };
  }

  const baseCeiling = finiteNumber(candidate.overboughtBaseCeilingPct, 0);
  const hardCeiling =
    candidate.routeLive === true && liquidityUsd <= config.maxLiquidityUsdForPreflightHold
      ? config.routeLiveOverboughtHardCeilingPct
      : config.overboughtHardCeilingPct;
  if (priceChange5m <= baseCeiling || priceChange5m > hardCeiling) {
    return { shouldHold: false, shouldAllow: false, cooldownSeconds: 0, code: null, reason: null };
  }
  if (summary.sampleCount < config.minSamplesForDecision) {
    return {
      shouldHold: true,
      shouldAllow: false,
      cooldownSeconds: config.cooldownConfirmSeconds,
      code: 'terrain_overbought_confirmation_pending',
      reason: 'route-live breakout needs a second terrain sample',
    };
  }
  const routeImproving = Number.isFinite(summary.routeStrengthPct) && summary.routeStrengthPct >= config.minRouteStrengthPct;
  const liquidityGrowing = summary.liquidityDeltaUsd > 0;
  const priceStillAdvancing = summary.priceDelta5m >= config.flatPrice5mPct;
  if (summary.strongFlowSamples >= config.minStrongFlowSamples && routeImproving && (liquidityGrowing || priceStillAdvancing)) {
    return {
      shouldHold: false,
      shouldAllow: true,
      cooldownSeconds: 0,
      code: 'terrain_overbought_sustained',
      reason: 'terrain confirms the breakout is still strengthening',
    };
  }
  return { shouldHold: false, shouldAllow: false, cooldownSeconds: 0, code: null, reason: null };
}
