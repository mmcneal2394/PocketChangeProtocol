type MaybeNumber = number | null | undefined;

function toFiniteNumber(value: MaybeNumber, fallback = 0): number {
  const numeric = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(numeric) ? numeric : fallback;
}

interface TerrainSummaryLike {
  sampleCount?: MaybeNumber;
  strongFlowSamples?: MaybeNumber;
  priceDelta5m?: MaybeNumber;
  priceOffPeak5m?: MaybeNumber;
  routeStrengthPct?: MaybeNumber;
  currentPriceChange5m?: MaybeNumber;
}

interface RouteLiveEntryRefinementInput {
  microOnlyMode?: boolean;
  routeLive?: boolean;
  priceChange5m?: MaybeNumber;
  volume1hUsd?: MaybeNumber;
  buys60s?: MaybeNumber;
  buyRatio60s?: MaybeNumber;
  velocity?: MaybeNumber;
  solVolume60s?: MaybeNumber;
  terrainSummary?: TerrainSummaryLike | null;
}

interface RouteLiveEntryRefinementDecision {
  shouldBypassLowVolumeFloor: boolean;
  qualifierThresholdScale: number | null;
  reason: string | null;
}

interface FlatGmgnMissingMomentumInput {
  source?: string | null;
  momentum5m?: MaybeNumber;
  missingMomentum1m?: boolean;
  buys60s?: MaybeNumber;
  buyRatio60s?: MaybeNumber;
  velocity?: MaybeNumber;
  solVolume60s?: MaybeNumber;
}

interface FlatGmgnMissingMomentumDecision {
  shouldHold: boolean;
  cooldownSeconds: number;
  code: string | null;
  reason: string | null;
}

interface RouteLiveContinuationOverrideInput {
  routeLive?: boolean;
  missingMomentum1m?: boolean;
  priceChange5m?: MaybeNumber;
  buys60s?: MaybeNumber;
  buyRatio60s?: MaybeNumber;
  velocity?: MaybeNumber;
  solVolume60s?: MaybeNumber;
  terrainSummary?: TerrainSummaryLike | null;
}

interface RouteLiveContinuationOverrideDecision {
  allow: boolean;
  reason: string | null;
}

function evaluateRouteLiveEntryRefinement(
  input: RouteLiveEntryRefinementInput,
): RouteLiveEntryRefinementDecision {
  const microOnlyMode = Boolean(input.microOnlyMode);
  const routeLive = Boolean(input.routeLive);
  if (!microOnlyMode || !routeLive) {
    return {
      shouldBypassLowVolumeFloor: false,
      qualifierThresholdScale: null,
      reason: null,
    };
  }

  const buys60s = Math.max(0, toFiniteNumber(input.buys60s, 0));
  const buyRatio60s = Math.max(0, toFiniteNumber(input.buyRatio60s, 0));
  const velocity = Math.max(0, toFiniteNumber(input.velocity, 0));
  const solVolume60s = Math.max(0, toFiniteNumber(input.solVolume60s, 0));
  const volume1hUsd = Math.max(0, toFiniteNumber(input.volume1hUsd, 0));
  const terrainSummary = input.terrainSummary || {};
  const sampleCount = Math.max(0, toFiniteNumber(terrainSummary.sampleCount, 0));
  const strongFlowSamples = Math.max(0, toFiniteNumber(terrainSummary.strongFlowSamples, 0));
  const routeStrengthPct = Math.max(0, toFiniteNumber(terrainSummary.routeStrengthPct, 0));
  const terrainPriceDelta5m = toFiniteNumber(terrainSummary.priceDelta5m, 0);
  const priceChange5m = toFiniteNumber(
    terrainSummary.currentPriceChange5m,
    toFiniteNumber(input.priceChange5m, 0),
  );

  const strongRouteLiveFlow =
    buys60s >= 2 &&
    buyRatio60s >= 0.5 &&
    (solVolume60s >= 1 || velocity >= 4);
  const terrainConfirmed =
    sampleCount >= 2 &&
    (routeStrengthPct >= 1.5 || strongFlowSamples >= 1 || terrainPriceDelta5m >= 2);
  const earlyBreakout =
    priceChange5m >= 25 &&
    (solVolume60s >= 1 || velocity >= 4);

  if (!strongRouteLiveFlow || (!terrainConfirmed && !earlyBreakout)) {
    return {
      shouldBypassLowVolumeFloor: false,
      qualifierThresholdScale: null,
      reason: null,
    };
  }

  const veryStrongRouteLive =
    priceChange5m >= 15 &&
    (routeStrengthPct >= 5 || strongFlowSamples >= 1 || solVolume60s >= 1.5);

  return {
    shouldBypassLowVolumeFloor: volume1hUsd < 1000,
    qualifierThresholdScale: veryStrongRouteLive ? 0.22 : 0.3,
    reason: veryStrongRouteLive
      ? 'route-live breakout confirmation'
      : 'route-live terrain confirmation',
  };
}

