const test = require('node:test');
const assert = require('node:assert/strict');

const { resolvePortfolioSizedBuy } = require('./portfolio_sizing_logic.ts');

test('uses fixed sizing when portfolio mode is disabled', () => {
  const result = resolvePortfolioSizedBuy({
    deployableSol: 0.8,
    fixedBuySol: 0.001,
    portfolioSizingEnabled: false,
    portfolioFraction: 1,
    minDeploySol: 0.001,
  });
  assert.equal(result.sizingMode, 'fixed');
  assert.equal(result.desiredBuySol, 0.001);
  assert.equal(result.minDeploySol, 0.001);
  assert.equal(result.remainingSlots, 1);
});

test('uses one slot share of deployable balance when portfolio fraction is 100%', () => {
  const result = resolvePortfolioSizedBuy({
    deployableSol: 0.7423,
    fixedBuySol: 0.001,
    portfolioSizingEnabled: true,
    portfolioFraction: 1,
    currentOpenPositions: 0,
    maxOpenPositions: 10,
    minDeploySol: 0.001,
  });
  assert.equal(result.sizingMode, 'portfolio');
  assert.equal(result.desiredBuySol, 0.07423);
  assert.equal(result.remainingSlots, 10);
});

test('honors portfolio fraction within the remaining slot share', () => {
  const result = resolvePortfolioSizedBuy({
    deployableSol: 0.8,
    fixedBuySol: 0.001,
    portfolioSizingEnabled: true,
    portfolioFraction: 0.5,
    currentOpenPositions: 0,
    maxOpenPositions: 10,
    minDeploySol: 0.001,
  });
  assert.ok(Math.abs(result.desiredBuySol - 0.04) < 1e-12);
});

test('caps portfolio sizing when an explicit max deploy cap is provided', () => {
  const result = resolvePortfolioSizedBuy({
    deployableSol: 0.8,
    fixedBuySol: 0.001,
    portfolioSizingEnabled: true,
    portfolioFraction: 1,
    currentOpenPositions: 0,
    maxOpenPositions: 10,
    minDeploySol: 0.001,
    maxDeploySol: 0.25,
  });
  assert.ok(Math.abs(result.desiredBuySol - 0.08) < 1e-12);
});

test('sizes from remaining slots as positions are already open', () => {
  const result = resolvePortfolioSizedBuy({
    deployableSol: 0.5,
    fixedBuySol: 0.001,
    portfolioSizingEnabled: true,
    portfolioFraction: 1,
    currentOpenPositions: 7,
    maxOpenPositions: 10,
    minDeploySol: 0.001,
  });
  assert.ok(Math.abs(result.desiredBuySol - 0.16666666666666666) < 1e-12);
  assert.equal(result.remainingSlots, 3);
});

test('returns zero when no position slots remain', () => {
  const result = resolvePortfolioSizedBuy({
    deployableSol: 0.5,
    fixedBuySol: 0.001,
    portfolioSizingEnabled: true,
    portfolioFraction: 1,
    currentOpenPositions: 10,
    maxOpenPositions: 10,
    minDeploySol: 0.001,
  });
  assert.equal(result.desiredBuySol, 0);
  assert.equal(result.remainingSlots, 0);
});
