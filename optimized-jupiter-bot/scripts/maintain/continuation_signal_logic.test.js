const test = require('node:test');
const assert = require('node:assert/strict');

const {
  readOptionalDexMetric,
  evaluateContinuationSignal,
} = require('./continuation_signal_logic.ts');

test('readOptionalDexMetric preserves absent 1m candles as null', () => {
  assert.equal(readOptionalDexMetric({}, 'm1'), null);
  assert.equal(readOptionalDexMetric({ m1: 0 }, 'm1'), 0);
  assert.equal(readOptionalDexMetric({ m1: '1.75' }, 'm1'), 1.75);
});

test('evaluateContinuationSignal uses flow fallback only when 1m candle is missing', () => {
  const result = evaluateContinuationSignal({
    momentum1m: null,
    minMomentum1mPct: 0.8,
    buys60s: 14,
    buyRatio60s: 0.84,
    velocity: 18,
    solVolume60s: 3.5,
  });

  assert.equal(result.missingMomentum1m, true);
  assert.equal(result.usingFlowFallback, true);
  assert.equal(result.hasContinuation, true);
});

test('evaluateContinuationSignal does not let strong flow override a known flat 1m candle', () => {
  const result = evaluateContinuationSignal({
    momentum1m: 0,
    minMomentum1mPct: 0.8,
    buys60s: 20,
    buyRatio60s: 0.9,
    velocity: 25,
    solVolume60s: 6,
    mode: 'velocity',
  });

  assert.equal(result.missingMomentum1m, false);
  assert.equal(result.usingFlowFallback, false);
  assert.equal(result.hasContinuation, false);
});

test('evaluateContinuationSignal in velocity mode rescues borderline live flow when 1m candle is missing', () => {
  const result = evaluateContinuationSignal({
    momentum1m: null,
    minMomentum1mPct: 0.8,
    buys60s: 12,
    buyRatio60s: 1.0,
    velocity: 12,
    solVolume60s: 1.98,
    mode: 'velocity',
  });

  assert.equal(result.missingMomentum1m, true);
  assert.equal(result.usingFlowFallback, true);
  assert.equal(result.hasContinuation, true);
});

test('evaluateContinuationSignal in velocity mode rescues clean 9-buy high-sol bursts when 1m is missing', () => {
  const result = evaluateContinuationSignal({
    momentum1m: null,
    minMomentum1mPct: 0.8,
    buys60s: 9,
    buyRatio60s: 1.0,
    velocity: 9,
    solVolume60s: 3.805,
    mode: 'velocity',
  });

  assert.equal(result.missingMomentum1m, true);
  assert.equal(result.usingFlowFallback, true);
  assert.equal(result.hasContinuation, true);
});

test('evaluateContinuationSignal in velocity mode rescues 9-buy gmgn bursts with 10 tx/min when 1m is missing', () => {
  const result = evaluateContinuationSignal({
    momentum1m: null,
    minMomentum1mPct: 0.8,
    buys60s: 9,
    buyRatio60s: 0.9,
    velocity: 10,
    solVolume60s: 2.298,
    mode: 'velocity',
  });

  assert.equal(result.usingFlowFallback, true);
  assert.equal(result.hasContinuation, true);
});

test('evaluateContinuationSignal in velocity mode rescues high-conviction 81% buy-ratio flow when 1m is missing', () => {
  const result = evaluateContinuationSignal({
    momentum1m: null,
    minMomentum1mPct: 0.8,
    buys60s: 13,
    buyRatio60s: 13 / 16,
    velocity: 16,
    solVolume60s: 10.188,
    mode: 'velocity',
  });

  assert.equal(result.usingFlowFallback, true);
  assert.equal(result.hasContinuation, true);
});

test('evaluateContinuationSignal uses terrain-flow fallback for repeated clean missing-1m flow', () => {
  const result = evaluateContinuationSignal({
    momentum1m: null,
    minMomentum1mPct: 0.8,
    buys60s: 8,
    buyRatio60s: 1.0,
    velocity: 8,
    solVolume60s: 1.31,
    mode: 'velocity',
    terrainSampleCount: 3,
    terrainStrongFlowSamples: 0,
    terrainFlowDecayRatio: 0.91,
    terrainPriceOffPeak5m: 0.4,
    terrainCurrentPriceChange5m: 0,
  });

  assert.equal(result.terrainContinuation, true);
  assert.equal(result.fallbackSource, 'terrain-flow-fallback');
  assert.equal(result.usingFlowFallback, true);
  assert.equal(result.hasContinuation, true);
});

test('evaluateContinuationSignal does not use terrain-flow fallback for low-ratio missing-1m flow', () => {
  const result = evaluateContinuationSignal({
    momentum1m: null,
    minMomentum1mPct: 0.8,
    buys60s: 8,
    buyRatio60s: 0.73,
    velocity: 11,
    solVolume60s: 2.9,
    mode: 'velocity',
    terrainSampleCount: 3,
    terrainStrongFlowSamples: 2,
    terrainFlowDecayRatio: 0.95,
    terrainPriceOffPeak5m: 0.2,
    terrainCurrentPriceChange5m: 0,
  });

  assert.equal(result.terrainContinuation, false);
  assert.equal(result.fallbackSource, null);
  assert.equal(result.hasContinuation, false);
});
