const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateSyntheticVelocityGuard,
  evaluateSyntheticRefinementEntryGate,
  evaluateSyntheticLiveConfirmationGate,
} = require('./synthetic_velocity_guard_logic.ts');

test('evaluateSyntheticVelocityGuard blocks placeholder launchpad synthetic flow', () => {
  const result = evaluateSyntheticVelocityGuard({
    isSynthetic: true,
    syntheticSource: 'composite-onchain-launchpad',
    source: 'onchain-launchpad',
    buys60s: 12,
    sells60s: 12,
    buyRatio60s: 0.5,
    velocity: 24,
    solVolume60s: 250,
    momentum5m: 0,
    momentum1h: 0,
    liquidityUsd: 9_000,
    volume5mUsd: 3_000,
  });

  assert.equal(result.blocked, true);
  assert.equal(result.refinementOnly, false);
  assert.equal(result.code, 'synthetic_launchpad_placeholder');
  assert.equal(result.cooldownSeconds, 45);
});

test('evaluateSyntheticVelocityGuard keeps strong synthetic flow in refinement-only mode', () => {
  const result = evaluateSyntheticVelocityGuard({
    isSynthetic: true,
    syntheticSource: 'composite-onchain-launchpad',
    source: 'onchain-launchpad',
    buys60s: 18,
    sells60s: 4,
    buyRatio60s: 0.82,
    velocity: 22,
    solVolume60s: 12,
    momentum5m: 12,
    momentum1h: 44,
    liquidityUsd: 32_000,
    volume5mUsd: 18_000,
  });

  assert.equal(result.blocked, false);
  assert.equal(result.refinementOnly, true);
  assert.equal(result.code, 'synthetic_refinement_only');
});

test('evaluateSyntheticRefinementEntryGate holds synthetic candidates until live market structure appears', () => {
  const result = evaluateSyntheticRefinementEntryGate({
    syntheticRefinementOnly: true,
    syntheticSource: 'composite-trending',
    liquidityUsd: 0,
    routeLive: false,
    momentum5m: 0,
    terrainSummary: { sampleCount: 1 },
  }, {
    minSamplesForDecision: 2,
    minSamplesForBlock: 3,
    minStrongFlowSamples: 2,
    flatPrice5mPct: 2,
    minRouteStrengthPct: 3,
    cooldownConfirmSeconds: 8,
    cooldownBlockSeconds: 30,
  });

  assert.equal(result.shouldHold, true);
  assert.equal(result.shouldBlock, false);
  assert.equal(result.code, 'synthetic_refinement_waiting_live_market');
});

test('evaluateSyntheticRefinementEntryGate blocks flat synthetic flow after rolling terrain window', () => {
  const result = evaluateSyntheticRefinementEntryGate({
    syntheticRefinementOnly: true,
    syntheticSource: 'composite-trending',
    liquidityUsd: 12_000,
    routeLive: false,
    momentum5m: 0.5,
    terrainSummary: {
      sampleCount: 3,
      strongFlowSamples: 2,
      priceDelta5m: 0.3,
      liquidityDeltaUsd: 0,
      routeStrengthPct: 0,
      flatPriceResponse: true,
    },
  }, {
    minSamplesForDecision: 2,
    minSamplesForBlock: 3,
    minStrongFlowSamples: 2,
    flatPrice5mPct: 2,
    minRouteStrengthPct: 3,
    cooldownConfirmSeconds: 8,
    cooldownBlockSeconds: 30,
  });

  assert.equal(result.shouldHold, false);
  assert.equal(result.shouldBlock, true);
  assert.equal(result.code, 'synthetic_refinement_flat_response');
});

test('evaluateSyntheticRefinementEntryGate allows synthetic candidates once terrain shows real response', () => {
  const result = evaluateSyntheticRefinementEntryGate({
    syntheticRefinementOnly: true,
    syntheticSource: 'composite-wallet',
    liquidityUsd: 18_000,
    routeLive: true,
    momentum5m: 3.5,
    terrainSummary: {
      sampleCount: 2,
      strongFlowSamples: 2,
      priceDelta5m: 2.4,
      liquidityDeltaUsd: 1_500,
      routeStrengthPct: 5,
      flatPriceResponse: false,
    },
  }, {
    minSamplesForDecision: 2,
    minSamplesForBlock: 3,
    minStrongFlowSamples: 2,
    flatPrice5mPct: 2,
    minRouteStrengthPct: 3,
    cooldownConfirmSeconds: 8,
    cooldownBlockSeconds: 30,
  });

  assert.equal(result.shouldHold, false);
  assert.equal(result.shouldBlock, false);
  assert.equal(result.code, null);
});

