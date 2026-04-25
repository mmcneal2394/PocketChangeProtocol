const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ingestTerrainObservation,
  evaluateTerrainGuard,
  evaluateTerrainPreflightGuard,
} = require('./terrain_memory_logic.ts');

const config = {
  enabled: true,
  lookbackSeconds: 180,
  minSamplesForDecision: 2,
  minSamplesForFlowDecayDecision: 3,
  minSamplesForWarn: 2,
  minSamplesForBlock: 3,
  minStrongFlowSamples: 2,
  minStrongFlowBuys60s: 10,
  minStrongFlowSolVolume60s: 2,
  minStrongFlowVelocity: 8,
  flatPrice5mPct: 1.5,
  minRouteStrengthPct: 1.5,
  minRouteStrengthPctToIgnoreFlowDecay: 45,
  minLiquidityDeltaUsdToIgnoreFlowDecay: 1000,
  maxFlowDecayRatioForHold: 0.72,
  maxFlowDecayRatioForBlock: 0.55,
  minPriceOffPeak5mPctForHold: 6,
  minPriceOffPeak5mPctForBlock: 10,
  maxLiquidityUsdForDecisionHold: 1000,
  maxLiquidityUsdForPreflightHold: 5000,
  liveDumpHardFloorPct: -8,
  overboughtHardCeilingPct: 45,
  routeLiveOverboughtHardCeilingPct: 250,
  cooldownConfirmSeconds: 8,
  cooldownWarnSeconds: 60,
  cooldownBlockSeconds: 600,
};

test('holds first route-live zero-liquidity micro scout for a second terrain sample', () => {
  const state = ingestTerrainObservation(null, {
    ts: 1_000,
    symbol: 'TEST',
    priceChange5m: 0,
    liquidityUsd: 0,
    buys60s: 14,
    solVolume60s: 3.2,
    velocity: 12,
    routeLive: true,
    routeOutAmount: 100_000,
  }, config);

  const guard = evaluateTerrainGuard(state, {
    entryMode: 'normal',
    probeLike: true,
    liquidityUsd: 0,
    routeLive: true,
  }, config);

  assert.equal(guard.shouldHold, true);
  assert.equal(guard.code, 'terrain_confirmation_pending');
});

test('treats route-live 8-buy probes as strong-flow samples for later terrain decisions', () => {
  let state = null;
  state = ingestTerrainObservation(state, {
    ts: 1_000,
    symbol: 'TEST',
    priceChange5m: 0.4,
    liquidityUsd: 0,
    buys60s: 8,
    solVolume60s: 3.3,
    velocity: 10,
    routeLive: true,
    routeOutAmount: 100_000,
  }, config);
  state = ingestTerrainObservation(state, {
    ts: 8_000,
    symbol: 'TEST',
    priceChange5m: 0.5,
    liquidityUsd: 0,
    buys60s: 8,
    solVolume60s: 3.1,
    velocity: 10,
    routeLive: true,
    routeOutAmount: 99_850,
  }, config);

  assert.equal(state.summary.strongFlowSamples, 2);
});

test('blocks repeated strong-flow samples with flat route response', () => {
  let state = null;
  state = ingestTerrainObservation(state, {
    ts: 1_000,
    symbol: 'TEST',
    priceChange5m: 0.2,
    liquidityUsd: 0,
    buys60s: 14,
    solVolume60s: 3,
    velocity: 12,
    routeLive: true,
    routeOutAmount: 100_000,
  }, config);
  state = ingestTerrainObservation(state, {
    ts: 7_000,
    symbol: 'TEST',
    priceChange5m: 0.3,
    liquidityUsd: 0,
    buys60s: 15,
    solVolume60s: 3.1,
    velocity: 12,
    routeLive: true,
    routeOutAmount: 99_800,
  }, config);
  state = ingestTerrainObservation(state, {
    ts: 14_000,
    symbol: 'TEST',
    priceChange5m: 0.1,
    liquidityUsd: 0,
    buys60s: 16,
    solVolume60s: 3.4,
    velocity: 13,
    routeLive: true,
    routeOutAmount: 99_700,
  }, config);

  const guard = evaluateTerrainGuard(state, {
    entryMode: 'micro-scout',
    liquidityUsd: 0,
    routeLive: true,
  }, config);

  assert.equal(guard.shouldBlock, true);
  assert.equal(guard.code, 'terrain_flat_response_blocked');
});

