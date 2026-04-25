const test = require('node:test');
const assert = require('node:assert/strict');

const { computeEntryConfidence } = require('./entry_confidence_logic.ts');

test('computeEntryConfidence rescues strong live-flow candidates from brittle TA-only rejection', () => {
  const confidence = computeEntryConfidence({
    taConfidence: 0.145,
    buyRatio: 1000,
    volume1hUsd: 0,
    buys1h: 840,
    velocity: {
      buys60s: 14,
      buyRatio60s: 1.0,
      velocity: 14,
      solVolume60s: 4.9,
    },
  });

  assert.ok(Math.abs(confidence - 0.6) < 1e-9);
});

test('computeEntryConfidence stays conservative when flow and participation are weak', () => {
  const confidence = computeEntryConfidence({
    taConfidence: 0.12,
    buyRatio: 1.4,
    volume1hUsd: 1200,
    buys1h: 40,
    velocity: {
      buys60s: 4,
      buyRatio60s: 0.55,
      velocity: 5,
      solVolume60s: 0.4,
    },
  });

  assert.ok(Math.abs(confidence - 0.14) < 1e-9);
});

test('computeEntryConfidence caps structural confidence from extreme buy ratios', () => {
  const confidence = computeEntryConfidence({
    taConfidence: 0.05,
    buyRatio: 9999,
    volume1hUsd: 1000,
    buys1h: 20,
    velocity: null,
  });

  assert.equal(confidence, 0.25);
});
