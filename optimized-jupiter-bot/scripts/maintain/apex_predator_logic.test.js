const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveVolumeTrend,
  evaluateApexEntry,
  evaluateApexExit,
} = require('./apex_predator_logic.ts');

test('evaluateApexEntry marks high-conviction manipulated runners as tradable', () => {
  const result = evaluateApexEntry({
    rugCheckSafe: true,
    marketCapUsd: 310000,
    volume5mUsd: 24000,
    volume1hUsd: 210000,
    volume6hUsd: 930000,
    momentum5mPct: 14,
    momentum1hPct: 27,
    tokenAgeSec: 5400,
    holderCount: 140,
    top10Pct: 4.4,
    smartMoneyBuys: 3,
    smartMoneySells: 1,
    followInflowUsd5m: 900,
    followTrades5m: 5,
    followUniqueWallets5m: 3,
    followFullPositionOpens5m: 2,
  });

  assert.equal(result.shouldEnter, true);
  assert.equal(result.redFlagCount, 4);
  assert.equal(result.flags.suspiciousEvenDistribution, true);
  assert.equal(result.flags.botActivityDetected, true);
  assert.equal(result.flags.volumeConsistency, true);
  assert.equal(result.flags.anomalousHolderGrowth, true);
  assert.equal(result.metrics.volumeTrend, 'increasing');
  assert.ok(result.convictionScore >= 80);
});

test('evaluateApexEntry stays conservative when confluence and crime signals are weak', () => {
  const result = evaluateApexEntry({
    rugCheckSafe: true,
    marketCapUsd: 180000,
    volume5mUsd: 5000,
    volume1hUsd: 42000,
    momentum5mPct: 3,
    momentum1hPct: -8,
    tokenAgeSec: 18000,
    holderCount: 24,
    top10Pct: 21,
    smartMoneyBuys: 0,
    smartMoneySells: 1,
    followInflowUsd5m: 0,
    followTrades5m: 0,
  });

  assert.equal(result.passesInitialScreen, false);
  assert.equal(result.passesMomentumConfluence, false);
  assert.equal(result.shouldEnter, false);
  assert.equal(result.supportsAggressiveOverlay, false);
  assert.ok(result.redFlagCount <= 1);
});

test('evaluateApexEntry only grants aggressive overlay when bot activity confirms the move', () => {
  const withoutBots = evaluateApexEntry({
    rugCheckSafe: true,
    marketCapUsd: 260000,
    volume5mUsd: 16000,
    volume1hUsd: 150000,
    volume6hUsd: 720000,
    momentum5mPct: 9,
    momentum1hPct: 18,
    tokenAgeSec: 4200,
    holderCount: 105,
    top10Pct: 4.8,
    smartMoneyBuys: 0,
    smartMoneySells: 0,
    followInflowUsd5m: 0,
    followTrades5m: 0,
  });
  assert.equal(withoutBots.flags.suspiciousEvenDistribution, true);
  assert.equal(withoutBots.flags.volumeConsistency, true);
  assert.equal(withoutBots.supportsAggressiveOverlay, false);

  const withBots = evaluateApexEntry({
    ...{
      rugCheckSafe: true,
      marketCapUsd: 260000,
      volume5mUsd: 16000,
      volume1hUsd: 150000,
      volume6hUsd: 720000,
      momentum5mPct: 9,
      momentum1hPct: 18,
      tokenAgeSec: 4200,
      holderCount: 105,
      top10Pct: 4.8,
    },
    smartMoneyBuys: 2,
    smartMoneySells: 0,
    followInflowUsd5m: 800,
    followTrades5m: 4,
  });
  assert.equal(withBots.flags.botActivityDetected, true);
  assert.equal(withBots.supportsAggressiveOverlay, true);
});

test('deriveVolumeTrend detects fading participation', () => {
  assert.equal(
    deriveVolumeTrend({
      volume5mUsd: 2000,
      volume1hUsd: 90000,
      volume6hUsd: 900000,
    }),
    'declining',
  );
});

test('evaluateApexExit triggers thin-air liquidity exits for unsupported million-dollar runs', () => {
  const result = evaluateApexExit({
    entryLiquidityUsd: 45000,
    currentLiquidityUsd: 90000,
    marketCapUsd: 4200000,
    priceChangeSinceEntryPct: 46,
    volume5mUsd: 30000,
    volume1hUsd: 280000,
    smartMoneyBuys: 1,
    smartMoneySells: 0,
    followInflowUsd5m: 50,
  });

  assert.equal(result.shouldExit, true);
  assert.equal(result.primaryReason, 'thin_air_liquidity');
  assert.equal(result.flags.thinAirLiquidity, true);
  assert.ok(result.metrics.requiredLiquidityUsd > 90000);
});

test('evaluateApexExit catches momentum exhaustion from volume divergence and smart-money exits', () => {
  const divergence = evaluateApexExit({
    entryLiquidityUsd: 50000,
    currentLiquidityUsd: 260000,
    marketCapUsd: 1600000,
    priceChangeSinceEntryPct: 18,
    volume5mUsd: 2500,
    volume1hUsd: 120000,
    volume6hUsd: 1050000,
    smartMoneyBuys: 1,
    smartMoneySells: 0,
    followInflowUsd5m: 220,
  });
  assert.equal(divergence.shouldExit, true);
  assert.equal(divergence.primaryReason, 'volume_divergence');

  const exodus = evaluateApexExit({
    entryLiquidityUsd: 50000,
    currentLiquidityUsd: 260000,
    marketCapUsd: 1600000,
    priceChangeSinceEntryPct: 6,
    volume5mUsd: 14000,
    volume1hUsd: 110000,
    volume6hUsd: 540000,
    smartMoneyBuys: 2,
    smartMoneySells: 5,
    followInflowUsd5m: 0,
  });
  assert.equal(exodus.shouldExit, true);
  assert.equal(exodus.primaryReason, 'smart_money_exodus');
});