test('allows strong-flow route-live candidates when route strength improves meaningfully', () => {
  let state = null;
  state = ingestTerrainObservation(state, {
    ts: 1_000,
    symbol: 'TEST',
    priceChange5m: 0.5,
    liquidityUsd: 0,
    buys60s: 12,
    solVolume60s: 2.5,
    velocity: 10,
    routeLive: true,
    routeOutAmount: 100_000,
  }, config);
  state = ingestTerrainObservation(state, {
    ts: 8_000,
    symbol: 'TEST',
    priceChange5m: 1.2,
    liquidityUsd: 0,
    buys60s: 13,
    solVolume60s: 2.8,
    velocity: 11,
    routeLive: true,
    routeOutAmount: 97_500,
  }, config);

  const guard = evaluateTerrainGuard(state, {
    entryMode: 'micro-scout',
    liquidityUsd: 0,
    routeLive: true,
  }, config);

  assert.equal(guard.shouldHold, false);
  assert.equal(guard.shouldWarn, false);
  assert.equal(guard.shouldBlock, false);
});

test('holds probe-like entry when flow has clearly decayed from the local peak and price is off the high', () => {
  let state = null;
  state = ingestTerrainObservation(state, {
    ts: 1_000,
    symbol: 'TEST',
    priceChange5m: 14,
    liquidityUsd: 0,
    buys60s: 12,
    solVolume60s: 3.5,
    velocity: 10,
    routeLive: true,
    routeOutAmount: 100_000,
  }, config);
  state = ingestTerrainObservation(state, {
    ts: 6_000,
    symbol: 'TEST',
    priceChange5m: 22,
    liquidityUsd: 0,
    buys60s: 18,
    solVolume60s: 5.8,
    velocity: 16,
    routeLive: true,
    routeOutAmount: 96_000,
  }, config);
  state = ingestTerrainObservation(state, {
    ts: 11_000,
    symbol: 'TEST',
    priceChange5m: 15,
    liquidityUsd: 0,
    buys60s: 10,
    solVolume60s: 2.6,
    velocity: 9,
    routeLive: true,
    routeOutAmount: 95_600,
  }, config);

  const guard = evaluateTerrainGuard(state, {
    entryMode: 'micro-scout',
    liquidityUsd: 0,
    routeLive: true,
  }, config);

  assert.equal(guard.shouldHold, true);
  assert.equal(guard.code, 'terrain_flow_decay_hold');
});

test('blocks probe-like entry when flow collapses from peak and price is materially off the high', () => {
  let state = null;
  state = ingestTerrainObservation(state, {
    ts: 1_000,
    symbol: 'TEST',
    priceChange5m: 18,
    liquidityUsd: 0,
    buys60s: 14,
    solVolume60s: 4.0,
    velocity: 11,
    routeLive: true,
    routeOutAmount: 100_000,
  }, config);
  state = ingestTerrainObservation(state, {
    ts: 7_000,
    symbol: 'TEST',
    priceChange5m: 31,
    liquidityUsd: 0,
    buys60s: 22,
    solVolume60s: 6.4,
    velocity: 18,
    routeLive: true,
    routeOutAmount: 95_000,
  }, config);
  state = ingestTerrainObservation(state, {
    ts: 14_000,
    symbol: 'TEST',
    priceChange5m: 17,
    liquidityUsd: 0,
    buys60s: 7,
    solVolume60s: 1.9,
    velocity: 7,
    routeLive: true,
    routeOutAmount: 94_700,
  }, config);

  const guard = evaluateTerrainGuard(state, {
    entryMode: 'micro-scout',
    liquidityUsd: 0,
    routeLive: true,
  }, config);

  assert.equal(guard.shouldBlock, true);
  assert.equal(guard.code, 'terrain_flow_decay_blocked');
});

