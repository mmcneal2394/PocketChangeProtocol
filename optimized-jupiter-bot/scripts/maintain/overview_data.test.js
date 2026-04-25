const test = require('node:test');
const assert = require('node:assert/strict');

const {
  summarizeClosedTrades,
  summarizeRejectReasons,
  summarizeLearningBuckets,
  summarizeRecentTrades,
} = require('./overview_data.ts');

test('summarizeClosedTrades computes win rate and pnl over cutoff window', () => {
  const now = Date.now();
  const summary = summarizeClosedTrades([
    { action: 'SELL', pnlSol: 0.1, holdMs: 60_000, ts: now - 1000 },
    { action: 'SELL', pnlSol: -0.05, holdMs: 120_000, ts: now - 2000 },
    { action: 'BUY', amountSol: 0.005, ts: now - 3000 },
    { action: 'SELL', pnlSol: 0.25, holdMs: 180_000, ts: now - 48 * 60 * 60 * 1000 },
  ], now - 24 * 60 * 60 * 1000);

  assert.equal(summary.trades, 2);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 1);
  assert.equal(summary.totalPnlSol, 0.05);
  assert.equal(summary.winRate, 0.5);
  assert.equal(summary.avgHoldMinutes, 1.5);
});

test('summarizeRejectReasons sorts by count descending', () => {
  const reasons = summarizeRejectReasons({
    byReason: {
      foo: { count: 3, lastSymbol: 'AAA' },
      bar: { count: 8, lastSymbol: 'BBB' },
      baz: { count: 1, lastSymbol: 'CCC' },
    },
  });

  assert.deepEqual(reasons.map((row) => row.reason), ['bar', 'foo', 'baz']);
});

test('summarizeLearningBuckets returns best and worst buckets for populated dimensions', () => {
  const rows = summarizeLearningBuckets({
    dimensions: {
      entryMode: {
        normal: { trades: 4, winRate: 0.5, avgPnlSol: 0.001 },
        'micro-scout': { trades: 3, winRate: 0.66, avgPnlSol: 0.003 },
      },
      sourceLane: {
        wallet: { trades: 5, winRate: 0.8, avgPnlSol: 0.004 },
        alpha: { trades: 3, winRate: 0.33, avgPnlSol: -0.002 },
      },
      liquidityBucket: {
        '10k-25k': { trades: 2, winRate: 0.5, avgPnlSol: -0.001 },
        '50k-100k': { trades: 5, winRate: 0.8, avgPnlSol: 0.004 },
      },
    },
  });

  const entryMode = rows.find((row) => row.dimension === 'entryMode');
  assert.equal(entryMode.best.bucket, 'micro-scout');
  assert.equal(entryMode.worst.bucket, 'normal');
  const sourceLane = rows.find((row) => row.dimension === 'sourceLane');
  assert.equal(sourceLane.best.bucket, 'wallet');
  assert.equal(sourceLane.worst.bucket, 'alpha');
});

test('summarizeRecentTrades hides ghost live rows from the overview feed', () => {
  const rows = summarizeRecentTrades([
    { action: 'BUY', symbol: 'REAL', amountSol: 0.005, sig: '4V9okQRsABCDEFG123456789', ts: 20 },
    { action: 'SELL', symbol: 'GHOST', amountSol: 0.1, sig: '1111111111111111111111111111111111111111111111111111111111111111', ts: 30 },
    { action: 'BUY', symbol: 'PAPER', amountSol: 0.001, sig: 'PAPER_TRADE_123', ts: 40 },
    { action: 'SELL', symbol: 'REAL2', amountSol: 0.006, pnlSol: 0.001, sig: '5WRv9rxEXYZ987654321', ts: 50 },
  ], 10);

  assert.deepEqual(rows.map((row) => row.symbol), ['REAL2', 'REAL']);
  assert.equal(rows.length, 2);
});
