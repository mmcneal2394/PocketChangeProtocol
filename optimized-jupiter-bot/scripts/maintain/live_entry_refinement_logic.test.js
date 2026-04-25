const test = require('node:test');
const assert = require('node:assert/strict');

const {
  evaluateRouteLiveEntryRefinement,
  evaluateFlatGmgnMissingMomentumHold,
  evaluateRouteLiveContinuationOverride,
} = require('./live_entry_refinement_logic.ts');

test('route-live refinement bypasses low volume and lowers qualifier threshold for strong micro-only breakout', () => {
  const decision = evaluateRouteLiveEntryRefinement({
    microOnlyMode: true,
    routeLive: true,
    priceChange5m: 34.6,
    volume1hUsd: 487,
    buys60s: 2,
    buyRatio60s: 0.5,
    velocity: 4,
    solVolume60s: 2.622,
    terrainSummary: {
      sampleCount: 2,
      strongFlowSamples: 1,
      routeStrengthPct: 6.2,
      priceDelta5m: 34.6,
      currentPriceChange5m: 34.6,
    },
  });

  assert.equal(decision.shouldBypassLowVolumeFloor, true);
  assert.equal(decision.qualifierThresholdScale, 0.22);
  assert.equal(decision.reason, 'route-live breakout confirmation');
});

test('route-live refinement stays off for weak flow even when route is live', () => {
  const decision = evaluateRouteLiveEntryRefinement({
    microOnlyMode: true,
    routeLive: true,
    priceChange5m: 4,
    volume1hUsd: 200,
    buys60s: 1,
    buyRatio60s: 0.4,
    velocity: 2,
    solVolume60s: 0.3,
    terrainSummary: {
      sampleCount: 1,
      strongFlowSamples: 0,
      routeStrengthPct: 0.5,
      priceDelta5m: 1,
      currentPriceChange5m: 4,
    },
  });

  assert.equal(decision.shouldBypassLowVolumeFloor, false);
  assert.equal(decision.qualifierThresholdScale, null);
  assert.equal(decision.reason, null);
});

test('flat gmgn hold rechecks strong live flow instead of 90 second skip', () => {
  const decision = evaluateFlatGmgnMissingMomentumHold({
    source: 'gmgn-bridge',
    momentum5m: 0,
    missingMomentum1m: true,
    buys60s: 6,
    buyRatio60s: 0.67,
    velocity: 9,
    solVolume60s: 9.4,
  });

  assert.equal(decision.shouldHold, true);
  assert.equal(decision.cooldownSeconds, 12);
  assert.equal(decision.code, 'flat_gmgn_missing_momentum_hold');
});

test('flat gmgn hold does not trigger for weak or non-gmgn flow', () => {
  const decision = evaluateFlatGmgnMissingMomentumHold({
    source: 'bags-swarm',
    momentum5m: 0,
    missingMomentum1m: true,
    buys60s: 6,
    buyRatio60s: 0.67,
    velocity: 9,
    solVolume60s: 9.4,
  });

  assert.equal(decision.shouldHold, false);
  assert.equal(decision.code, null);
});

test('route-live continuation override passes strong missing-1m route flow', () => {
  const decision = evaluateRouteLiveContinuationOverride({
    routeLive: true,
    missingMomentum1m: true,
    priceChange5m: 117,
    buys60s: 9,
    buyRatio60s: 0.75,
    velocity: 12,
    solVolume60s: 1.081,
    terrainSummary: {
      sampleCount: 2,
      strongFlowSamples: 1,
      routeStrengthPct: 24,
      priceOffPeak5m: 0.8,
      currentPriceChange5m: 117,
    },
  });

  assert.equal(decision.allow, true);
  assert.match(decision.reason || '', /route-live continuation override/i);
});

test('route-live continuation override stays off for weak missing-1m route flow', () => {
  const decision = evaluateRouteLiveContinuationOverride({
    routeLive: true,
    missingMomentum1m: true,
    priceChange5m: 18,
    buys60s: 6,
    buyRatio60s: 0.55,
    velocity: 6,
    solVolume60s: 0.4,
    terrainSummary: {
      sampleCount: 1,
      strongFlowSamples: 0,
      routeStrengthPct: 5,
      priceOffPeak5m: 6,
      currentPriceChange5m: 18,
    },
  });

  assert.equal(decision.allow, false);
  assert.equal(decision.reason, null);
});

test('route-live continuation override allows explosive missing-1m raw flow that is still near peak', () => {
  const decision = evaluateRouteLiveContinuationOverride({
    routeLive: true,
    missingMomentum1m: true,
    priceChange5m: 0,
    buys60s: 20,
    buyRatio60s: 0.71,
    velocity: 28,
    solVolume60s: 24.194,
    terrainSummary: {
      sampleCount: 2,
      strongFlowSamples: 0,
      routeStrengthPct: 6,
      priceOffPeak5m: 1.2,
      currentPriceChange5m: 0,
    },
  });

  assert.equal(decision.allow, true);
  assert.match(decision.reason || '', /explosive raw flow/i);
});