test('allows flow cooldown when price stays near the high and route strength remains exceptional', () => {
  let state = null;
  state = ingestTerrainObservation(state, {
    ts: 1_000,
    symbol: 'TEST',
    priceChange5m: 20,
    liquidityUsd: 0,
    buys60s: 15,
    solVolume60s: 4.0,
    velocity: 12,
    routeLive: true,
    routeOutAmount: 100_000,
  }, config);
  state = ingestTerrainObservation(state, {
    ts: 7_000,
    symbol: 'TEST',
    priceChange5m: 32,
    liquidityUsd: 0,
    buys60s: 20,
    solVolume60s: 6.0,
    velocity: 16,
    routeLive: true,
    routeOutAmount: 60_000,
  }, config);
  state = ingestTerrainObservation(state, {
    ts: 14_000,
    symbol: 'TEST',
    priceChange5m: 29,
    liquidityUsd: 0,
    buys60s: 11,
    solVolume60s: 2.9,
    velocity: 9,
    routeLive: true,
    routeOutAmount: 52_000,
  }, config);

  const guard = evaluateTerrainGuard(state, {
    entryMode: 'micro-scout',
    liquidityUsd: 0,
    routeLive: true,
  }, config);

  assert.equal(guard.shouldHold, false);
  assert.equal(guard.shouldWarn, false);
  assert.equal(guard.shouldBlock, false);
});

test('holds first moderate route-live live-dump snapshot for terrain confirmation', () => {
  const state = ingestTerrainObservation(null, {
    ts: 1_000,
    symbol: 'TEST',
    priceChange5m: -3.6,
    liquidityUsd: 1200,
    buys60s: 11,
    solVolume60s: 3.4,
    velocity: 10,
    routeLive: true,
    routeOutAmount: 100_000,
  }, config);

  const guard = evaluateTerrainPreflightGuard(state, {
    kind: 'live_dump',
    priceChange5m: -3.6,
    liquidityUsd: 1200,
    buys60s: 11,
    solVolume60s: 3.4,
    velocity: 10,
    routeLive: true,
  }, config);

  assert.equal(guard.shouldHold, true);
  assert.equal(guard.code, 'terrain_live_dump_confirmation_pending');
});

test('allows route-live live-dump candidate after terrain shows recovery', () => {
  let state = null;
  state = ingestTerrainObservation(state, {
    ts: 1_000,
    symbol: 'TEST',
    priceChange5m: -4.2,
    liquidityUsd: 900,
    buys60s: 10,
    solVolume60s: 3.0,
    velocity: 9,
    routeLive: true,
    routeOutAmount: 100_000,
  }, config);
  state = ingestTerrainObservation(state, {
    ts: 7_000,
    symbol: 'TEST',
    priceChange5m: -2.4,
    liquidityUsd: 1100,
    buys60s: 10,
    solVolume60s: 3.1,
    velocity: 9,
    routeLive: true,
    routeOutAmount: 97_000,
  }, config);

  const guard = evaluateTerrainPreflightGuard(state, {
    kind: 'live_dump',
    priceChange5m: -2.4,
    liquidityUsd: 1100,
    buys60s: 10,
    solVolume60s: 3.1,
    velocity: 9,
    routeLive: true,
  }, config);

  assert.equal(guard.shouldAllow, true);
  assert.equal(guard.code, 'terrain_live_dump_recovered');
});

