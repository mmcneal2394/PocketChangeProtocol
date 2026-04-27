const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTargetQualitySummaryFromRows,
  evaluateTargetQualityGovernor,
  normalizeTargetQualityLane,
  resolveGovernedRankScore,
} = require('./target_quality_ledger_logic.ts');

function roundTrip({
  id,
  lane,
  family = lane,
  entryMode = 'normal',
  entryCostSol = 0.01,
  proceedsSol,
  ts,
}) {
  return [
    {
      eventType: 'entry',
      action: 'BUY',
      tradeId: id,
      mint: `${id}-mint`,
      symbol: id,
      amountSol: entryCostSol,
      entryCostSol,
      sourceLane: lane,
      entryFamily: family,
      entryMode,
      timestamp: ts,
      ts,
      openedAt: ts,
    },
    {
      eventType: 'outcome',
      action: 'SELL',
      tradeId: `${id}-sell`,
      parentBuyId: id,
      mint: `${id}-mint`,
      symbol: id,
      amountSol: proceedsSol,
      partialExit: false,
      timestamp: ts + 60_000,
      ts: ts + 60_000,
      closedAt: ts + 60_000,
    },
  ];
}

test('normalizeTargetQualityLane collapses equivalent velocity and wallet lanes', () => {
  assert.equal(normalizeTargetQualityLane({ sourceLane: 'velocity-first-preflight' }), 'velocity');
  assert.equal(normalizeTargetQualityLane({ sourceLane: 'wallet-signal' }), 'wallet');
  assert.equal(normalizeTargetQualityLane({ entryMode: 'micro-scout' }), 'micro-scout');
});

test('buildTargetQualitySummaryFromRows tracks rejects, entries, and closed PnL by lane', () => {
  const rows = [
    {
      eventType: 'reject',
      mint: 'reject-1',
      symbol: 'BAD',
      sourceLane: 'alpha',
      entryFamily: 'alpha',
      entryMode: 'normal',
      reason: 'weak_confirmation',
      ts: 1_000,
    },
    ...roundTrip({
      id: 'wallet-win',
      lane: 'wallet',
      proceedsSol: 0.013,
      ts: 10_000,
    }),
    ...roundTrip({
      id: 'wallet-loss',
      lane: 'wallet',
      proceedsSol: 0.008,
      ts: 20_000,
    }),
  ];

  const summary = buildTargetQualitySummaryFromRows(rows);

  assert.equal(summary.byLane.alpha.rejects, 1);
  assert.equal(summary.byLane.alpha.rejectRate, 1);
  assert.equal(summary.byLane.wallet.entries, 2);
  assert.equal(summary.byLane.wallet.closedTrades, 2);
  assert.equal(summary.byLane.wallet.wins, 1);
  assert.equal(summary.byLane.wallet.losses, 1);
  assert.equal(summary.byLane.wallet.totalPnlSol, 0.001);
  assert.equal(summary.byLane.wallet.avgPnlSol, 0.0005);
});

test('evaluateTargetQualityGovernor promotes profitable lanes without blocking cold starts', () => {
  const rows = [];
  for (let i = 0; i < 8; i += 1) {
    rows.push(...roundTrip({
      id: `wallet-${i}`,
      lane: 'wallet',
      proceedsSol: 0.013,
      ts: 100_000 + i * 90_000,
    }));
  }
  const summary = buildTargetQualitySummaryFromRows(rows);

  const wallet = evaluateTargetQualityGovernor({
    sourceLane: 'wallet',
    entryFamily: 'wallet',
    entryMode: 'normal',
    expectedValueSol: 0.0001,
  }, { summary });
  const cold = evaluateTargetQualityGovernor({
    sourceLane: 'new-lane',
    entryFamily: 'new-lane',
    entryMode: 'normal',
    expectedValueSol: 0,
  }, { summary });

  assert.equal(wallet.shouldSkip, false);
  assert.ok(wallet.positionMultiplier > 1);
  assert.ok(wallet.rankMultiplier > 1);
  assert.equal(cold.shouldSkip, false);
  assert.equal(cold.positionMultiplier, 1);
});

test('evaluateTargetQualityGovernor blocks repeatedly negative high-reject lanes', () => {
  const rows = [];
  for (let i = 0; i < 12; i += 1) {
    rows.push(...roundTrip({
      id: `alpha-loss-${i}`,
      lane: 'alpha',
      family: 'alpha',
      proceedsSol: 0.006,
      ts: 1_000_000 + i * 90_000,
    }));
  }
  for (let i = 0; i < 80; i += 1) {
    rows.push({
      eventType: 'reject',
      mint: `alpha-reject-${i}`,
      symbol: `AR${i}`,
      sourceLane: 'alpha',
      entryFamily: 'alpha',
      entryMode: 'normal',
      reason: 'weak_confirmation',
      ts: 2_000_000 + i * 1_000,
    });
  }
  const summary = buildTargetQualitySummaryFromRows(rows);
  const decision = evaluateTargetQualityGovernor({
    sourceLane: 'alpha',
    entryFamily: 'alpha',
    entryMode: 'normal',
    expectedValueSol: -0.0001,
  }, { summary });

  assert.equal(decision.shouldSkip, true);
  assert.equal(decision.positionMultiplier, 0);
  assert.ok(decision.skipReason.includes('alpha'));
});

test('resolveGovernedRankScore penalizes weak lanes and boosts strong lanes consistently', () => {
  assert.equal(resolveGovernedRankScore(0.00001, { rankMultiplier: 1.5, rankPenalty: 0 }), 0.000015);
  assert.ok(resolveGovernedRankScore(0.00001, { rankMultiplier: 0.5, rankPenalty: 0.000001 }) < 0.00001);
  assert.ok(resolveGovernedRankScore(-0.00001, { rankMultiplier: 0.5, rankPenalty: 0 }) < -0.00001);
});
