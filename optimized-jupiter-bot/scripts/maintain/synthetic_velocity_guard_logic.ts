function clampNumber(value: any, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function evaluateSyntheticVelocityGuard(input: {
  isSynthetic?: boolean;
  refinementOnly?: boolean;
  syntheticSource?: string;
  source?: string;
  buyRatio60s?: number;
  buys60s?: number;
  sells60s?: number;
  velocity?: number;
  solVolume60s?: number;
  momentum5m?: number;
  momentum1h?: number;
  liquidityUsd?: number;
  volume5mUsd?: number;
  bagsSignal?: boolean;
  walletExecutable?: boolean;
} = {}) {
  const syntheticSource = String(input.syntheticSource || '').toLowerCase();
  const source = String(input.source || '').toLowerCase();
  const isLaunchpadSynthetic =
    syntheticSource.includes('launchpad') ||
    source === 'onchain-launchpad';

  if (!input.isSynthetic || !isLaunchpadSynthetic) {
    if (!input.isSynthetic) {
      return { blocked: false, refinementOnly: false, code: null, reason: null, cooldownSeconds: 0 };
    }
    return {
      blocked: false,
      refinementOnly: true,
      code: 'synthetic_refinement_only',
      reason: 'synthetic composite flow requires terrain confirmation',
      cooldownSeconds: 8,
    };
  }

  if (input.bagsSignal || input.walletExecutable) {
    return {
      blocked: false,
      refinementOnly: true,
      code: 'synthetic_refinement_only',
      reason: 'synthetic launchpad flow still requires terrain confirmation',
      cooldownSeconds: 8,
    };
  }

  const buyRatio60s = clampNumber(input.buyRatio60s, 0.5, 0, 1);
  const buys60s = Math.max(0, Math.round(Number(input.buys60s || 0)));
  const sells60s = Math.max(0, Math.round(Number(input.sells60s || 0)));
  const velocity = Math.max(0, Math.round(Number(input.velocity || 0)));
  const solVolume60s = Math.max(0, Number(input.solVolume60s || 0));
  const momentum5m = Number(input.momentum5m || 0);
  const momentum1h = Number(input.momentum1h || 0);
  const liquidityUsd = Math.max(0, Number(input.liquidityUsd || 0));
  const volume5mUsd = Math.max(0, Number(input.volume5mUsd || 0));

  const balancedOrderflow = buyRatio60s <= 0.56 && Math.abs(buys60s - sells60s) <= 2;
  const placeholderVolume = solVolume60s >= 200;
  const highTxNoise = velocity >= 20;
  const weakPriceResponse = momentum5m < 4 && momentum1h < 20;
  const weakDexEvidence = liquidityUsd < 25_000 || volume5mUsd < 10_000;

  if (balancedOrderflow && placeholderVolume && highTxNoise && weakPriceResponse && weakDexEvidence) {
    return {
      blocked: true,
      refinementOnly: false,
      code: 'synthetic_launchpad_placeholder',
      reason: 'synthetic launchpad placeholder flow',
      cooldownSeconds: 45,
    };
  }

  return {
    blocked: false,
    refinementOnly: true,
    code: 'synthetic_refinement_only',
    reason: 'synthetic composite flow requires terrain confirmation',
    cooldownSeconds: 8,
  };
}

export function evaluateSyntheticRefinementEntryGate(input: {
  syntheticRefinementOnly?: boolean;
  syntheticSource?: string | null;
  liquidityUsd?: number | null;
  routeLive?: boolean | null;
  momentum5m?: number | null;
  terrainSummary?: {
    sampleCount?: number | null;
    strongFlowSamples?: number | null;
    priceDelta5m?: number | null;
    liquidityDeltaUsd?: number | null;
    routeStrengthPct?: number | null;
    flatPriceResponse?: boolean | null;
  } | null;
}, terrainConfig: {
  minSamplesForDecision?: number;
  minSamplesForBlock?: number;
  minStrongFlowSamples?: number;
  flatPrice5mPct?: number;
  minRouteStrengthPct?: number;
  cooldownConfirmSeconds?: number;
  cooldownBlockSeconds?: number;
} = {}) {
  if (!input.syntheticRefinementOnly) {
    return { shouldHold: false, shouldBlock: false, code: null, reason: null, cooldownSeconds: 0 };
  }

  const summary = input.terrainSummary || {};
  const minSamplesForDecision = Math.max(2, Math.round(Number(terrainConfig.minSamplesForDecision || 2)));
  const minSamplesForBlock = Math.max(minSamplesForDecision, Math.round(Number(terrainConfig.minSamplesForBlock || minSamplesForDecision)));
  const minStrongFlowSamples = Math.max(1, Math.round(Number(terrainConfig.minStrongFlowSamples || 1)));
  const flatPrice5mPct = clampNumber(terrainConfig.flatPrice5mPct, 2, 0.5, 20);
  const minRouteStrengthPct = clampNumber(terrainConfig.minRouteStrengthPct, 3, 0, 50);
  const cooldownConfirmSeconds = Math.max(5, Math.round(Number(terrainConfig.cooldownConfirmSeconds || 8)));
  const cooldownBlockSeconds = Math.max(cooldownConfirmSeconds, Math.round(Number(terrainConfig.cooldownBlockSeconds || 30)));
  const sampleCount = Math.max(0, Math.round(Number(summary.sampleCount || 0)));
  const strongFlowSamples = Math.max(0, Math.round(Number(summary.strongFlowSamples || 0)));
  const liquidityUsd = Math.max(0, Number(input.liquidityUsd || 0));
  const routeLive = input.routeLive === true;
  const priceDelta5m = Number(summary.priceDelta5m || 0);
  const liquidityDeltaUsd = Number(summary.liquidityDeltaUsd || 0);
  const routeStrengthPct = Number(summary.routeStrengthPct);
  const flatPriceResponse = summary.flatPriceResponse === true;
  const liveDexEvidence = liquidityUsd > 0 || routeLive;
  const inputMomentum5m = Number(input.momentum5m || 0);
  const priceResponding = Number(input.momentum5m || 0) >= flatPrice5mPct || priceDelta5m >= flatPrice5mPct;
  const structuralResponse =
    liquidityDeltaUsd > 0 ||
    (Number.isFinite(routeStrengthPct) && routeStrengthPct >= minRouteStrengthPct);
  const flatMomentumDespiteLiveEvidence =
    liveDexEvidence &&
    sampleCount >= minSamplesForDecision &&
    strongFlowSamples >= minStrongFlowSamples &&
    Math.abs(inputMomentum5m) <= 0.1 &&
    Math.abs(priceDelta5m) <= 0.1;

  if (!liveDexEvidence) {
    return {
      shouldHold: true,
      shouldBlock: false,
      code: 'synthetic_refinement_waiting_live_market',
      reason: 'synthetic candidate has not shown live market structure yet',
      cooldownSeconds: cooldownConfirmSeconds,
    };
  }

  if (sampleCount < minSamplesForDecision) {
    return {
      shouldHold: true,
      shouldBlock: false,
      code: 'synthetic_refinement_pending',
      reason: 'synthetic candidate is collecting rolling terrain samples',
      cooldownSeconds: cooldownConfirmSeconds,
    };
  }

  if (flatMomentumDespiteLiveEvidence) {
    return {
      shouldHold: true,
      shouldBlock: false,
      code: 'synthetic_refinement_flat_momentum',
      reason: 'synthetic candidate still shows flat momentum despite live market evidence',
      cooldownSeconds: Math.max(cooldownConfirmSeconds, Math.min(cooldownBlockSeconds, cooldownConfirmSeconds * 2)),
    };
  }

  if (sampleCount >= minSamplesForBlock && strongFlowSamples >= minStrongFlowSamples && flatPriceResponse && !structuralResponse && !priceResponding) {
    return {
      shouldHold: false,
      shouldBlock: true,
      code: 'synthetic_refinement_flat_response',
      reason: 'synthetic flow stayed flat through the rolling terrain window',
      cooldownSeconds: cooldownBlockSeconds,
    };
  }

  if (!priceResponding && !structuralResponse) {
    return {
      shouldHold: true,
      shouldBlock: false,
      code: 'synthetic_refinement_unconfirmed',
      reason: 'synthetic candidate still lacks real price or liquidity response',
      cooldownSeconds: cooldownConfirmSeconds,
    };
  }

  return { shouldHold: false, shouldBlock: false, code: null, reason: null, cooldownSeconds: 0 };
}

export function evaluateSyntheticLiveConfirmationGate(input: {
  syntheticRefinementOnly?: boolean;
  livePairPresent?: boolean | null;
  livePairExecutable?: boolean | null;
  routeLive?: boolean | null;
  cooldownPairSeconds?: number | null;
  cooldownRouteSeconds?: number | null;
} = {}) {
  if (!input.syntheticRefinementOnly) {
    return { confirmed: true, shouldHold: false, code: null, reason: null, cooldownSeconds: 0 };
  }

  const livePairPresent = input.livePairPresent === true;
  const livePairExecutable = input.livePairExecutable === true;
  const routeLive = input.routeLive === true;
  const cooldownPairSeconds = Math.max(5, Math.round(Number(input.cooldownPairSeconds || 10)));
  const cooldownRouteSeconds = Math.max(cooldownPairSeconds, Math.round(Number(input.cooldownRouteSeconds || 14)));

  if (livePairExecutable || routeLive) {
    return { confirmed: true, shouldHold: false, code: null, reason: null, cooldownSeconds: 0 };
  }

  if (!livePairPresent) {
    return {
      confirmed: false,
      shouldHold: true,
      code: 'synthetic_refinement_waiting_live_pair',
      reason: 'rolling terrain looks constructive but no live pair is indexed yet',
      cooldownSeconds: cooldownPairSeconds,
    };
  }

  return {
    confirmed: false,
    shouldHold: true,
    code: 'synthetic_refinement_waiting_live_route',
    reason: 'live pair exists but still lacks executable route confirmation',
    cooldownSeconds: cooldownRouteSeconds,
  };
}

module.exports = {
  evaluateSyntheticVelocityGuard,
  evaluateSyntheticRefinementEntryGate,
  evaluateSyntheticLiveConfirmationGate,
};