test('holds first moderate route-live overbought snapshot for terrain confirmation', () => {
  const state = ingestTerrainObservation(null, {
    ts: 1_000,
    symbol: 'TEST',
    priceChange5m: 28,
    liquidityUsd: 1800,
    buys60s: 12,
    solVolume60s: 3.8,
    velocity: 10,
    routeLive: true,
    routeOutAmount: 100_000,
  }, config);

  const guard = evaluateTerrainPreflightGuard(state, {
    kind: 'overbought',
    overboughtBaseCeilingPct: 25,
    priceChange5m: 28,
    liquidityUsd: 1800,
    buys60s: 12,
    solVolume60s: 3.8,
    velocity: 10,
    routeLive: true,
  }, config);

  assert.equal(guard.shouldHold, true);
  assert.equal(guard.code, 'terrain_overbought_confirmation_pending');
});

test('allows route-live overbought candidate when route and price stay strong', () => {
  let state = null;
  state = ingestTerrainObservation(state, {
    ts: 1_000,
    symbol: 'TEST',
    priceChange5m: 27,
    liquidityUsd: 1600,
    buys60s: 12,
    solVolume60s: 3.2,
    velocity: 10,
    routeLive: true,
    routeOutAmount: 100_000,
  }, config);
  state = ingestTerrainObservation(state, {
    ts: 6_000,
    symbol: 'TEST',
    priceChange5m: 31,
    liquidityUsd: 2200,
    buys60s: 13,
    solVolume60s: 3.4,
    velocity: 11,
    routeLive: true,
    routeOutAmount: 97_800,
  }, config);

  const guard = evaluateTerrainPreflightGuard(state, {
    kind: 'overbought',
    overboughtBaseCeilingPct: 25,
    priceChange5m: 31,
    liquidityUsd: 2200,
    buys60s: 13,
    solVolume60s: 3.4,
    velocity: 11,
    routeLive: true,
  }, config);

  assert.equal(guard.shouldAllow, true);
  assert.equal(guard.code, 'terrain_overbought_sustained');
});

test('holds route-live overbought candidate above the normal hard ceiling when it is still within the route-live ceiling', () => {
  let state = null;
  state = ingestTerrainObservation(state, {
    ts: 1_000,
    symbol: 'TEST',
    priceChange5m: 180,
    liquidityUsd: 2200,
    buys60s: 14,
    solVolume60s: 7.2,
    velocity: 24,
    routeLive: true,
    routeOutAmount: 100_000,
  }, config);

  const guard = evaluateTerrainPreflightGuard(state, {
    kind: 'overbought',
    overboughtBaseCeilingPct: 150,
    priceChange5m: 180,
    liquidityUsd: 2200,
    buys60s: 14,
    solVolume60s: 7.2,
    velocity: 24,
    routeLive: true,
  }, {
    ...config,
    overboughtHardCeilingPct: 45,
    routeLiveOverboughtHardCeilingPct: 250,
  });

  assert.equal(guard.shouldHold, true);
  assert.equal(guard.code, 'terrain_overbought_confirmation_pending');
});

test('still blocks route-live overbought candidate above the route-live hard ceiling', () => {
  let state = null;
  state = ingestTerrainObservation(state, {
    ts: 1_000,
    symbol: 'TEST',
    priceChange5m: 280,
    liquidityUsd: 2200,
    buys60s: 14,
    solVolume60s: 7.2,
    velocity: 24,
    routeLive: true,
    routeOutAmount: 100_000,
  }, config);

  const guard = evaluateTerrainPreflightGuard(state, {
    kind: 'overbought',
    overboughtBaseCeilingPct: 150,
    priceChange5m: 280,
    liquidityUsd: 2200,
    buys60s: 14,
    solVolume60s: 7.2,
    velocity: 24,
    routeLive: true,
  }, {
    ...config,
    overboughtHardCeilingPct: 45,
    routeLiveOverboughtHardCeilingPct: 250,
  });

  assert.equal(guard.shouldHold, false);
  assert.equal(guard.shouldAllow, false);
  assert.equal(guard.code, null);
});