function evaluateFlatGmgnMissingMomentumHold(
  input: FlatGmgnMissingMomentumInput,
): FlatGmgnMissingMomentumDecision {
  const source = String(input.source || '').toLowerCase();
  const isGmgnSource = source.includes('gmgn');
  const missingMomentum1m = Boolean(input.missingMomentum1m);
  const momentum5m = toFiniteNumber(input.momentum5m, 0);
  const buys60s = Math.max(0, toFiniteNumber(input.buys60s, 0));
  const buyRatio60s = Math.max(0, toFiniteNumber(input.buyRatio60s, 0));
  const velocity = Math.max(0, toFiniteNumber(input.velocity, 0));
  const solVolume60s = Math.max(0, toFiniteNumber(input.solVolume60s, 0));

  const flatTape = Math.abs(momentum5m) <= 0.5;
  const liveFlowStillPresent =
    buys60s >= 5 &&
    buyRatio60s >= 0.6 &&
    (solVolume60s >= 3 || velocity >= 8);

  if (!isGmgnSource || !missingMomentum1m || !flatTape || !liveFlowStillPresent) {
    return {
      shouldHold: false,
      cooldownSeconds: 0,
      code: null,
      reason: null,
    };
  }

  return {
    shouldHold: true,
    cooldownSeconds: 12,
    code: 'flat_gmgn_missing_momentum_hold',
    reason: 'flat gmgn tape still has live flow',
  };
}

function evaluateRouteLiveContinuationOverride(
  input: RouteLiveContinuationOverrideInput,
): RouteLiveContinuationOverrideDecision {
  const routeLive = Boolean(input.routeLive);
  const missingMomentum1m = Boolean(input.missingMomentum1m);
  if (!routeLive || !missingMomentum1m) {
    return { allow: false, reason: null };
  }

  const buys60s = Math.max(0, toFiniteNumber(input.buys60s, 0));
  const buyRatio60s = Math.max(0, toFiniteNumber(input.buyRatio60s, 0));
  const velocity = Math.max(0, toFiniteNumber(input.velocity, 0));
  const solVolume60s = Math.max(0, toFiniteNumber(input.solVolume60s, 0));
  const terrainSummary = input.terrainSummary || {};
  const sampleCount = Math.max(0, toFiniteNumber(terrainSummary.sampleCount, 0));
  const strongFlowSamples = Math.max(0, toFiniteNumber(terrainSummary.strongFlowSamples, 0));
  const routeStrengthPct = Math.max(0, toFiniteNumber(terrainSummary.routeStrengthPct, 0));
  const priceOffPeak5m = Math.max(0, toFiniteNumber(terrainSummary.priceOffPeak5m, 0));
  const priceChange5m = toFiniteNumber(
    terrainSummary.currentPriceChange5m,
    toFiniteNumber(input.priceChange5m, 0),
  );

  const strongLiveFlow =
    buys60s >= 8 &&
    buyRatio60s >= 0.72 &&
    (velocity >= 10 || solVolume60s >= 0.75);
  const routeConfirmed =
    routeStrengthPct >= 20 ||
    strongFlowSamples >= 1 ||
    sampleCount >= 2;
  const priceResponseConfirmed =
    priceChange5m >= 60 ||
    (priceChange5m >= 25 && priceOffPeak5m <= 2.5);
  const explosiveRawFlowConfirmed =
    buys60s >= 16 &&
    buyRatio60s >= 0.68 &&
    velocity >= 20 &&
    solVolume60s >= 8 &&
    sampleCount >= 2 &&
    priceOffPeak5m <= 3.5 &&
    (
      routeStrengthPct >= 5 ||
      strongFlowSamples >= 1 ||
      sampleCount >= 3
    );

  const continuationEnvelopeConfirmed = strongLiveFlow || explosiveRawFlowConfirmed;

  if (!continuationEnvelopeConfirmed || !routeConfirmed || (!priceResponseConfirmed && !explosiveRawFlowConfirmed)) {
    return { allow: false, reason: null };
  }

  return {
    allow: true,
    reason: routeStrengthPct >= 20
      ? 'route-live continuation override (strong route response)'
      : explosiveRawFlowConfirmed
        ? 'route-live continuation override (explosive raw flow still holding near peak)'
        : 'route-live continuation override (price response confirmed)',
  };
}

module.exports = {
  evaluateRouteLiveEntryRefinement,
  evaluateFlatGmgnMissingMomentumHold,
  evaluateRouteLiveContinuationOverride,
};

export {};
