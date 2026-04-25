const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateFdvLiquidityGuard } = require('./fdv_liquidity_logic.ts');

test('fdv/liquidity guard warns and blocks extreme normal-lane air', () => {
  const decision = evaluateFdvLiquidityGuard(
    {
      entryMode: 'normal',
      valuationUsd: 500000,
      liquidityUsd: 10000,
    },
    {
      warnFdvToLiquidityRatio: 12,
      normalBlockFdvToLiquidityRatio: 18,
      minLiquidityUsdToApply: 5000,
      minValuationUsdToApply: 50000,
    },
  );

  assert.equal(decision.shouldWarn, true);
  assert.equal(decision.shouldBlock, true);
  assert.equal(decision.metrics.fdvToLiquidityRatio, 50);
  assert.equal(decision.metrics.liquidityToFdvRatio, 0.02);
});

test('fdv/liquidity guard is more permissive in micro-scout mode', () => {
  const decision = evaluateFdvLiquidityGuard(
    {
      entryMode: 'micro-scout',
      valuationUsd: 180000,
      liquidityUsd: 10000,
    },
    {
      warnFdvToLiquidityRatio: 12,
      normalBlockFdvToLiquidityRatio: 18,
      microScoutBlockFdvToLiquidityRatio: 28,
      minLiquidityUsdToApply: 5000,
      minValuationUsdToApply: 50000,
    },
  );

  assert.equal(decision.shouldWarn, true);
  assert.equal(decision.shouldBlock, false);
  assert.equal(decision.blockRatio, 28);
});

test('fdv/liquidity guard is stricter for mature fallback lane', () => {
  const decision = evaluateFdvLiquidityGuard(
    {
      entryMode: 'micro-scout',
      sourceLane: 'mature-fallback',
      valuationUsd: 240000,
      liquidityUsd: 15000,
    },
    {
      warnFdvToLiquidityRatio: 12,
      matureFallbackBlockFdvToLiquidityRatio: 15,
      microScoutBlockFdvToLiquidityRatio: 28,
      minLiquidityUsdToApply: 5000,
      minValuationUsdToApply: 50000,
    },
  );

  assert.equal(decision.shouldWarn, true);
  assert.equal(decision.shouldBlock, true);
  assert.equal(decision.blockRatio, 15);
});

test('fdv/liquidity guard stays inactive when valuation or liquidity are too small', () => {
  const decision = evaluateFdvLiquidityGuard(
    {
      entryMode: 'normal',
      valuationUsd: 20000,
      liquidityUsd: 3000,
    },
    {
      minLiquidityUsdToApply: 5000,
      minValuationUsdToApply: 50000,
    },
  );

  assert.equal(decision.shouldWarn, false);
  assert.equal(decision.shouldBlock, false);
});
