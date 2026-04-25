const test = require('node:test');
const assert = require('node:assert/strict');

const { getEntryQualifierThreshold } = require('./entry_qualifier_logic.ts');

test('getEntryQualifierThreshold relaxes slightly for clean continuation-approved flow', () => {
  assert.equal(getEntryQualifierThreshold({
    continuationApproved: true,
    buys60s: 12,
    buyRatio60s: 1.0,
    velocity: 12,
    solVolume60s: 2.234,
  }), 0.42);
});

test('getEntryQualifierThreshold stays strict when continuation approval is absent', () => {
  assert.equal(getEntryQualifierThreshold({
    continuationApproved: false,
    buys60s: 12,
    buyRatio60s: 1.0,
    velocity: 12,
    solVolume60s: 2.234,
  }), 0.45);
});

test('getEntryQualifierThreshold stays strict for weak continuation flow', () => {
  assert.equal(getEntryQualifierThreshold({
    continuationApproved: true,
    buys60s: 8,
    buyRatio60s: 0.85,
    velocity: 9,
    solVolume60s: 1.5,
  }), 0.45);
});
