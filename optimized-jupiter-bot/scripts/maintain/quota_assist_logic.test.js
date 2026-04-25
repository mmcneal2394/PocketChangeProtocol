const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeWalletProfitSeekingEdgeScore,
  computeWalletQuotaSignalScore,
  resolveQuotaAssistLevel,
  sortWalletQuotaSignals,
  shouldBypassCooldownForQuotaAssist,
} = require('./quota_assist_logic.ts');

test('resolveQuotaAssistLevel uses the explicit 15/10 slot thresholds', () => {
  assert.equal(resolveQuotaAssistLevel(15), 0);
  assert.equal(resolveQuotaAssistLevel(12), 1);
  assert.equal(resolveQuotaAssistLevel(9), 2);
});

test('sortWalletQuotaSignals prioritizes the composite wallet score before legacy tie-breakers', () => {
  const sorted = sortWalletQuotaSignals([
    { mint: 'c', sizeUp: false, priority: 'HIGH', consensusScore: 0.75, walletPnlScore: 0.7, walletWeightedScore: 0.71, avgWalletWinRate: 0.61, walletTradeCount: 4200, wallets: ['a', 'b'], lastSeenMs: Date.now() - 5_000 },
    { mint: 'b', sizeUp: false, priority: 'SCALP', consensusScore: 0.95, walletPnlScore: 0.8, walletWeightedScore: 0.66, avgWalletWinRate: 0.59, walletTradeCount: 2500, wallets: ['a', 'b', 'c'], lastSeenMs: Date.now() - 5_000 },
    { mint: 'a', sizeUp: true, priority: 'HIGH', consensusScore: 0.6, walletPnlScore: 0.5, walletWeightedScore: 0.53, avgWalletWinRate: 0.52, walletTradeCount: 1800, wallets: ['a'], lastSeenMs: Date.now() - 5_000 },
    { mint: 'd', sizeUp: false, priority: 'VERY_HIGH', consensusScore: 0.6, walletPnlScore: 0.6, walletWeightedScore: 0.83, avgWalletWinRate: 0.67, walletTradeCount: 9500, wallets: ['a'], lastSeenMs: Date.now() - 5_000 },
  ]);

  assert.deepEqual(sorted.map((row) => row.mint), ['a', 'd', 'b', 'c']);
  assert.ok(computeWalletQuotaSignalScore(sorted[1]) > computeWalletQuotaSignalScore(sorted[2]));
  assert.ok(computeWalletQuotaSignalScore(sorted[2]) > computeWalletQuotaSignalScore(sorted[3]));
});

test('computeWalletProfitSeekingEdgeScore penalizes risky low-quality quota candidates', () => {
  const strong = computeWalletProfitSeekingEdgeScore({
    sizeUp: true,
    consensusScore: 0.82,
    walletPnlScore: 0.76,
    walletWeightedScore: 0.79,
    avgWalletWinRate: 0.68,
    kolConfirmed: true,
    copyabilityRisk: 'low',
  });
  const weak = computeWalletProfitSeekingEdgeScore({
    sizeUp: false,
    consensusScore: 0.58,
    walletPnlScore: 0.32,
    walletWeightedScore: 0.41,
    avgWalletWinRate: 0.44,
    kolConfirmed: false,
    copyabilityRisk: 'high',
  });

  assert.ok(strong > weak);
  assert.ok(strong > 0.5);
});

test('shouldBypassCooldownForQuotaAssist only allows level-2 alpha and wallet entries with zero strikes', () => {
  assert.equal(
    shouldBypassCooldownForQuotaAssist({ quotaAssist: true, quotaAssistLevel: 2, sourceLane: 'wallet', strikeCount: 0 }),
    true,
  );
  assert.equal(
    shouldBypassCooldownForQuotaAssist({ quotaAssist: true, quotaAssistLevel: 2, sourceLane: 'alpha', strikeCount: 1 }),
    false,
  );
  assert.equal(
    shouldBypassCooldownForQuotaAssist({ quotaAssist: true, quotaAssistLevel: 1, sourceLane: 'wallet', strikeCount: 0 }),
    false,
  );
  assert.equal(
    shouldBypassCooldownForQuotaAssist({ quotaAssist: true, quotaAssistLevel: 2, sourceLane: 'velocity-first', strikeCount: 0 }),
    false,
  );
});
