type MaybeNumber = number | null | undefined;

export interface ShadowLaneConfig {
  enabled: boolean;
  holdCooldownSeconds: number;
  buyRatioHoldThresholdScale: number;
  weakMomentumHoldFloorPct: number;
  minStrongFlowBuys60s: number;
  minStrongFlowSolVolume60s: number;
  minStrongFlowVelocity: number;
  weakMomentumMinStrongFlowBuys60s: number;
  weakMomentumMinStrongFlowSolVolume60s: number;
  weakMomentumMinStrongFlowVelocity: number;
  minSamplesForDecision: number;
  maxAssessmentSpanSeconds: number;
  minPriceDelta5mForRecheck: number;
  minCurrentPrice5mPctForRecheck: number;
  minBuyRatio60sForRecheck: number;
  minFlowDecayRatioForRecheck: number;
}

export interface ShadowLaneDecision {
  shouldHold: boolean;
  cooldownSeconds: number;
  code: string | null;
  reason: string | null;
}

export interface TerrainSummaryLike {
  sampleCount?: MaybeNumber;
  spanMs?: MaybeNumber;
  currentPriceChange5m?: MaybeNumber;
  priceDelta5m?: MaybeNumber;
  flowDecayRatio?: MaybeNumber;
}

export interface ShadowBuyRatioInput {
  buyRatio?: MaybeNumber;
  reqRatio?: MaybeNumber;
  buys60s?: MaybeNumber;
  buyRatio60s?: MaybeNumber;
  velocity?: MaybeNumber;
  solVolume60s?: MaybeNumber;
  terrainSummary?: TerrainSummaryLike | null;
}

export interface ShadowWeakMomentumInput {
  momentum5m?: MaybeNumber;
  continuationApproved?: boolean | null;
  buys60s?: MaybeNumber;
  buyRatio60s?: MaybeNumber;
  velocity?: MaybeNumber;
  solVolume60s?: MaybeNumber;
  terrainSummary?: TerrainSummaryLike | null;
}

