const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeCopyabilityRisk,
  derivePrimaryWalletStyle,
  derivePreferredHoldMs,
  computeWalletWeightedScore,
} = require('./wallet_intel_logic.ts');

test('computeCopyabilityRisk separates lower, medium, and high risk tag groups', () => {
  assert.equal(computeCopyabilityRisk(['smart_degen']), 'lower');
  assert.equal(computeCopyabilityRisk(['kol', 'gmgn']), 'medium');
  assert.equal(computeCopyabilityRisk(['sandwich_bot']), 'high');
});

test('derivePrimaryWalletStyle distinguishes scalp and swing styles', () => {
  assert.equal(
    derivePrimaryWalletStyle({
      wallet: 'scalp',
      d30: { trades: 20_000, avgHoldingPeriodSec: 900 },
      d7: { trades: 6_000 },
    }),
    'SCALP',
  );
  assert.equal(
    derivePrimaryWalletStyle({
      wallet: 'swing',
      d30: { trades: 800, avgHoldingPeriodSec: 8 * 60 * 60 },
      d7: { trades: 120 },
    }),
    'SWING',
  );
});

test('derivePreferredHoldMs clamps by style profile', () => {
  assert.equal(
    derivePreferredHoldMs({
      wallet: 'flow',
      d30: { trades: 7_500, avgHoldingPeriodSec: 25 * 60 },
      d7: { trades: 1_500 },
    }),
    2 * 60_000,
  );
  assert.equal(
    derivePreferredHoldMs({
      wallet: 'swing',
      d30: { trades: 900, avgHoldingPeriodSec: 9 * 60 * 60 },
      d7: { trades: 150 },
    }),
    15 * 60_000,
  );
});

test('computeWalletWeightedScore penalizes high-risk tags and rewards consistent clean performance', () => {
  const clean = computeWalletWeightedScore({
    wallet: 'clean',
    tags: ['smart_degen'],
    d30: { trades: 12_000, winrate: 0.82, realizedProfitUsd: 22_000, avgHoldingPeriodSec: 3600 },
    d7: { trades: 2_600, realizedProfitUsd: 4_400 },
  });
  const bot = computeWalletWeightedScore({
    wallet: 'bot',
    tags: ['sandwich_bot'],
    d30: { trades: 120_000, winrate: 0.80, realizedProfitUsd: 30_000, avgHoldingPeriodSec: 300 },
    d7: { trades: 25_000, realizedProfitUsd: 6_000 },
  });

  assert.equal(clean.copyabilityRisk, 'lower');
  assert.equal(bot.copyabilityRisk, 'high');
  assert.ok(clean.weightedScore > bot.weightedScore);
  assert.equal(bot.executable, false);
});
