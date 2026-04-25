const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PARTIAL_TAKE_PROFIT_STAGES,
  resolvePartialTakeProfitPlan,
  resolveTrailingStopFloorPct,
} = require('./exit_strategy_logic.ts');

test('defines four staged take-profit bands with a 50 percent runner trim', () => {
  assert.deepEqual(
    PARTIAL_TAKE_PROFIT_STAGES.map((stage) => [stage.stage, stage.thresholdPct, stage.cumulativeSoldFraction]),
    [
      [1, 8, 0.30],
      [2, 15, 0.60],
      [3, 25, 0.80],
      [4, 50, 0.90],
    ],
  );
});

test('catches up straight to the highest reached take-profit stage in one pass', () => {
  assert.deepEqual(
    resolvePartialTakeProfitPlan({
      pnlPct: 52,
      partialProfitStage: 0,
      isLastStand: false,
      disablePartialTakeProfit: false,
    }),
    {
      currentStage: 0,
      targetStage: 4,
      reasonCode: 'TP_HIT_STAGE4',
      thresholdPct: 50,
      cumulativeSoldFraction: 0.90,
      sellFractionOfCurrent: 0.9,
    },
  );
});

test('sells only the incremental amount needed to reach the next cumulative target', () => {
  const plan = resolvePartialTakeProfitPlan({
    pnlPct: 26,
    partialProfitStage: 1,
    isLastStand: false,
    disablePartialTakeProfit: false,
  });

  assert.equal(plan.targetStage, 3);
  assert.equal(plan.reasonCode, 'TP_HIT_STAGE3');
  assert.ok(Math.abs(plan.sellFractionOfCurrent - (5 / 7)) < 1e-9);
  assert.equal(plan.cumulativeSoldFraction, 0.80);
});

test('does not emit a staged take-profit plan when partials are disabled', () => {
  assert.equal(
    resolvePartialTakeProfitPlan({
      pnlPct: 55,
      partialProfitStage: 0,
      isLastStand: false,
      disablePartialTakeProfit: true,
    }),
    null,
  );
});

test('uses the same dynamic trailing floor that the status line advertises for normal entries', () => {
  assert.equal(resolveTrailingStopFloorPct({ peakPnlPct: 11, isLastStand: false }), null);
  assert.equal(resolveTrailingStopFloorPct({ peakPnlPct: 12, isLastStand: false }), 10);
  assert.equal(resolveTrailingStopFloorPct({ peakPnlPct: 27, isLastStand: false }), 22);
  assert.equal(resolveTrailingStopFloorPct({ peakPnlPct: 50, isLastStand: false }), 35);
});

test('respects configured trailing parameters for last-stand entries', () => {
  assert.equal(
    resolveTrailingStopFloorPct({
      peakPnlPct: 15,
      isLastStand: true,
      trailingActivationPct: 8,
      trailingStopPct: 10,
    }),
    5,
  );
});
