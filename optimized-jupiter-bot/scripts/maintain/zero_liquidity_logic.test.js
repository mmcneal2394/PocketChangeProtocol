const test = require('node:test');
const assert = require('node:assert/strict');

const {
  planZeroLiquidityRecheck,
  normalizeRouteLiveZeroLiquidityConfig,
  evaluateRouteLiveZeroLiquidityEntry,
} = require('./zero_liquidity_logic.ts');

test('planZeroLiquidityRecheck fast-rechecks strong clean flow', () => {
  const plan = planZeroLiquidityRecheck({
    buys60s: 9,
    buyRatio60s: 1,
    velocity: 9,
    solVolume60s: 3.8,
  });

  assert.equal(plan.cooldownSec, 10);
  assert.equal(plan.fastRecheck, true);
});

test('planZeroLiquidityRecheck gives moderate flow a shorter retry window', () => {
  const plan = planZeroLiquidityRecheck({
    buys60s: 8,
    buyRatio60s: 0.85,
    velocity: 8,
    solVolume60s: 1.2,
  });

  assert.equal(plan.cooldownSec, 20);
  assert.equal(plan.fastRecheck, false);
});

test('planZeroLiquidityRecheck keeps weak flow on the longer cooldown', () => {
  const plan = planZeroLiquidityRecheck({
    buys60s: 4,
    buyRatio60s: 0.6,
    velocity: 4,
    solVolume60s: 0.4,
  });

  assert.equal(plan.cooldownSec, 45);
  assert.equal(plan.fastRecheck, false);
});

test('planZeroLiquidityRecheck escalates repeated stale zero-liq samples', () => {
  const plan = planZeroLiquidityRecheck({
    buys60s: 12,
    buyRatio60s: 1,
    velocity: 9,
    solVolume60s: 3.8,
    tokenAgeSec: 900,
    terrainSummary: {
      sampleCount: 2,
      liquidityDeltaUsd: 0,
      routeStrengthPct: 0,
      priceDelta5m: 0,
    },
  });

  assert.equal(plan.cooldownSec, 20);
  assert.equal(plan.fastRecheck, false);
});

test('planZeroLiquidityRecheck jumps to long cooldown after repeated stale samples', () => {
  const plan = planZeroLiquidityRecheck({
    buys60s: 12,
    buyRatio60s: 1,
    velocity: 9,
    solVolume60s: 3.8,
    terrainSummary: {
      sampleCount: 3,
      liquidityDeltaUsd: 0,
      routeStrengthPct: 0,
      priceDelta5m: 0,
    },
  });

  assert.equal(plan.cooldownSec, 300);
  assert.equal(plan.fastRecheck, false);
});

test('evaluateRouteLiveZeroLiquidityEntry holds first route-live zero-liq sample', () => {
  const decision = evaluateRouteLiveZeroLiquidityEntry(
    {
      priceChange5m: 0,
      terrainSummary: {
        sampleCount: 1,
        liquidityDeltaUsd: 0,
        routeStrengthPct: 0,
        priceDelta5m: 0,
      },
    },
    normalizeRouteLiveZeroLiquidityConfig({}),
  );

  assert.equal(decision.shouldHold, true);
  assert.equal(decision.allowEntry, false);
  assert.equal(decision.cooldownSec, 6);
});

test('evaluateRouteLiveZeroLiquidityEntry fast-tracks exceptional first-sample route-live burst', () => {
  const decision = evaluateRouteLiveZeroLiquidityEntry(
    {
      priceChange5m: 44,
      priceChange1h: 0,
      tokenAgeSec: 8 * 60,
      buys60s: 12,
      buyRatio60s: 1,
      velocity: 11,
      solVolume60s: 6.2,
      terrainSummary: {
        sampleCount: 1,
        liquidityDeltaUsd: 0,
        routeStrengthPct: null,
        priceDelta5m: 0,
      },
    },
    normalizeRouteLiveZeroLiquidityConfig({}),
  );

  assert.equal(decision.allowEntry, true);
  assert.equal(decision.code, 'route_live_zero_liq_fast_track');
});

test('evaluateRouteLiveZeroLiquidityEntry blocks stalled route-live zero-liq path', () => {
  const decision = evaluateRouteLiveZeroLiquidityEntry(
    {
      priceChange5m: 0,
      terrainSummary: {
        sampleCount: 2,
        liquidityDeltaUsd: 0,
        routeStrengthPct: 0,
        priceDelta5m: 0,
      },
    },
    normalizeRouteLiveZeroLiquidityConfig({}),
  );

  assert.equal(decision.shouldBlock, true);
  assert.equal(decision.allowEntry, false);
  assert.equal(decision.cooldownSec, 60);
});

test('evaluateRouteLiveZeroLiquidityEntry blocks negative trend route-live probe without recovery', () => {
  const config = normalizeRouteLiveZeroLiquidityConfig({});
  const decision = evaluateRouteLiveZeroLiquidityEntry(
    {
      priceChange5m: -0.25,
      priceChange1h: -22,
      terrainSummary: {
        sampleCount: 2,
        liquidityDeltaUsd: 0,
        routeStrengthPct: 0.2,
        priceDelta5m: 0.5,
      },
    },
    config,
  );

  assert.equal(decision.shouldBlock, true);
  assert.equal(decision.code, 'route_live_zero_liq_negative_trend');
  assert.equal(decision.cooldownSec, config.repeatedCooldownSec);
});

