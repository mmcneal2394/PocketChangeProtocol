const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveReplayBackedStrategyProfile,
  evaluateReplayBackedRouteLiveOverride,
  evaluateReplayBackedRecoveryProbe,
} = require('./replay_gate_logic.ts');

test('resolveReplayBackedStrategyProfile activates only for profitable promoted replay profiles', () => {
  const active = resolveReplayBackedStrategyProfile({
    fitness: 0.18,
    simulated_psr: 3.4,
    simulated_pnl: 0.12,
    recommended_filters: {
      min_5m_change: 1,
      min_volume_5m: 0,
      min_liquidity_usd: 20000,
    },
  });
  const inactive = resolveReplayBackedStrategyProfile({
    fitness: 0,
    simulated_psr: 0.8,
    simulated_pnl: -0.02,
    recommended_filters: {
      min_5m_change: 1,
    },
  });

  assert.equal(active.active, true);
  assert.equal(active.min5mChange, 1);
  assert.equal(inactive.active, false);
});

test('evaluateReplayBackedRouteLiveOverride unlocks continuation only for strong replay-aligned route-live flow', () => {
  const allowed = evaluateReplayBackedRouteLiveOverride({
    slopfestParams: {
      fitness: 0.18,
      simulated_psr: 3.4,
      simulated_pnl: 0.12,
      recommended_filters: { min_5m_change: 1, min_volume_5m: 0 },
    },
    routeLive: true,
    continuationReady: false,
    missingMomentum1m: true,
    priceChange5m: 2.1,
    liquidityUsd: 3200,
    buys60s: 9,
    buyRatio60s: 0.84,
    velocity: 8,
    solVolume60s: 1.4,
    probeLikeFlowReady: true,
  });
  const blocked = evaluateReplayBackedRouteLiveOverride({
    slopfestParams: {
      fitness: 0.18,
      simulated_psr: 3.4,
      simulated_pnl: 0.12,
      recommended_filters: { min_5m_change: 1, min_volume_5m: 0 },
    },
    routeLive: true,
    continuationReady: false,
    missingMomentum1m: true,
    priceChange5m: 0.2,
    liquidityUsd: 3200,
    buys60s: 3,
    buyRatio60s: 0.58,
    velocity: 2,
    solVolume60s: 0.2,
    probeLikeFlowReady: false,
  });

  assert.equal(allowed.allowContinuationOverride, true);
  assert.equal(allowed.allowLowLiquidityColdStreakOverride, true);
  assert.equal(blocked.allowContinuationOverride, false);
  assert.equal(blocked.allowLowLiquidityColdStreakOverride, false);
});

test('evaluateReplayBackedRecoveryProbe allows one empty-book recovery probe on a timer for strong replay-shaped flow', () => {
  const allowed = evaluateReplayBackedRecoveryProbe({
    slopfestParams: {
      fitness: 0.18,
      simulated_psr: 3.4,
      simulated_pnl: 0.12,
      recommended_filters: { min_5m_change: 1, min_volume_5m: 0 },
    },
    routeLive: true,
    priceChange5m: 0.1,
    liquidityUsd: 3200,
    buys60s: 7,
    buyRatio60s: 0.74,
    velocity: 7,
    solVolume60s: 1.1,
    probeLikeFlowReady: true,
    openPositionCount: 0,
    consecutiveLosses: 6,
    lastProbeAtMs: 0,
    nowMs: 2_000_000,
  });
  const coolingDown = evaluateReplayBackedRecoveryProbe({
    slopfestParams: {
      fitness: 0.18,
      simulated_psr: 3.4,
      simulated_pnl: 0.12,
      recommended_filters: { min_5m_change: 1, min_volume_5m: 0 },
    },
    routeLive: true,
    priceChange5m: 0.1,
    liquidityUsd: 3200,
    buys60s: 7,
    buyRatio60s: 0.74,
    velocity: 7,
    solVolume60s: 1.1,
    probeLikeFlowReady: true,
    openPositionCount: 0,
    consecutiveLosses: 6,
    lastProbeAtMs: 1_500_000,
    nowMs: 2_000_000,
  });

  assert.equal(allowed.allow, true);
  assert.equal(allowed.windowMs, 20 * 60_000);
  assert.equal(coolingDown.allow, false);
});
