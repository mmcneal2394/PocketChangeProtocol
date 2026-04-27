const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scoreLiquidityQuality,
  resolveLiquidityGovernedRankScore,
} = require('./liquidity_quality_logic.ts');

test('scoreLiquidityQuality holds no-liquidity targets with no live route', () => {
  const decision = scoreLiquidityQuality({
    entryMode: 'micro-scout',
    liquidityUsd: 0,
    marketCapUsd: 40_000,
    fdvUsd: 40_000,
    minLiquidityUsd: 25_000,
    routeLive: false,
  });

  assert.equal(decision.shouldHold, true);
  assert.equal(decision.code, 'liquidity_quality_no_route');
  assert.equal(decision.positionMultiplier, 0);
  assert.ok(decision.rankMultiplier < 0.3);
});

test('scoreLiquidityQuality allows thin route-live targets when flow or wallet confirms them', () => {
  const decision = scoreLiquidityQuality({
    entryMode: 'micro-scout',
    sourceLane: 'velocity-first',
    liquidityUsd: 1_500,
    marketCapUsd: 60_000,
    fdvUsd: 60_000,
    volume1hUsd: 12_000,
    minLiquidityUsd: 25_000,
    routeLive: true,
    walletConfirmed: true,
    strongRecentFlowConfirmed: true,
  });

  assert.equal(decision.shouldHold, false);
  assert.ok(decision.positionMultiplier > 0);
  assert.ok(decision.rankMultiplier > 0.45);
  assert.equal(decision.metrics.routeLive, true);
});

test('scoreLiquidityQuality promotes healthy executable liquidity', () => {
  const decision = scoreLiquidityQuality({
    entryMode: 'normal',
    liquidityUsd: 80_000,
    marketCapUsd: 350_000,
    fdvUsd: 350_000,
    volume1hUsd: 180_000,
    minLiquidityUsd: 25_000,
    momentum5m: 12,
    routeLive: true,
  });

  assert.equal(decision.shouldHold, false);
  assert.ok(decision.score > 1);
  assert.ok(decision.rankMultiplier > 1);
  assert.ok(decision.positionMultiplier > 1);
});

test('scoreLiquidityQuality penalizes high valuation on thin liquidity', () => {
  const decision = scoreLiquidityQuality({
    entryMode: 'normal',
    liquidityUsd: 6_000,
    marketCapUsd: 900_000,
    fdvUsd: 900_000,
    volume1hUsd: 5_000,
    minLiquidityUsd: 25_000,
    routeLive: false,
  });

  assert.equal(decision.shouldHold, true);
  assert.equal(decision.code, 'liquidity_quality_thin_pool');
  assert.equal(decision.positionMultiplier, 0);
});

test('resolveLiquidityGovernedRankScore applies rank multiplier and penalties', () => {
  assert.equal(resolveLiquidityGovernedRankScore(0.00001, { enabled: true, rankMultiplier: 1.2, rankPenalty: 0 }), 0.000012);
  assert.ok(resolveLiquidityGovernedRankScore(0.00001, { enabled: true, rankMultiplier: 0.5, rankPenalty: 0.000001 }) < 0.00001);
  assert.ok(resolveLiquidityGovernedRankScore(-0.00001, { enabled: true, rankMultiplier: 0.5, rankPenalty: 0 }) < -0.00001);
});
