const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildClosedTradeEpisodesFromRows,
  buildExpectedValueModelFromRows,
  scoreCandidateExpectedValue,
} = require('./ev_ranking_logic.ts');

function buildRoundTrip({
  id,
  mint,
  lane,
  family,
  entryMode = 'normal',
  entryCostSol = 0.01,
  proceedsSol,
  tokenAgeSec = 600,
  liquidityUsd = 20000,
  marketCapUsd = 80000,
  momentum5m = 8,
  buyRatio = 2.4,
  quotaAssistLevel = 1,
  walletSignalPriority = 'VERY_HIGH',
  walletConsensusScore = 0.82,
  alphaBoost = 0.12,
  kolConfirmed = true,
  preferredHoldMs = 180000,
  ts = 1_000,
}) {
  return [
    {
      action: 'BUY',
      tradeId: id,
      mint,
      symbol: mint,
      amountSol: entryCostSol,
      entryCostSol,
      entryMode,
      entryFamily: family,
      sourceLane: lane,
      tokenAgeSec,
      liquidityUsd,
      marketCapUsd,
      momentum5m,
      buyRatio,
      quotaAssistLevel,
      walletSignalPriority,
      walletConsensusScore,
      alphaBoost,
      kolConfirmed,
      preferredHoldMs,
      timestamp: ts,
      ts,
      openedAt: ts,
    },
    {
      action: 'SELL',
      tradeId: `${id}-sell`,
      parentBuyId: id,
      mint,
      symbol: mint,
      amountSol: proceedsSol,
      partialExit: false,
      timestamp: ts + 60_000,
      ts: ts + 60_000,
      closedAt: ts + 60_000,
    },
  ];
}

test('buildClosedTradeEpisodesFromRows aggregates partial exits into one realized episode', () => {
  const rows = [
    {
      action: 'BUY',
      tradeId: 'buy-1',
      mint: 'WalletMint',
      symbol: 'WALLET',
      amountSol: 0.01,
      entryCostSol: 0.01,
      entryMode: 'normal',
      entryFamily: 'wallet',
      sourceLane: 'wallet',
      timestamp: 1000,
      ts: 1000,
      openedAt: 1000,
    },
    {
      action: 'SELL',
      tradeId: 'sell-1a',
      parentBuyId: 'buy-1',
      mint: 'WalletMint',
      symbol: 'WALLET',
      amountSol: 0.006,
      partialExit: true,
      timestamp: 2000,
      ts: 2000,
      closedAt: 2000,
    },
    {
      action: 'SELL',
      tradeId: 'sell-1b',
      parentBuyId: 'buy-1',
      mint: 'WalletMint',
      symbol: 'WALLET',
      amountSol: 0.008,
      partialExit: false,
      remainingAmount: 0,
      timestamp: 3000,
      ts: 3000,
      closedAt: 3000,
    },
  ];

  const episodes = buildClosedTradeEpisodesFromRows(rows);
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].partialExitCount, 1);
  assert.equal(episodes[0].entryCostSol, 0.01);
  assert.equal(episodes[0].proceedsSol, 0.014);
  assert.equal(episodes[0].pnlSol, 0.004);
});

test('scoreCandidateExpectedValue prefers historically profitable wallet buckets over weak alpha buckets', () => {
  const rows = [];
  for (let i = 0; i < 10; i += 1) {
    rows.push(...buildRoundTrip({
      id: `wallet-${i}`,
      mint: `WalletMint${i}`,
      lane: 'wallet',
      family: 'wallet',
      proceedsSol: 0.013 + (i * 0.0001),
      ts: 10_000 + (i * 100_000),
    }));
  }
  for (let i = 0; i < 10; i += 1) {
    rows.push(...buildRoundTrip({
      id: `alpha-${i}`,
      mint: `AlphaMint${i}`,
      lane: 'alpha',
      family: 'alpha',
      walletSignalPriority: 'NONE',
      walletConsensusScore: 0.35,
      alphaBoost: 0.01,
      kolConfirmed: false,
      momentum5m: 2,
      buyRatio: 1.2,
      proceedsSol: 0.0075 - (i * 0.00005),
      ts: 1_000_000 + (i * 100_000),
    }));
  }

  const model = buildExpectedValueModelFromRows(rows);
  const walletDecision = scoreCandidateExpectedValue({
    entryMode: 'normal',
    entryFamily: 'wallet',
    sourceLane: 'wallet',
    tokenAgeSec: 620,
    liquidityUsd: 22000,
    marketCapUsd: 85000,
    momentum5m: 9,
    buyRatio: 2.6,
    quotaAssistLevel: 1,
    walletSignalPriority: 'VERY_HIGH',
    walletConsensusScore: 0.88,
    alphaBoost: 0.14,
    kolConfirmed: true,
    preferredHoldMs: 180000,
    confidenceScore: 0.82,
  }, { model });
  const alphaDecision = scoreCandidateExpectedValue({
    entryMode: 'normal',
    entryFamily: 'alpha',
    sourceLane: 'alpha',
    tokenAgeSec: 620,
    liquidityUsd: 22000,
    marketCapUsd: 85000,
    momentum5m: 2,
    buyRatio: 1.2,
    quotaAssistLevel: 1,
    walletSignalPriority: 'NONE',
    walletConsensusScore: 0.35,
    alphaBoost: 0.01,
    kolConfirmed: false,
    preferredHoldMs: 180000,
    confidenceScore: 0.55,
  }, { model });

  assert.ok(walletDecision.expectedPnlSol > alphaDecision.expectedPnlSol);
  assert.ok(walletDecision.rankScore > alphaDecision.rankScore);
  assert.equal(walletDecision.shouldSkip, false);
});

test('scoreCandidateExpectedValue marks strongly negative, well-evidenced setups as skippable', () => {
  const rows = [];
  for (let i = 0; i < 18; i += 1) {
    rows.push(...buildRoundTrip({
      id: `alpha-loss-${i}`,
      mint: `LossMint${i}`,
      lane: 'alpha',
      family: 'alpha',
      walletSignalPriority: 'NONE',
      walletConsensusScore: 0.3,
      alphaBoost: 0.01,
      kolConfirmed: false,
      momentum5m: 1,
      buyRatio: 1.05,
      proceedsSol: 0.0065,
      ts: 2_000_000 + (i * 50_000),
    }));
  }

  const model = buildExpectedValueModelFromRows(rows);
  const decision = scoreCandidateExpectedValue({
    entryMode: 'normal',
    entryFamily: 'alpha',
    sourceLane: 'alpha',
    tokenAgeSec: 900,
    liquidityUsd: 18000,
    marketCapUsd: 90000,
    momentum5m: 1,
    buyRatio: 1.1,
    quotaAssistLevel: 1,
    walletSignalPriority: 'NONE',
    walletConsensusScore: 0.35,
    alphaBoost: 0.01,
    kolConfirmed: false,
    preferredHoldMs: 180000,
    confidenceScore: 0.48,
  }, { model });

  assert.equal(decision.shouldSkip, true);
  assert.ok(decision.expectedPnlSol < 0);
  assert.ok(decision.positionMultiplier < 1);
});
