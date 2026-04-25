const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeBuyCountOverrideConfig,
  shouldAllowBuyCountOverride,
} = require('./buy_count_override_logic.ts');

test('normalizeBuyCountOverrideConfig applies safe defaults', () => {
  const config = normalizeBuyCountOverrideConfig();
  assert.equal(config.minBuys1hAbsolute, 2);
  assert.equal(config.minBuys60s, 8);
  assert.equal(config.minVelocity, 10);
});

test('allows fresh strong-flow candidate to bypass lagging 1h buy floor', () => {
  const config = normalizeBuyCountOverrideConfig();
  const allowed = shouldAllowBuyCountOverride({
    buys1h: 3,
    reqBuys: 8,
    tokenAgeSec: 300,
    buys60s: 10,
    buyRatio60s: 1,
    velocity: 10,
    solVolume60s: 10.924,
  }, config);
  assert.equal(allowed, true);
});

test('allows continuation-approved strong flow even when token age is not fresh', () => {
  const config = normalizeBuyCountOverrideConfig();
  const allowed = shouldAllowBuyCountOverride({
    buys1h: 4,
    reqBuys: 8,
    tokenAgeSec: 7200,
    continuationApproved: true,
    buys60s: 9,
    buyRatio60s: 0.86,
    velocity: 11,
    solVolume60s: 4.5,
  }, config);
  assert.equal(allowed, true);
});

test('rejects stale candidate without continuation approval', () => {
  const config = normalizeBuyCountOverrideConfig();
  const allowed = shouldAllowBuyCountOverride({
    buys1h: 4,
    reqBuys: 8,
    tokenAgeSec: 7200,
    buys60s: 10,
    buyRatio60s: 0.85,
    velocity: 10,
    solVolume60s: 4,
  }, config);
  assert.equal(allowed, false);
});

test('rejects weak current flow even when 1h history is near the floor', () => {
  const config = normalizeBuyCountOverrideConfig();
  const allowed = shouldAllowBuyCountOverride({
    buys1h: 3,
    reqBuys: 8,
    tokenAgeSec: 240,
    buys60s: 4,
    buyRatio60s: 0.7,
    velocity: 6,
    solVolume60s: 0.9,
  }, config);
  assert.equal(allowed, false);
});

test('rejects names that are too far below the 1h buy floor', () => {
  const config = normalizeBuyCountOverrideConfig();
  const allowed = shouldAllowBuyCountOverride({
    buys1h: 1,
    reqBuys: 8,
    tokenAgeSec: 240,
    buys60s: 12,
    buyRatio60s: 1,
    velocity: 12,
    solVolume60s: 12,
  }, config);
  assert.equal(allowed, false);
});
