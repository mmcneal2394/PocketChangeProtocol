const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldAllowVelocityVolumeOverride } = require('./volume_override_logic.ts');

test('shouldAllowVelocityVolumeOverride permits fresh strong-flow names with real liquidity', () => {
  assert.equal(shouldAllowVelocityVolumeOverride({
    tokenAgeSec: 180,
    momentum5m: 12,
    momentum1m: 2.5,
    poolLiquidityUsd: 8200,
    volume1hUsd: 18000,
    normalLaneMinVolume1hUsd: 50000,
    buys60s: 9,
    buyRatio60s: 1.0,
    velocity: 11,
    solVolume60s: 4.2,
  }), true);
});

test('shouldAllowVelocityVolumeOverride rejects zero-liquidity names despite strong flow', () => {
  assert.equal(shouldAllowVelocityVolumeOverride({
    tokenAgeSec: 120,
    momentum5m: 18,
    momentum1m: 1.2,
    poolLiquidityUsd: 0,
    volume1hUsd: 24000,
    normalLaneMinVolume1hUsd: 50000,
    buys60s: 12,
    buyRatio60s: 1.0,
    velocity: 12,
    solVolume60s: 7.9,
  }), false);
});

test('shouldAllowVelocityVolumeOverride rejects stale or weak continuation names', () => {
  assert.equal(shouldAllowVelocityVolumeOverride({
    tokenAgeSec: 2400,
    momentum5m: 3.5,
    momentum1m: 0.2,
    poolLiquidityUsd: 15000,
    volume1hUsd: 15000,
    normalLaneMinVolume1hUsd: 50000,
    buys60s: 8,
    buyRatio60s: 0.82,
    velocity: 8,
    solVolume60s: 2.2,
  }), false);
});

test('shouldAllowVelocityVolumeOverride permits continuation-approved near-floor names with positive 1m momentum', () => {
  assert.equal(shouldAllowVelocityVolumeOverride({
    tokenAgeSec: 420,
    momentum5m: 0,
    momentum1m: 1.4,
    poolLiquidityUsd: 9100,
    volume1hUsd: 43011,
    normalLaneMinVolume1hUsd: 50000,
    buys60s: 16,
    buyRatio60s: 0.89,
    velocity: 18,
    solVolume60s: 10.889,
    continuationApproved: true,
  }), true);
});

test('shouldAllowVelocityVolumeOverride rejects continuation-approved names that are too far below the volume floor', () => {
  assert.equal(shouldAllowVelocityVolumeOverride({
    tokenAgeSec: 420,
    momentum5m: 0,
    momentum1m: 1.8,
    poolLiquidityUsd: 9100,
    volume1hUsd: 25000,
    normalLaneMinVolume1hUsd: 50000,
    buys60s: 16,
    buyRatio60s: 0.89,
    velocity: 18,
    solVolume60s: 10.889,
    continuationApproved: true,
  }), false);
});

test('shouldAllowVelocityVolumeOverride rejects continuation-approved names that are already rolling over', () => {
  assert.equal(shouldAllowVelocityVolumeOverride({
    tokenAgeSec: 420,
    momentum5m: -1.5,
    momentum1m: 0.8,
    poolLiquidityUsd: 9100,
    volume1hUsd: 43011,
    normalLaneMinVolume1hUsd: 50000,
    buys60s: 16,
    buyRatio60s: 0.89,
    velocity: 18,
    solVolume60s: 10.889,
    continuationApproved: true,
  }), false);
});

test('shouldAllowVelocityVolumeOverride permits continuation-approved near-floor gmgn bursts', () => {
  assert.equal(shouldAllowVelocityVolumeOverride({
    tokenAgeSec: 7 * 60,
    momentum5m: 0,
    momentum1m: 0,
    poolLiquidityUsd: 6500,
    volume1hUsd: 22616,
    normalLaneMinVolume1hUsd: 25000,
    buys60s: 9,
    buyRatio60s: 0.9,
    velocity: 10,
    solVolume60s: 2.298,
    continuationApproved: true,
  }), true);
});