test('evaluateRouteLiveZeroLiquidityEntry allows route-live zero-liq when route improves', () => {
  const decision = evaluateRouteLiveZeroLiquidityEntry(
    {
      priceChange5m: 0,
      terrainSummary: {
        sampleCount: 2,
        liquidityDeltaUsd: 0,
        routeStrengthPct: 2.2,
        priceDelta5m: 0,
      },
    },
    normalizeRouteLiveZeroLiquidityConfig({}),
  );

  assert.equal(decision.allowEntry, true);
  assert.equal(decision.shouldHold, false);
  assert.equal(decision.shouldBlock, false);
});

test('evaluateRouteLiveZeroLiquidityEntry does not allow price-only recovery on sparse samples', () => {
  const config = normalizeRouteLiveZeroLiquidityConfig({});
  const decision = evaluateRouteLiveZeroLiquidityEntry(
    {
      priceChange5m: 8,
      priceChange1h: 12,
      terrainSummary: {
        sampleCount: 2,
        liquidityDeltaUsd: 0,
        routeStrengthPct: 0.1,
        priceDelta5m: 3,
      },
    },
    config,
  );

  assert.equal(decision.allowEntry, false);
  assert.equal(decision.shouldBlock, true);
  assert.equal(decision.code, 'route_live_zero_liq_stalled');
});

test('evaluateRouteLiveZeroLiquidityEntry does not fast-track weaker first-sample flow', () => {
  const decision = evaluateRouteLiveZeroLiquidityEntry(
    {
      priceChange5m: 44,
      priceChange1h: 0,
      tokenAgeSec: 8 * 60,
      buys60s: 9,
      buyRatio60s: 0.88,
      velocity: 9,
      solVolume60s: 3.4,
      terrainSummary: {
        sampleCount: 1,
        liquidityDeltaUsd: 0,
        routeStrengthPct: null,
        priceDelta5m: 0,
      },
    },
    normalizeRouteLiveZeroLiquidityConfig({}),
  );

  assert.equal(decision.allowEntry, false);
  assert.equal(decision.code, 'route_live_zero_liq_confirm');
});

test('evaluateRouteLiveZeroLiquidityEntry allows price-only recovery after repeated confirmation', () => {
  const config = normalizeRouteLiveZeroLiquidityConfig({});
  const decision = evaluateRouteLiveZeroLiquidityEntry(
    {
      priceChange5m: 8,
      priceChange1h: 12,
      terrainSummary: {
        sampleCount: config.minSamplesForPriceOnlyAllow,
        liquidityDeltaUsd: 0,
        routeStrengthPct: 0.2,
        priceDelta5m: 3,
      },
    },
    config,
  );

  assert.equal(decision.allowEntry, true);
  assert.equal(decision.shouldBlock, false);
});

test('evaluateRouteLiveZeroLiquidityEntry allows terrain-confirmed price response scalp before route strength recovers', () => {
  const config = normalizeRouteLiveZeroLiquidityConfig({});
  const decision = evaluateRouteLiveZeroLiquidityEntry(
    {
      priceChange5m: 9,
      priceChange1h: -8,
      tokenAgeSec: 12 * 60,
      buys60s: 8,
      buyRatio60s: 0.64,
      velocity: 9,
      solVolume60s: 1.8,
      terrainSummary: {
        sampleCount: 2,
        liquidityDeltaUsd: 0,
        routeStrengthPct: 0.3,
        priceDelta5m: 12,
        priceOffPeak5m: 1.5,
        flowDecayRatio: 0.88,
      },
    },
    config,
  );

  assert.equal(decision.allowEntry, true);
  assert.equal(decision.code, 'route_live_zero_liq_price_response');
});

test('evaluateRouteLiveZeroLiquidityEntry still blocks rolled-over price response scalp candidates', () => {
  const config = normalizeRouteLiveZeroLiquidityConfig({});
  const decision = evaluateRouteLiveZeroLiquidityEntry(
    {
      priceChange5m: 9,
      priceChange1h: -8,
      tokenAgeSec: 12 * 60,
      buys60s: 8,
      buyRatio60s: 0.64,
      velocity: 9,
      solVolume60s: 1.8,
      terrainSummary: {
        sampleCount: 2,
        liquidityDeltaUsd: 0,
        routeStrengthPct: 0.3,
        priceDelta5m: 12,
        priceOffPeak5m: 6.5,
        flowDecayRatio: 0.52,
      },
    },
    config,
  );

  assert.equal(decision.allowEntry, false);
  assert.equal(decision.shouldBlock, true);
  assert.equal(decision.code, 'route_live_zero_liq_stalled');
});

test('evaluateRouteLiveZeroLiquidityEntry allows negative 1h name when current recovery is strong', () => {
  const config = normalizeRouteLiveZeroLiquidityConfig({});
  const decision = evaluateRouteLiveZeroLiquidityEntry(
    {
      priceChange5m: 6,
      priceChange1h: -18,
      terrainSummary: {
        sampleCount: 2,
        liquidityDeltaUsd: 0,
        routeStrengthPct: config.minRouteStrengthPct + 0.2,
        priceDelta5m: 0.5,
      },
    },
    config,
  );

  assert.equal(decision.allowEntry, true);
  assert.equal(decision.shouldBlock, false);
});
