type MaybeNumber = number | null | undefined;

function toFiniteNumber(value: MaybeNumber, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function clampNumber(value: MaybeNumber, fallback: number, min: number, max: number): number {
  const parsed = toFiniteNumber(value, fallback);
  return Math.min(max, Math.max(min, parsed));
}

export interface MicroScoutQualityConfig {
  enabled: boolean;
  minRouteStrengthPct: number;
  minSamplesForRouteStrengthPass: number;
  minRouteStrengthPctForMomentumPass: number;
  minSamplesForMomentumPass: number;
  minMomentum5mPct: number;
  maxMomentum5mPct: number;
  minRouteStrengthPctForHighMomentumPass: number;
  minSamplesForHighMomentumPass: number;
  minHighMomentum5mPct: number;
  maxHighMomentum5mPct: number;
  maxWeakRouteStrengthPctForHold: number;
  maxSamplesForWeakRouteHold: number;
  minWeakRouteMomentum5mPctForHold: number;
  maxWeakRouteMomentum5mPctForHold: number;
  minRouteStrengthPctForEarlyPriceProbePass: number;
  maxRouteStrengthPctForEarlyPriceProbePass: number;
  minSamplesForEarlyPriceProbePass: number;
  minMomentum5mPctForEarlyPriceProbePass: number;
  maxMomentum5mPctForEarlyPriceProbePass: number;
  minPriceDelta5mPctForEarlyPriceProbePass: number;
  maxPriceOffPeak5mPctForEarlyPriceProbePass: number;
  minPriceDelta5mPctForPass: number;
  maxPriceOffPeak5mPctForPass: number;
  minRouteStrengthPctForLatePass: number;
  minSamplesForLatePass: number;
  minStrongFlowSamplesForLatePass: number;
  minSamplesForLateDecision: number;
  minSamplesForUnknownRouteDecision: number;
  cooldownHoldSeconds: number;
  cooldownBlockSeconds: number;
}

export interface MicroScoutQualityDecision {
  allowEntry: boolean;
  shouldHold: boolean;
  shouldBlock: boolean;
  cooldownSeconds: number;
  code: string | null;
  reason: string | null;
}

export function normalizeMicroScoutQualityConfig(raw: any = {}): MicroScoutQualityConfig {
  return {
    enabled: raw.enabled !== false,
    minRouteStrengthPct: clampNumber(raw.minRouteStrengthPct, 35, 1, 100),
    minSamplesForRouteStrengthPass: Math.round(clampNumber(raw.minSamplesForRouteStrengthPass, 5, 1, 12)),
    minRouteStrengthPctForMomentumPass: clampNumber(raw.minRouteStrengthPctForMomentumPass, 10, 0, 100),
    minSamplesForMomentumPass: Math.round(clampNumber(raw.minSamplesForMomentumPass, 4, 1, 12)),
    minMomentum5mPct: clampNumber(raw.minMomentum5mPct, 50, 0, 500),
    maxMomentum5mPct: clampNumber(raw.maxMomentum5mPct, 105, 1, 1000),
    minRouteStrengthPctForHighMomentumPass: clampNumber(raw.minRouteStrengthPctForHighMomentumPass, 20, 0, 100),
    minSamplesForHighMomentumPass: Math.round(clampNumber(raw.minSamplesForHighMomentumPass, 8, 1, 20)),
    minHighMomentum5mPct: clampNumber(raw.minHighMomentum5mPct, 105, 0, 500),
    maxHighMomentum5mPct: clampNumber(raw.maxHighMomentum5mPct, 140, 1, 1000),
    maxWeakRouteStrengthPctForHold: clampNumber(raw.maxWeakRouteStrengthPctForHold, 5, 0, 100),
    maxSamplesForWeakRouteHold: Math.round(clampNumber(raw.maxSamplesForWeakRouteHold, 2, 1, 12)),
    minWeakRouteMomentum5mPctForHold: clampNumber(raw.minWeakRouteMomentum5mPctForHold, 40, 0, 500),
    maxWeakRouteMomentum5mPctForHold: clampNumber(raw.maxWeakRouteMomentum5mPctForHold, 95, 1, 1000),
    minRouteStrengthPctForEarlyPriceProbePass: clampNumber(raw.minRouteStrengthPctForEarlyPriceProbePass, 0, 0, 100),
    maxRouteStrengthPctForEarlyPriceProbePass: clampNumber(raw.maxRouteStrengthPctForEarlyPriceProbePass, 5, 0, 100),
    minSamplesForEarlyPriceProbePass: Math.round(clampNumber(raw.minSamplesForEarlyPriceProbePass, 4, 1, 12)),
    minMomentum5mPctForEarlyPriceProbePass: clampNumber(raw.minMomentum5mPctForEarlyPriceProbePass, 18, 0, 500),
    maxMomentum5mPctForEarlyPriceProbePass: clampNumber(raw.maxMomentum5mPctForEarlyPriceProbePass, 45, 1, 1000),
    minPriceDelta5mPctForEarlyPriceProbePass: clampNumber(raw.minPriceDelta5mPctForEarlyPriceProbePass, 10, -500, 500),
    maxPriceOffPeak5mPctForEarlyPriceProbePass: clampNumber(raw.maxPriceOffPeak5mPctForEarlyPriceProbePass, 4, 0, 500),
    minPriceDelta5mPctForPass: clampNumber(raw.minPriceDelta5mPctForPass, 0, -500, 500),
    maxPriceOffPeak5mPctForPass: clampNumber(raw.maxPriceOffPeak5mPctForPass, 18, 0, 500),
    minRouteStrengthPctForLatePass: clampNumber(raw.minRouteStrengthPctForLatePass, 45, 0, 100),
    minSamplesForLatePass: Math.round(clampNumber(raw.minSamplesForLatePass, 5, 1, 12)),
    minStrongFlowSamplesForLatePass: Math.round(clampNumber(raw.minStrongFlowSamplesForLatePass, 2, 0, 12)),
    minSamplesForLateDecision: Math.round(clampNumber(raw.minSamplesForLateDecision, 4, 1, 12)),
    minSamplesForUnknownRouteDecision: Math.round(clampNumber(raw.minSamplesForUnknownRouteDecision, 3, 1, 12)),
    cooldownHoldSeconds: Math.round(clampNumber(raw.cooldownHoldSeconds, 6, 1, 300)),
    cooldownBlockSeconds: Math.round(clampNumber(raw.cooldownBlockSeconds, 180, 5, 3600)),
  };
}

export function evaluateMicroScoutQualityGate(
  input: {
    entryMode?: string | null;
    probeLike?: boolean | null;
    fastTrackApproved?: boolean | null;
    momentum5mPct?: MaybeNumber;
    routeStrengthPct?: MaybeNumber;
    sampleCount?: MaybeNumber;
    priceDelta5mPct?: MaybeNumber;
    priceOffPeak5mPct?: MaybeNumber;
    strongFlowSamples?: MaybeNumber;
  },
  config: MicroScoutQualityConfig,
): MicroScoutQualityDecision {
  const isProbeLike = input.probeLike === true || input.entryMode === 'micro-scout';
  if (!config.enabled || !isProbeLike) {
    return { allowEntry: true, shouldHold: false, shouldBlock: false, cooldownSeconds: 0, code: null, reason: null };
  }

  if (input.fastTrackApproved === true) {
    return { allowEntry: true, shouldHold: false, shouldBlock: false, cooldownSeconds: 0, code: 'micro_scout_quality_fast_track', reason: null };
  }

  const momentum5mPct = toFiniteNumber(input.momentum5mPct, 0);
  const routeStrengthPct = Number.isFinite(input.routeStrengthPct) ? Number(input.routeStrengthPct) : null;
  const sampleCount = Math.max(0, Math.round(toFiniteNumber(input.sampleCount, 0)));
  const priceDelta5mPct = Number.isFinite(input.priceDelta5mPct) ? Number(input.priceDelta5mPct) : null;
  const priceOffPeak5mPct = Number.isFinite(input.priceOffPeak5mPct) ? Number(input.priceOffPeak5mPct) : null;
  const strongFlowSamples = Math.max(0, Math.round(toFiniteNumber(input.strongFlowSamples, 0)));

  const routeStrengthPass =
    routeStrengthPct !== null &&
    routeStrengthPct >= config.minRouteStrengthPct &&
    sampleCount >= config.minSamplesForRouteStrengthPass;

  const momentumWindowPass =
    routeStrengthPct !== null &&
    routeStrengthPct >= config.minRouteStrengthPctForMomentumPass &&
    sampleCount >= config.minSamplesForMomentumPass &&
    momentum5mPct >= config.minMomentum5mPct &&
    momentum5mPct <= config.maxMomentum5mPct;

  const highMomentumExtensionPass =
    routeStrengthPct !== null &&
    routeStrengthPct >= config.minRouteStrengthPctForHighMomentumPass &&
    sampleCount >= config.minSamplesForHighMomentumPass &&
    momentum5mPct >= config.minHighMomentum5mPct &&
    momentum5mPct <= config.maxHighMomentum5mPct;

  const earlyPriceResponseProbePass =
    routeStrengthPct !== null &&
    routeStrengthPct >= config.minRouteStrengthPctForEarlyPriceProbePass &&
    routeStrengthPct <= config.maxRouteStrengthPctForEarlyPriceProbePass &&
    sampleCount >= config.minSamplesForEarlyPriceProbePass &&
    momentum5mPct >= config.minMomentum5mPctForEarlyPriceProbePass &&
    momentum5mPct <= config.maxMomentum5mPctForEarlyPriceProbePass &&
    (priceDelta5mPct === null || priceDelta5mPct >= config.minPriceDelta5mPctForEarlyPriceProbePass) &&
    (priceOffPeak5mPct === null || priceOffPeak5mPct <= config.maxPriceOffPeak5mPctForEarlyPriceProbePass);

  const lateTerrain =
    (priceDelta5mPct !== null && priceDelta5mPct < config.minPriceDelta5mPctForPass) ||
    (priceOffPeak5mPct !== null && priceOffPeak5mPct > config.maxPriceOffPeak5mPctForPass);

  const lateTerrainRecoveryPass =
    lateTerrain &&
    routeStrengthPct !== null &&
    routeStrengthPct >= config.minRouteStrengthPctForLatePass &&
    sampleCount >= config.minSamplesForLatePass &&
    strongFlowSamples >= config.minStrongFlowSamplesForLatePass;

  if (lateTerrain) {
    if (lateTerrainRecoveryPass) {
      return { allowEntry: true, shouldHold: false, shouldBlock: false, cooldownSeconds: 0, code: null, reason: null };
    }

    if (sampleCount < config.minSamplesForLateDecision) {
      return {
        allowEntry: false,
        shouldHold: true,
        shouldBlock: false,
        cooldownSeconds: config.cooldownHoldSeconds,
        code: 'micro_scout_quality_wait',
        reason: 'price response has rolled off the peak; waiting for one more terrain confirmation',
      };
    }

    return {
      allowEntry: false,
      shouldHold: false,
      shouldBlock: true,
      cooldownSeconds: config.cooldownBlockSeconds,
      code: 'micro_scout_quality_late_entry',
      reason: 'traffic is no longer translating cleanly into price follow-through',
    };
  }

  if (routeStrengthPass || momentumWindowPass || highMomentumExtensionPass || earlyPriceResponseProbePass) {
    return { allowEntry: true, shouldHold: false, shouldBlock: false, cooldownSeconds: 0, code: null, reason: null };
  }

  if (routeStrengthPct === null && sampleCount < config.minSamplesForUnknownRouteDecision) {
    return {
      allowEntry: false,
      shouldHold: true,
      shouldBlock: false,
      cooldownSeconds: config.cooldownHoldSeconds,
      code: 'micro_scout_quality_wait',
      reason: 'micro probe needs more terrain samples before route quality is known',
    };
  }

  if (
    routeStrengthPct !== null &&
    routeStrengthPct >= config.minRouteStrengthPct &&
    sampleCount < config.minSamplesForRouteStrengthPass
  ) {
    return {
      allowEntry: false,
      shouldHold: true,
      shouldBlock: false,
      cooldownSeconds: config.cooldownHoldSeconds,
      code: 'micro_scout_quality_wait',
      reason: 'route strength looks promising but needs one more confirmation window',
    };
  }

  if (
    routeStrengthPct !== null &&
    routeStrengthPct >= config.minRouteStrengthPctForMomentumPass &&
    momentum5mPct >= config.minMomentum5mPct &&
    momentum5mPct <= config.maxMomentum5mPct &&
    sampleCount < config.minSamplesForMomentumPass
  ) {
    return {
      allowEntry: false,
      shouldHold: true,
      shouldBlock: false,
      cooldownSeconds: config.cooldownHoldSeconds,
      code: 'micro_scout_quality_wait',
      reason: 'momentum is in-range but terrain history is still too shallow',
    };
  }

  if (
    routeStrengthPct !== null &&
    routeStrengthPct >= 0 &&
    routeStrengthPct <= config.maxWeakRouteStrengthPctForHold &&
    sampleCount <= config.maxSamplesForWeakRouteHold &&
    momentum5mPct >= config.minWeakRouteMomentum5mPctForHold &&
    momentum5mPct <= config.maxWeakRouteMomentum5mPctForHold
  ) {
    return {
      allowEntry: false,
      shouldHold: true,
      shouldBlock: false,
      cooldownSeconds: config.cooldownHoldSeconds,
      code: 'micro_scout_quality_wait',
      reason: 'weak route quality still looks early; waiting for one more terrain sample',
    };
  }

  if (routeStrengthPct === null) {
    return {
      allowEntry: false,
      shouldHold: false,
      shouldBlock: true,
      cooldownSeconds: config.cooldownBlockSeconds,
      code: 'micro_scout_quality_route_unknown',
      reason: 'micro probe still lacks route-quality confirmation',
    };
  }

  if (routeStrengthPct < config.minRouteStrengthPctForMomentumPass) {
    return {
      allowEntry: false,
      shouldHold: false,
      shouldBlock: true,
      cooldownSeconds: config.cooldownBlockSeconds,
      code: 'micro_scout_quality_route_weak',
      reason: 'route strength is still too weak for a probe entry',
    };
  }

  return {
    allowEntry: false,
    shouldHold: false,
    shouldBlock: true,
    cooldownSeconds: config.cooldownBlockSeconds,
    code: 'micro_scout_quality_momentum',
    reason: `micro probe momentum ${momentum5mPct.toFixed(1)}% is outside the validated entry window`,
  };
}
