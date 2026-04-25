const test = require('node:test');
const assert = require('node:assert/strict');

const { summarizeRealizedProfit } = require('./profit_accumulator.ts');

test('summarizeRealizedProfit accumulates closed sell pnl including partial exits', () => {
  const summary = summarizeRealizedProfit([
    { action: 'BUY', pnlSol: 999, ts: 1, sig: 'buysig' },
    { action: 'SELL', pnlSol: 0.04, ts: 2, sig: 'sell-1', partialExit: true },
    { action: 'SELL', pnlSol: -0.01, ts: 3, sig: 'sell-2' },
    { action: 'SELL', pnlSol: 0.03, ts: 4, sig: 'sell-3', partialExit: true },
  ], 0.8);

  assert.equal(summary.closedSellCount, 3);
  assert.equal(summary.wins, 2);
  assert.equal(summary.losses, 1);
  assert.equal(summary.totalRealizedPnlSol, 0.06);
  assert.equal(summary.eligibleProfitSol, 0.048);
  assert.equal(summary.positiveProfitSeekingScore, 0.25);
  assert.equal(summary.negativeProfitSeekingScoreAbs, 0.02);
  assert.equal(summary.totalProfitSeekingScore, 0.23);
  assert.equal(summary.profitSeekingRatio, 12.5);
  assert.ok(summary.rewardAsymmetryFactor > 0);
  assert.equal(summary.lastSellTs, 4);
});

test('summarizeRealizedProfit ignores ghost live rows and clamps reinvestment at zero during drawdown', () => {
  const summary = summarizeRealizedProfit([
    { action: 'SELL', pnlSol: 0.2, ts: 1, sig: '1111111111111111111111111111111111111111111111111111111111111111' },
    { action: 'SELL', pnlSol: -0.3, ts: 2, sig: 'real-sell-1' },
    { action: 'SELL', pnlSol: 0.1, ts: 3, sig: 'PAPER_TRADE_123' },
  ], 0.8);

  assert.equal(summary.closedSellCount, 1);
  assert.equal(summary.totalRealizedPnlSol, -0.3);
  assert.equal(summary.realizedProfitSol, 0);
  assert.equal(summary.eligibleProfitSol, 0);
  assert.equal(summary.totalProfitSeekingScore, -18);
  assert.equal(summary.profitSeekingRatio, 0);
  assert.ok(summary.rewardAsymmetryFactor < 0);
});
