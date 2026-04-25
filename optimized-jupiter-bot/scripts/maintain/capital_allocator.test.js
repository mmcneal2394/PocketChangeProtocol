const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveSharedCapitalPlan } = require('./capital_allocator.ts');

test('resolveSharedCapitalPlan keeps arb scout-only until profit-backed capacity clears thresholds', () => {
  const plan = resolveSharedCapitalPlan({
    deployableSol: 1.2,
    totalRealizedPnlSol: 0.3,
    eligibleProfitSol: 0.24,
    minArbLiveProfitSol: 0.5,
    minArbLiveBudgetSol: 0.5,
    armedShare: 0.5,
  });

  assert.equal(plan.arbLiveEligible, false);
  assert.equal(plan.executionModeRecommendation, 'scout-only');
  assert.equal(plan.sniperWeight, 1);
  assert.equal(plan.arbWeight, 0);
  assert.equal(plan.sniperBudgetSol, 1.2);
  assert.equal(plan.arbBudgetSol, 0);
});

test('resolveSharedCapitalPlan unlocks equal split only when wallet and realized profit both support it', () => {
  const plan = resolveSharedCapitalPlan({
    deployableSol: 1.2,
    totalRealizedPnlSol: 0.9,
    eligibleProfitSol: 0.72,
    minArbLiveProfitSol: 0.5,
    minArbLiveBudgetSol: 0.5,
    armedShare: 0.5,
  });

  assert.equal(plan.arbLiveEligible, true);
  assert.equal(plan.executionModeRecommendation, 'live-eligible');
  assert.equal(plan.liveBudgetCapacitySol, 0.72);
  assert.equal(plan.sniperWeight, 0.5);
  assert.equal(plan.arbWeight, 0.5);
  assert.equal(plan.sniperBudgetSol, 0.6);
  assert.equal(plan.arbBudgetSol, 0.6);
});

test('resolveSharedCapitalPlan caps live budget capacity to actual deployable wallet balance', () => {
  const plan = resolveSharedCapitalPlan({
    deployableSol: 0.4,
    totalRealizedPnlSol: 2,
    eligibleProfitSol: 1.6,
    minArbLiveProfitSol: 0.5,
    minArbLiveBudgetSol: 0.5,
    armedShare: 0.5,
  });

  assert.equal(plan.liveBudgetCapacitySol, 0.4);
  assert.equal(plan.arbLiveEligible, false);
  assert.equal(plan.executionModeRecommendation, 'scout-only');
});
