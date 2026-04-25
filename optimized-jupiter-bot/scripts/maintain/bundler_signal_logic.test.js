const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateBundlerSuspicion } = require('./bundler_signal_logic.ts');

const config = {
  enabled: true,
  warnScore: 0.45,
  blockScore: 0.72,
  blockLiquidityUsdCeiling: 50000,
  blockHolderCountCeiling: 200,
  maxFreshTokenAgeSec: 900,
  cooldownWarnSeconds: 180,
  cooldownBlockSeconds: 900,
  strongFlowBuys60s: 8,
  strongFlowSolVolume60s: 2,
  strongFlowVelocity: 10,
  flatMomentum5mPct: 2,
  flatMomentum1mPct: 0.75,
  highTurnoverToLiquidityRatio: 2.5,
  lowHolderCountThreshold: 120,
  heavyTop10PctThreshold: 35,
  blockEntryModes: ['normal', 'micro-scout', 'last-stand'],
};

test('blocks strongest fake-flow bundle pattern', () => {
  const result = evaluateBundlerSuspicion({
    entryMode: 'micro-scout',
    tokenAgeSec: 180,
    liquidityUsd: 12000,
    volume1hUsd: 68000,
    momentum5mPct: 0.4,
    momentum1mPct: 0.1,
    buys60s: 18,
    sells60s: 2,
    buyRatio60s: 0.9,
    velocity: 20,
    solVolume60s: 4.2,
    holderCount: 42,
    top10Pct: 46,
    isJitterBundle: true,
  }, config);

  assert.equal(result.shouldBlock, true);
  assert.equal(result.severity, 'block');
  assert.ok(result.score >= config.blockScore);
  assert.ok(result.flags.includes('buy_pressure_without_price_response'));
  assert.ok(result.flags.includes('jitter_bundle_holder_shape'));
});

test('warns on suspicious churn but does not hard-block healthy-liquidity token', () => {
  const result = evaluateBundlerSuspicion({
    entryMode: 'normal',
    tokenAgeSec: 420,
    liquidityUsd: 125000,
    volume1hUsd: 520000,
    momentum5mPct: 0.8,
    momentum1mPct: 0.2,
    buys60s: 14,
    sells60s: 11,
    buyRatio60s: 0.56,
    velocity: 16,
    solVolume60s: 3.5,
    holderCount: 110,
    top10Pct: 26,
    isJitterBundle: false,
  }, config);

  assert.equal(result.shouldWarn, true);
  assert.equal(result.shouldBlock, false);
  assert.equal(result.severity, 'warn');
  assert.ok(result.flags.includes('balanced_churn_without_price_response'));
});

test('does not warn when strong flow has real price response', () => {
  const result = evaluateBundlerSuspicion({
    entryMode: 'micro-scout',
    tokenAgeSec: 300,
    liquidityUsd: 26000,
    volume1hUsd: 110000,
    momentum5mPct: 11,
    momentum1mPct: 3.4,
    buys60s: 15,
    sells60s: 3,
    buyRatio60s: 0.84,
    velocity: 18,
    solVolume60s: 4.8,
    holderCount: 220,
    top10Pct: 18,
    isJitterBundle: false,
  }, config);

  assert.equal(result.shouldWarn, false);
  assert.equal(result.shouldBlock, false);
  assert.equal(result.severity, 'none');
  assert.ok(result.flags.includes('real_price_response_present'));
});

test('high score still avoids hard block when entry mode is not block eligible', () => {
  const result = evaluateBundlerSuspicion({
    entryMode: 'paper-only',
    tokenAgeSec: 120,
    liquidityUsd: 14000,
    volume1hUsd: 90000,
    momentum5mPct: 0.2,
    momentum1mPct: 0.1,
    buys60s: 20,
    sells60s: 1,
    buyRatio60s: 0.95,
    velocity: 24,
    solVolume60s: 5.1,
    holderCount: 30,
    top10Pct: 52,
    isJitterBundle: true,
  }, {
    ...config,
    blockEntryModes: ['normal'],
  });

  assert.equal(result.shouldBlock, false);
  assert.equal(result.shouldWarn, true);
  assert.equal(result.severity, 'warn');
});