function finiteNumber(value: MaybeNumber, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function clampNumber(value: any, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function normalizeShadowLaneConfig(raw: any): ShadowLaneConfig {
  return {
    enabled: raw?.enabled !== false,
    holdCooldownSeconds: Math.round(clampNumber(raw?.holdCooldownSeconds, 8, 1, 60)),
    buyRatioHoldThresholdScale: clampNumber(raw?.buyRatioHoldThresholdScale, 0.85, 0.5, 0.99),
    weakMomentumHoldFloorPct: clampNumber(raw?.weakMomentumHoldFloorPct, -5, -50, 0),
    minStrongFlowBuys60s: Math.round(clampNumber(raw?.minStrongFlowBuys60s, 8, 1, 500)),
    minStrongFlowSolVolume60s: clampNumber(raw?.minStrongFlowSolVolume60s, 1.5, 0.1, 100),
    minStrongFlowVelocity: clampNumber(raw?.minStrongFlowVelocity, 8, 1, 500),
    weakMomentumMinStrongFlowBuys60s: Math.round(
      clampNumber(raw?.weakMomentumMinStrongFlowBuys60s, 5, 1, 500),
    ),
    weakMomentumMinStrongFlowSolVolume60s: clampNumber(
      raw?.weakMomentumMinStrongFlowSolVolume60s,
      1,
      0.1,
      100,
    ),
    weakMomentumMinStrongFlowVelocity: clampNumber(raw?.weakMomentumMinStrongFlowVelocity, 5, 1, 500),
    minSamplesForDecision: Math.round(clampNumber(raw?.minSamplesForDecision, 2, 1, 8)),
    maxAssessmentSpanSeconds: Math.round(clampNumber(raw?.maxAssessmentSpanSeconds, 30, 5, 300)),
    minPriceDelta5mForRecheck: clampNumber(raw?.minPriceDelta5mForRecheck, 2, 0, 100),
    minCurrentPrice5mPctForRecheck: clampNumber(raw?.minCurrentPrice5mPctForRecheck, 0.5, -10, 100),
    minBuyRatio60sForRecheck: clampNumber(raw?.minBuyRatio60sForRecheck, 0.78, 0.5, 0.99),
    minFlowDecayRatioForRecheck: clampNumber(raw?.minFlowDecayRatioForRecheck, 0.7, 0.1, 1),
  };
}

function hasStrongFlow(
  input: Pick<ShadowBuyRatioInput, 'buys60s' | 'velocity' | 'solVolume60s'>,
  thresholds: Pick<
    ShadowLaneConfig,
    'minStrongFlowBuys60s' | 'minStrongFlowSolVolume60s' | 'minStrongFlowVelocity'
  >,
): boolean {
  return (
    finiteNumber(input.buys60s, 0) >= thresholds.minStrongFlowBuys60s &&
    finiteNumber(input.solVolume60s, 0) >= thresholds.minStrongFlowSolVolume60s &&
    finiteNumber(input.velocity, 0) >= thresholds.minStrongFlowVelocity
  );
}

function isAssessmentWindowOpen(summary: TerrainSummaryLike | null | undefined, config: ShadowLaneConfig): boolean {
  return finiteNumber(summary?.spanMs, 0) <= config.maxAssessmentSpanSeconds * 1000;
}

function hasPositiveRecheckShape(
  summary: TerrainSummaryLike | null | undefined,
  config: ShadowLaneConfig,
): boolean {
  return (
    finiteNumber(summary?.currentPriceChange5m, 0) >= config.minCurrentPrice5mPctForRecheck ||
    finiteNumber(summary?.priceDelta5m, 0) >= config.minPriceDelta5mForRecheck
  );
}

function hasHealthyFlowPersistence(summary: TerrainSummaryLike | null | undefined, config: ShadowLaneConfig): boolean {
  const flowDecayRatio = summary?.flowDecayRatio;
  return flowDecayRatio === null || flowDecayRatio === undefined || finiteNumber(flowDecayRatio, 0) >= config.minFlowDecayRatioForRecheck;
}

export function evaluateBuyRatioShadowLane(
  input: ShadowBuyRatioInput,
  config: ShadowLaneConfig,
): ShadowLaneDecision {
  if (!config.enabled) return { shouldHold: false, cooldownSeconds: 0, code: null, reason: null };
  if (
    !hasStrongFlow(input, {
      minStrongFlowBuys60s: config.minStrongFlowBuys60s,
      minStrongFlowSolVolume60s: config.minStrongFlowSolVolume60s,
      minStrongFlowVelocity: config.minStrongFlowVelocity,
    })
  ) {
    return { shouldHold: false, cooldownSeconds: 0, code: null, reason: null };
  }

  const reqRatio = finiteNumber(input.reqRatio, 0);
  const buyRatio = finiteNumber(input.buyRatio, 0);
  if (reqRatio <= 0 || buyRatio >= reqRatio) return { shouldHold: false, cooldownSeconds: 0, code: null, reason: null };
  if (buyRatio < reqRatio * config.buyRatioHoldThresholdScale) {
    return { shouldHold: false, cooldownSeconds: 0, code: null, reason: null };
  }

  const summary = input.terrainSummary;
  if (!isAssessmentWindowOpen(summary, config)) {
    return { shouldHold: false, cooldownSeconds: 0, code: null, reason: null };
  }

  if (finiteNumber(summary?.sampleCount, 0) < config.minSamplesForDecision) {
    return {
      shouldHold: true,
      cooldownSeconds: config.holdCooldownSeconds,
      code: 'shadow_buy_ratio_hold',
      reason: 'near-threshold buy pressure still has strong live flow and needs one more sample',
    };
  }

  if (
    hasPositiveRecheckShape(summary, config) &&
    hasHealthyFlowPersistence(summary, config) &&
    finiteNumber(input.buyRatio60s, 0) >= config.minBuyRatio60sForRecheck
  ) {
    return {
      shouldHold: true,
      cooldownSeconds: config.holdCooldownSeconds,
      code: 'shadow_buy_ratio_hold',
      reason: 'buy pressure is still just under the floor, but price response and live flow are improving',
    };
  }

  return { shouldHold: false, cooldownSeconds: 0, code: null, reason: null };
}

export function evaluateWeakMomentumShadowLane(
  input: ShadowWeakMomentumInput,
  config: ShadowLaneConfig,
): ShadowLaneDecision {
  if (!config.enabled) return { shouldHold: false, cooldownSeconds: 0, code: null, reason: null };
  if (input.continuationApproved === true) return { shouldHold: false, cooldownSeconds: 0, code: null, reason: null };
  if (
    !hasStrongFlow(input, {
      minStrongFlowBuys60s: config.weakMomentumMinStrongFlowBuys60s,
      minStrongFlowSolVolume60s: config.weakMomentumMinStrongFlowSolVolume60s,
      minStrongFlowVelocity: config.weakMomentumMinStrongFlowVelocity,
    })
  ) {
    return { shouldHold: false, cooldownSeconds: 0, code: null, reason: null };
  }

  const momentum5m = finiteNumber(input.momentum5m, 0);
  if (momentum5m < config.weakMomentumHoldFloorPct || momentum5m >= 1) {
    return { shouldHold: false, cooldownSeconds: 0, code: null, reason: null };
  }

  const summary = input.terrainSummary;
  if (!isAssessmentWindowOpen(summary, config)) {
    return { shouldHold: false, cooldownSeconds: 0, code: null, reason: null };
  }

  if (finiteNumber(summary?.sampleCount, 0) < config.minSamplesForDecision) {
    return {
      shouldHold: true,
      cooldownSeconds: config.holdCooldownSeconds,
      code: 'shadow_weak_momentum_hold',
      reason: 'flow is strong but short-horizon price response is still shallow; waiting for one more sample',
    };
  }

  if (hasPositiveRecheckShape(summary, config) && hasHealthyFlowPersistence(summary, config)) {
    return {
      shouldHold: true,
      cooldownSeconds: config.holdCooldownSeconds,
      code: 'shadow_weak_momentum_hold',
      reason: 'momentum is still below the entry floor, but recent samples show improving response',
    };
  }

  return { shouldHold: false, cooldownSeconds: 0, code: null, reason: null };
}
