const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeWalletProfitSeekingEdgeScore,
  computeWalletQuotaSignalScore,
  hasQuotaCandidateMarketSupport,
  isQuotaCandidateMetadataBlind,
  resolveQuotaAssistLevel,
  sortWalletQuotaSignals,
  shouldAllowAlphaQuotaCandidate,
  shouldAllowQuotaWalletWithoutExtraMarketSupport,
  shouldBypassCooldownForQuotaAssist,
  shouldSuppressQuotaAssistForQuietRegime,
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
  assert.equal(
    shouldBypassCooldownForQuotaAssist({ quotaAssist: true, quotaAssistLevel: 2, sourceLane: 'wallet', strikeCount: 0, lossStreakActive: true }),
    false,
  );
});

test('shouldSuppressQuotaAssistForQuietRegime only trips when quota pressure has no executable wallet or GMGN follow support', () => {
  assert.equal(
    shouldSuppressQuotaAssistForQuietRegime({ quotaAssistLevel: 2, executableWalletBuyCount: 0, gmgnFollowCount: 0 }),
    true,
  );
  assert.equal(
    shouldSuppressQuotaAssistForQuietRegime({ quotaAssistLevel: 2, executableWalletBuyCount: 1, gmgnFollowCount: 0 }),
    false,
  );
  assert.equal(
    shouldSuppressQuotaAssistForQuietRegime({ quotaAssistLevel: 2, executableWalletBuyCount: 0, gmgnFollowCount: 2 }),
    false,
  );
  assert.equal(
    shouldSuppressQuotaAssistForQuietRegime({ quotaAssistLevel: 0, executableWalletBuyCount: 0, gmgnFollowCount: 0 }),
    false,
  );
});

test('quota metadata guards identify blind candidates and keep alpha quota from filling into them', () => {
  assert.equal(isQuotaCandidateMetadataBlind({ liquidityUsd: 0, marketCapUsd: 0 }), true);
  assert.equal(isQuotaCandidateMetadataBlind({ liquidityUsd: 2500, marketCapUsd: 0 }), false);
  assert.equal(hasQuotaCandidateMarketSupport({ liquidityUsd: 0, marketCapUsd: 0, volume1hUsd: 1200 }), true);
  assert.equal(hasQuotaCandidateMarketSupport({ liquidityUsd: 0, marketCapUsd: 0, volume1hUsd: 0, buys1h: 1 }), false);

  assert.equal(
    shouldAllowAlphaQuotaCandidate({
      candidate: { liquidityUsd: 0, marketCapUsd: 0, volume1hUsd: 0, buys1h: 0 },
      alphaKolCount: 0,
      signalCount: 3,
      quotaQuietRegime: false,
    }),
    false,
  );
  assert.equal(
    shouldAllowAlphaQuotaCandidate({
      candidate: { liquidityUsd: 12000, marketCapUsd: 45000, volume1hUsd: 2500, buys1h: 4 },
      alphaKolCount: 0,
      signalCount: 2,
      quotaQuietRegime: false,
    }),
    true,
  );
  assert.equal(
    shouldAllowAlphaQuotaCandidate({
      candidate: { liquidityUsd: 12000, marketCapUsd: 45000, volume1hUsd: 2500, buys1h: 4 },
      alphaKolCount: 0,
      signalCount: 2,
      quotaQuietRegime: true,
    }),
    false,
  );
  assert.equal(
    shouldAllowAlphaQuotaCandidate({
      candidate: { liquidityUsd: 12000, marketCapUsd: 45000, volume1hUsd: 2500, buys1h: 4 },
      alphaKolCount: 1,
      signalCount: 1,
      quotaQuietRegime: true,
    }),
    true,
  );
  assert.equal(
    shouldAllowAlphaQuotaCandidate({
      candidate: { liquidityUsd: 0, marketCapUsd: 0, volume1hUsd: 0, buys1h: 0 },
      alphaKolCount: 1,
      signalCount: 2,
      quotaQuietRegime: false,
      replayBacked: true,
      walletSignal: {
        executable: true,
        walletCount: 2,
        wallets: ['a', 'b'],
        sizeUp: true,
        consensusScore: 0.84,
        walletWeightedScore: 0.81,
        walletPnlScore: 0.74,
        priority: 'HIGH',
      },
    }),
    true,
  );
  assert.equal(
    shouldAllowAlphaQuotaCandidate({
      candidate: { liquidityUsd: 0, marketCapUsd: 0, volume1hUsd: 0, buys1h: 0 },
      alphaKolCount: 1,
      signalCount: 2,
      quotaQuietRegime: false,
      replayBacked: false,
      walletSignal: {
        executable: true,
        walletCount: 2,
        wallets: ['a', 'b'],
        sizeUp: true,
        consensusScore: 0.84,
        walletWeightedScore: 0.81,
        walletPnlScore: 0.74,
        priority: 'HIGH',
      },
    }),
    false,
  );
});

test('shouldAllowQuotaWalletWithoutExtraMarketSupport now requires stronger wallet confirmation than a lone scalp tag', () => {
  assert.equal(
    shouldAllowQuotaWalletWithoutExtraMarketSupport({
      priority: 'SCALP',
      walletCount: 1,
      sizeUp: false,
      kolConfirmed: false,
      consensusScore: 0.61,
      walletWeightedScore: 0.58,
    }),
    false,
  );
  assert.equal(
    shouldAllowQuotaWalletWithoutExtraMarketSupport({
      priority: 'HIGH',
      walletCount: 2,
      sizeUp: true,
      kolConfirmed: false,
      consensusScore: 0.83,
      walletWeightedScore: 0.79,
    }),
    true,
  );
});