test('evaluateSyntheticRefinementEntryGate still holds without live route or liquidity even after samples', () => {
  const result = evaluateSyntheticRefinementEntryGate({
    syntheticRefinementOnly: true,
    syntheticSource: 'composite-trending',
    liquidityUsd: 0,
    routeLive: false,
    momentum5m: 3.2,
    terrainSummary: {
      sampleCount: 3,
      strongFlowSamples: 3,
      priceDelta5m: 3.2,
      liquidityDeltaUsd: 0,
      routeStrengthPct: 0,
      flatPriceResponse: false,
    },
  }, {
    minSamplesForDecision: 2,
    minSamplesForBlock: 3,
    minStrongFlowSamples: 2,
    flatPrice5mPct: 2,
    minRouteStrengthPct: 3,
    cooldownConfirmSeconds: 8,
    cooldownBlockSeconds: 30,
  });

  assert.equal(result.shouldHold, true);
  assert.equal(result.shouldBlock, false);
  assert.equal(result.code, 'synthetic_refinement_waiting_live_market');
});

test('evaluateSyntheticRefinementEntryGate holds flat synthetic momentum even when live evidence exists', () => {
  const result = evaluateSyntheticRefinementEntryGate({
    syntheticRefinementOnly: true,
    syntheticSource: 'composite-trending',
    liquidityUsd: 18_000,
    routeLive: false,
    momentum5m: 0,
    terrainSummary: {
      sampleCount: 3,
      strongFlowSamples: 2,
      priceDelta5m: 0,
      liquidityDeltaUsd: 1_200,
      routeStrengthPct: 4,
      flatPriceResponse: false,
    },
  }, {
    minSamplesForDecision: 2,
    minSamplesForBlock: 3,
    minStrongFlowSamples: 2,
    flatPrice5mPct: 2,
    minRouteStrengthPct: 3,
    cooldownConfirmSeconds: 8,
    cooldownBlockSeconds: 30,
  });

  assert.equal(result.shouldHold, true);
  assert.equal(result.shouldBlock, false);
  assert.equal(result.code, 'synthetic_refinement_flat_momentum');
  assert.equal(result.cooldownSeconds, 16);
});

test('evaluateSyntheticLiveConfirmationGate holds synthetic candidates until a live pair is indexed', () => {
  const result = evaluateSyntheticLiveConfirmationGate({
    syntheticRefinementOnly: true,
    livePairPresent: false,
    livePairExecutable: false,
    routeLive: false,
    cooldownPairSeconds: 9,
    cooldownRouteSeconds: 14,
  });

  assert.equal(result.confirmed, false);
  assert.equal(result.shouldHold, true);
  assert.equal(result.code, 'synthetic_refinement_waiting_live_pair');
  assert.equal(result.cooldownSeconds, 9);
});

test('evaluateSyntheticLiveConfirmationGate holds synthetic candidates until an indexed pair becomes routable', () => {
  const result = evaluateSyntheticLiveConfirmationGate({
    syntheticRefinementOnly: true,
    livePairPresent: true,
    livePairExecutable: false,
    routeLive: false,
    cooldownPairSeconds: 9,
    cooldownRouteSeconds: 14,
  });

  assert.equal(result.confirmed, false);
  assert.equal(result.shouldHold, true);
  assert.equal(result.code, 'synthetic_refinement_waiting_live_route');
  assert.equal(result.cooldownSeconds, 14);
});

test('evaluateSyntheticLiveConfirmationGate passes synthetic candidates once a real live route exists', () => {
  const result = evaluateSyntheticLiveConfirmationGate({
    syntheticRefinementOnly: true,
    livePairPresent: true,
    livePairExecutable: false,
    routeLive: true,
  });

  assert.equal(result.confirmed, true);
  assert.equal(result.shouldHold, false);
  assert.equal(result.code, null);
});
