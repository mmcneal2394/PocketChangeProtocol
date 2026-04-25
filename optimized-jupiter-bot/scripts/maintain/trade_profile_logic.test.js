const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTradeProfileEvent,
  updateTradeProfileStats,
} = require('./trade_profile_logic.ts');

test('createTradeProfileEvent carries quota-assisted wallet and alpha profiling fields', () => {
  const event = createTradeProfileEvent({
    action: 'SELL',
    ts: 100,
    pnlSol: 0.12,
    entryMode: 'normal',
    entryFamily: 'wallet',
    sourceLane: 'wallet',
    tokenAgeSec: 420,
    liquidityUsd: 18_000,
    marketCapUsd: 72_000,
    momentum5m: 11,
    buyRatio: 2.2,
    quotaAssistLevel: 2,
    walletSignalPriority: 'VERY_HIGH',
    walletConsensusScore: 0.88,
    walletWeightedScore: 0.81,
    walletCompositeScore: 0.86,
    kolConfirmed: true,
    alphaBoost: 0.14,
  });

  assert.equal(event.quotaAssistLevel, 2);
  assert.equal(event.dimensions.sourceLane, 'wallet');
  assert.equal(event.dimensions.entryFamily, 'wallet');
  assert.equal(event.dimensions.quotaAssistLevel, '2');
  assert.equal(event.dimensions.walletPriorityBucket, 'VERY_HIGH');
  assert.equal(event.dimensions.consensusBucket, '0.85+');
  assert.equal(event.dimensions.walletScoreBucket, '0.75-0.90');
  assert.equal(event.dimensions.alphaBoostBucket, '0.12-0.20');
  assert.equal(event.dimensions.kolConfirmed, 'yes');
});

test('updateTradeProfileStats rolls closed sells into the new dimensions', () => {
  const event = createTradeProfileEvent({
    action: 'SELL',
    ts: 200,
    pnlSol: -0.03,
    entryMode: 'normal',
    entryFamily: 'alpha',
    sourceLane: 'alpha',
    tokenAgeSec: 90,
    liquidityUsd: 9_000,
    marketCapUsd: 20_000,
    momentum5m: 3,
    buyRatio: 1.1,
    quotaAssistLevel: 1,
    walletSignalPriority: 'HIGH',
    walletConsensusScore: 0.72,
    walletWeightedScore: 0.63,
    walletCompositeScore: 0.69,
    kolConfirmed: false,
    alphaBoost: 0.06,
  });

  const stats = updateTradeProfileStats(null, event);

  assert.equal(stats.totals.trades, 1);
  assert.equal(stats.dimensions.sourceLane.alpha.trades, 1);
  assert.equal(stats.dimensions.quotaAssistLevel['1'].trades, 1);
  assert.equal(stats.dimensions.walletPriorityBucket.HIGH.trades, 1);
  assert.equal(stats.dimensions.consensusBucket['0.70-0.85'].trades, 1);
  assert.equal(stats.dimensions.walletScoreBucket['0.60-0.75'].trades, 1);
  assert.equal(stats.dimensions.alphaBoostBucket['0.05-0.12'].trades, 1);
  assert.equal(stats.dimensions.kolConfirmed.no.trades, 1);
});
