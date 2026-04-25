const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldAllowBuyRatioOverride } = require('./buy_ratio_override_logic.ts');

test('shouldAllowBuyRatioOverride rescues fresh continuation names with strong live flow', () => {
  assert.equal(shouldAllowBuyRatioOverride({
    buyRatio: 1.6,
    reqRatio: 2.5,
    continuationApproved: true,
    buys1h: 353,
    tokenAgeSec: 8 * 60,
    buys60s: 13,
    buyRatio60s: 1,
    velocity: 13,
    solVolume60s: 5.83,
  }), true);
});

test('shouldAllowBuyRatioOverride rejects stale names even with live flow', () => {
  assert.equal(shouldAllowBuyRatioOverride({
    buyRatio: 1.6,
    reqRatio: 2.5,
    continuationApproved: true,
    buys1h: 353,
    tokenAgeSec: 40 * 60,
    buys60s: 13,
    buyRatio60s: 1,
    velocity: 13,
    solVolume60s: 5.83,
  }), false);
});

test('shouldAllowBuyRatioOverride rejects weak aggregate participation', () => {
  assert.equal(shouldAllowBuyRatioOverride({
    buyRatio: 1.6,
    reqRatio: 2.5,
    continuationApproved: true,
    buys1h: 80,
    tokenAgeSec: 8 * 60,
    buys60s: 13,
    buyRatio60s: 1,
    velocity: 13,
    solVolume60s: 5.83,
  }), false);
});

test('shouldAllowBuyRatioOverride rescues missing-1m recovery when live volume is already strong', () => {
  assert.equal(shouldAllowBuyRatioOverride({
    buyRatio: 1.1,
    reqRatio: 2.5,
    continuationApproved: true,
    momentum1m: undefined,
    buys1h: 210,
    volume1hUsd: 6500,
    tokenAgeSec: 9 * 60,
    buys60s: 8,
    buyRatio60s: 0.72,
    velocity: 8,
    solVolume60s: 1.8,
  }), true);
});
