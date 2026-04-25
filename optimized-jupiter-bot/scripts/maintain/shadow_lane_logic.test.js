const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeShadowLaneConfig,
  evaluateBuyRatioShadowLane,
  evaluateWeakMomentumShadowLane,
} = require('./shadow_lane_logic.ts');

test('buy-ratio shadow lane holds near-threshold strong-flow candidate on shallow samples', () => {
  const config = normalizeShadowLaneConfig({});
  const result = evaluateBuyRatioShadowLane(
    {
      buyRatio: 1.55,
      reqRatio: 1.8,
      buys60s: 9,
      buyRatio60s: 0.84,
      velocity: 11,
      solVolume60s: 2.1,
      terrainSummary: { sampleCount: 1, spanMs: 4000, currentPriceChange5m: 0.2, priceDelta5m: 0.3 },
    },
    config,
  );
  assert.equal(result.shouldHold, true);
  assert.equal(result.code, 'shadow_buy_ratio_hold');
});

test('buy-ratio shadow lane rejects names that are too far below threshold', () => {
  const config = normalizeShadowLaneConfig({});
  const result = evaluateBuyRatioShadowLane(
    {
      buyRatio: 1.1,
      reqRatio: 1.8,
      buys60s: 12,
      buyRatio60s: 0.84,
      velocity: 12,
      solVolume60s: 2.5,
      terrainSummary: { sampleCount: 1, spanMs: 4000 },
    },
    config,
  );
  assert.equal(result.shouldHold, false);
});

test('buy-ratio shadow lane holds improving strong-flow candidate after enough samples', () => {
  const config = normalizeShadowLaneConfig({});
  const result = evaluateBuyRatioShadowLane(
    {
      buyRatio: 1.6,
      reqRatio: 1.8,
      buys60s: 10,
      buyRatio60s: 0.82,
      velocity: 10,
      solVolume60s: 1.8,
      terrainSummary: {
        sampleCount: 3,
        spanMs: 12000,
        currentPriceChange5m: 1.4,
        priceDelta5m: 2.7,
        flowDecayRatio: 0.8,
      },
    },
    config,
  );
  assert.equal(result.shouldHold, true);
});

test('weak-momentum shadow lane holds shallow strong-flow near-miss', () => {
  const config = normalizeShadowLaneConfig({});
  const result = evaluateWeakMomentumShadowLane(
    {
      momentum5m: -1.2,
      continuationApproved: false,
      buys60s: 10,
      buyRatio60s: 0.85,
      velocity: 12,
      solVolume60s: 2.2,
      terrainSummary: { sampleCount: 1, spanMs: 5000 },
    },
    config,
  );
  assert.equal(result.shouldHold, true);
  assert.equal(result.code, 'shadow_weak_momentum_hold');
});

test('weak-momentum shadow lane widens assessment for bounded 5/1/5 near-miss flow', () => {
  const config = normalizeShadowLaneConfig({});
  const result = evaluateWeakMomentumShadowLane(
    {
      momentum5m: 0,
      continuationApproved: false,
      buys60s: 5,
      buyRatio60s: 1,
      velocity: 5,
      solVolume60s: 1.05,
      terrainSummary: { sampleCount: 1, spanMs: 3000 },
    },
    config,
  );
  assert.equal(result.shouldHold, true);
  assert.equal(result.code, 'shadow_weak_momentum_hold');
});

test('buy-ratio shadow lane keeps stricter strong-flow floor than weak-momentum widening', () => {
  const config = normalizeShadowLaneConfig({});
  const result = evaluateBuyRatioShadowLane(
    {
      buyRatio: 1.6,
      reqRatio: 1.8,
      buys60s: 5,
      buyRatio60s: 1,
      velocity: 5,
      solVolume60s: 1.05,
      terrainSummary: { sampleCount: 1, spanMs: 3000 },
    },
    config,
  );
  assert.equal(result.shouldHold, false);
});

test('weak-momentum shadow lane rejects deeper negative momentum', () => {
  const config = normalizeShadowLaneConfig({});
  const result = evaluateWeakMomentumShadowLane(
    {
      momentum5m: -8,
      continuationApproved: false,
      buys60s: 12,
      buyRatio60s: 0.9,
      velocity: 14,
      solVolume60s: 2.6,
      terrainSummary: { sampleCount: 1, spanMs: 5000 },
    },
    config,
  );
  assert.equal(result.shouldHold, false);
});

test('weak-momentum shadow lane holds improving response after multiple samples', () => {
  const config = normalizeShadowLaneConfig({});
  const result = evaluateWeakMomentumShadowLane(
    {
      momentum5m: 0.2,
      continuationApproved: false,
      buys60s: 9,
      buyRatio60s: 0.86,
      velocity: 10,
      solVolume60s: 1.9,
      terrainSummary: {
        sampleCount: 3,
        spanMs: 14000,
        currentPriceChange5m: 0.9,
        priceDelta5m: 3.1,
        flowDecayRatio: 0.82,
      },
    },
    config,
  );
  assert.equal(result.shouldHold, true);
});
