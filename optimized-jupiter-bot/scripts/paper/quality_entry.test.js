const { test } = require('node:test');
const assert = require('node:assert/strict');
const { qualityIssues, supportPattern, accelerationPattern, convictionPattern, flowMomentumPattern, confirmFollowThrough, selectEntryPattern, executionIssues, closedCandles, staleCandleHistory } = require('./quality_entry');
const { POLICY } = require('./quality_entry');
const now = 1800000000000;
function candles() {
  return Array.from({ length: 90 }, (_, i) => {
    const base = i < 20 ? 110 : i < 30 ? 125 : i < 50 ? 115 : 106;
    return { time: now / 1000 - (90 - i) * 60, open: base,
      high: i === 25 ? 130 : i === 89 ? 111 : base + 2,
      low: i === 60 || i === 84 ? 100 : i === 61 ? 101 : i === 89 ? 102 : base - 1,
      close: i === 89 ? 110 : base + 1 };
  });
}
function evidence() { return { pool: 'pool', ageSeconds: 21600, liquidityUsd: 7000, holderCount: 300,
  migration: { status: 1, migratedPool: 'pool' }, concentration: { top10: .2 }, flow: { volume1mUsd: 1000, volume5mUsd: 5000, swaps1m: 5, buys1m: 3, sells1m: 2 }, reserves: { quoteSol: 100 } }; }
test('quality floors admit complete evidence and reject missing, weak, concentrated tokens', () => {
  assert.deepEqual(qualityIssues(evidence()), []);
  for (const key of ['ageSeconds', 'liquidityUsd', 'holderCount']) {
    for (const value of [null, NaN, 0]) assert.ok(qualityIssues({ ...evidence(), [key]: value }).length);
  }
  const e = evidence(); e.concentration.top10 = .31; e.flow.sells1m = 0;
  assert.equal(qualityIssues(e).length, 2);
});
test('high concentration requires a current confirmed supply-control profile', () => {
  const e = evidence(); e.concentration.top10 = .66;
  e.supplyControl = { accountVerification: 'confirmed_rpc', monitoredControllerRatio: .58, unattributedTop10Ratio: .07,
    maxSingleUnattributedRatio: .025, controllerMovementSincePreviousRatio: 0, missingRequiredControllers: [],
    profile: { active: true, admission: { maxRawTop10Ratio: .7, minMonitoredControllerRatio: .55,
      maxUnattributedTop10Ratio: .08, maxSingleUnattributedRatio: .03, maxControllerOutflowPerObservationRatio: .02,
      minLiquidityUsd: 7000, minHolders: 100, minVolume24hUsd: 1000 } } };
  e.flow.windows = { '24h': { volumeUsd: 5000 } };
  assert.deepEqual(qualityIssues(e), []);
  e.supplyControl.accountVerification = 'unavailable';
  assert.ok(qualityIssues(e).includes('quality_holder_concentration'));
});
test('both fresh-launch and retrace lanes use the 100-holder minimum', () => {
  const retrace = evidence(); retrace.holderCount = 100;
  assert.deepEqual(qualityIssues(retrace, 'retrace'), []);
  const fresh = evidence(); fresh.holderCount = 100; fresh.ageSeconds = 600; fresh.migration = { status: 0, migratedPool: null };
  fresh.flow = { volume1mUsd: 2500, volume5mUsd: 10000, swaps1m: 12, buys1m: 8, sells1m: 4 };
  assert.deepEqual(qualityIssues(fresh, 'acceleration'), []);
  fresh.holderCount = 99;
  assert.ok(qualityIssues(fresh, 'acceleration').includes('quality_holderCount_below_100'));
});
test('the discovery screen reports shared floors without asserting the retrace gate', () => {
  // A young, unmigrated candidate that clears every lane-agnostic floor must not be
  // labeled migration-blocked before a lane is chosen.
  const fresh = evidence();
  fresh.ageSeconds = 600;
  fresh.migration = { status: 0, migratedPool: null };
  assert.deepEqual(qualityIssues(fresh, 'discovery'), []);
  assert.ok(qualityIssues(fresh, 'retrace').includes('quality_migration_unconfirmed'));
  fresh.holderCount = 99;
  assert.ok(qualityIssues(fresh, 'discovery').includes('quality_holderCount_below_100'));
});
test('migrated floor retrace with bullish reclaim passes regardless of response order', () => {
  assert.equal(supportPattern(candles(), now).floorUsd, 100);
  assert.deepEqual(supportPattern(candles().reverse(), now), supportPattern(candles(), now));
});
test('missing, stale, duplicate, gapped, malformed and future history cannot admit', () => {
  assert.throws(() => supportPattern(null, now), /missing/);
  assert.throws(() => supportPattern(candles().slice(1), now), /insufficient/);
  assert.throws(() => supportPattern(candles(), now + 60000), /stale/);
  const duplicate = candles(); duplicate[1] = duplicate[0];
  assert.throws(() => supportPattern(duplicate, now), /duplicate/);
  for (const field of ['open', 'high', 'low', 'close']) {
    const bad = candles(); bad[2][field] = null;
    assert.throws(() => supportPattern(bad, now), /invalid/);
  }
  const future = candles(); future[89].time = now / 1000 + 60;
  assert.throws(() => supportPattern(future, now), /invalid/);
});
test('an isolated missing provider minute is tolerated when the 90-candle window stays recent', () => {
  const gapped = candles();
  for (let i = 0; i < 45; i++) gapped[i].time -= 60;
  const pattern = supportPattern(gapped, now);
  assert.equal(pattern.count, 90);
  assert.equal(pattern.floorUsd, 100);
});
test('history that is too old to fit the recent window is rejected', () => {
  const stale = candles();
  stale[0].time -= 32 * 60;
  assert.throws(() => supportPattern(stale, now), /span_exceeded/);
});
test('unfinished candles never confirm a bounce', () => {
  const c = candles(); c[89].time = now / 1000;
  assert.throws(() => supportPattern(c, now), /insufficient/);
});
test('floor breakdown, missing retest, unconfirmed reclaim, extended price and volatility reject', () => {
  let c = candles(); c[70].low = 90;
  assert.throws(() => supportPattern(c, now), /broken/);
  c = candles(); c[84].low = 105;
  assert.throws(() => supportPattern(c, now), /retested/);
  c = candles(); c[89].close = 106;
  assert.throws(() => supportPattern(c, now), /unconfirmed/);
  c = candles(); c[89].close = 115; c[89].high = 116;
  assert.throws(() => supportPattern(c, now), /extended/);
  c = candles(); c[3].high = 140;
  assert.throws(() => supportPattern(c, now), /range/);
});
test('migration and one-hour age are mandatory', () => {
  const e = evidence(); e.ageSeconds = 3600;
  assert.deepEqual(qualityIssues(e), []);
  e.ageSeconds = 3599;
  assert.ok(qualityIssues(e).includes('quality_ageSeconds_below_3600'));
  e.ageSeconds = 3600;
  e.migration.migratedPool = null;
  assert.ok(qualityIssues(e).includes('quality_migration_unconfirmed'));
  e.migration.migratedPool = 'different-pool';
  assert.ok(qualityIssues(e).includes('quality_migrated_pool_mismatch'));
});
test('acceleration lane accepts bonded or pre-bond tokens but keeps stronger flow gates', () => {
  const e = evidence();
  e.ageSeconds = 600;
  e.migration = { status: 0, migratedPool: null };
  e.flow = { volume1mUsd: 2500, volume5mUsd: 10000, swaps1m: 12, buys1m: 8, sells1m: 4 };
  assert.deepEqual(qualityIssues(e, 'acceleration'), []);
  e.flow.buys1m = 7;
  assert.ok(qualityIssues(e, 'acceleration').some(issue => issue.startsWith('acceleration_')));
});
test('acceleration accepts strong dollar-weighted buying when trade counts are mixed', () => {
  const e = evidence();
  e.ageSeconds = 600;
  e.migration = { status: 0, migratedPool: null };
  e.flow = { volume1mUsd: 3000, volume5mUsd: 12000, swaps1m: 20, buys1m: 9, sells1m: 11,
    windows: { '1m': { volumeUsd: 3000, buyVolumeUsd: 2400, sellVolumeUsd: 600 } } };
  assert.deepEqual(qualityIssues(e, 'acceleration'), []);
  e.flow.windows['1m'] = { volumeUsd: 3000, buyVolumeUsd: 1500, sellVolumeUsd: 1500 };
  assert.ok(qualityIssues(e, 'acceleration').includes('acceleration_order_flow_below_threshold'));
});
test('acceleration volume floors match the global 1000/5000 thresholds', () => {
  const e = evidence();
  e.ageSeconds = 600;
  e.migration = { status: 0, migratedPool: null };
  e.flow = { volume1mUsd: 1100, volume5mUsd: 5500, swaps1m: 12, buys1m: 8, sells1m: 4 };
  assert.deepEqual(qualityIssues(e, 'acceleration'), []);
  e.flow.volume1mUsd = 900;
  assert.ok(qualityIssues(e, 'acceleration').includes('acceleration_volume1mUsd_below_1000'));
  e.flow.volume1mUsd = 1100; e.flow.volume5mUsd = 4900;
  assert.ok(qualityIssues(e, 'acceleration').includes('acceleration_volume5mUsd_below_5000'));
});
test('short-window acceleration requires sustained gains near the local high', () => {
  const c = candles().slice(-6);
  c.forEach((row, i) => Object.assign(row, { open: 100 + i, low: 99 + i, high: 102 + i, close: 101 + i }));
  assert.equal(accelerationPattern(c, now).regime, 'acceleration');
  Object.assign(c.at(-1), { open: 105, low: 99, high: 107, close: 100 });
  assert.throws(() => accelerationPattern(c, now), /acceleration_/);
});
test('fresh acceleration does not require the retrace lane 90-candle history', () => {
  const c = candles().slice(-6);
  c.forEach((row, i) => Object.assign(row, { open: 100 + i, low: 99 + i, high: 102 + i, close: 101 + i }));
  const fresh = evidence();
  fresh.ageSeconds = 600;
  fresh.migration = { status: 0, migratedPool: null };
  const selected = selectEntryPattern(fresh, c, now);
  assert.equal(selected.entryLane, 'acceleration');
  assert.equal(selected.pattern.count, 6);
});
function convictionEvidence() {
  const e = evidence();
  e.ageSeconds = 86400;
  e.liquidityUsd = 2000000;
  e.holderCount = 120000;
  e.flow = { volume1mUsd: 5000, volume5mUsd: 12000, swaps1m: 10, buys1m: 6, sells1m: 4,
    windows: {
      '1m': { priceUsd: 1.01, volumeUsd: 5000, buyVolumeUsd: 3000 },
      '5m': { priceUsd: 1.00, volumeUsd: 12000, buyVolumeUsd: 6500 },
      '1h': { priceUsd: 0.995, volumeUsd: 150000, buyVolumeUsd: 80000 },
      '24h': { priceUsd: 0.90, volumeUsd: 6000000, buyVolumeUsd: 3200000 },
    } };
  return e;
}
test('mature liquid conviction lane can act when candle history is incomplete', () => {
  const e = convictionEvidence();
  const pattern = convictionPattern(e, now);
  assert.equal(pattern.regime, 'conviction');
  assert.ok(pattern.score >= 75);
  const selected = selectEntryPattern(e, [], now);
  assert.equal(selected.entryLane, 'conviction');
  e.pattern = selected.pattern;
  assert.deepEqual(qualityIssues(e, 'conviction'), []);
});
test('conviction lane rejects weak buy pressure, fading momentum, and shallow markets', () => {
  let e = convictionEvidence(); e.flow.windows['1m'].buyVolumeUsd = 2000;
  assert.throws(() => convictionPattern(e, now), /buy_pressure/);
  e = convictionEvidence(); e.flow.windows['1m'].priceUsd = .99;
  assert.throws(() => convictionPattern(e, now), /momentum/);
  e = convictionEvidence(); e.liquidityUsd = 100000;
  assert.throws(() => convictionPattern(e, now), /liquidity/);
});
function flowMomentumEvidence() {
  const e = evidence();
  e.ageSeconds = 600;
  e.migration = { status: 0, migratedPool: null };
  e.flow = { volume1mUsd: 2500, volume5mUsd: 10000, swaps1m: 20, buys1m: 13, sells1m: 7,
    windows: {
      '1m': { priceUsd: 1.02, volumeUsd: 2500, buyVolumeUsd: 1800, sellVolumeUsd: 700 },
      '5m': { priceUsd: 1.00, volumeUsd: 10000, buyVolumeUsd: 6000, sellVolumeUsd: 4000 },
    } };
  return e;
}
test('flow_momentum stands down unless the price holds the signal level', () => {
  const e = flowMomentumEvidence();
  const signal = flowMomentumPattern(e, now);
  // Before the follow-through delay elapses the check is not due.
  assert.equal(confirmFollowThrough(signal, e, now + 5000), null);
  // Price below the signal after the delay -> stand down.
  const dropped = { ...e, flow: { ...e.flow, windows: { ...e.flow.windows, '1m': { ...e.flow.windows['1m'], priceUsd: 1.00 } } } };
  assert.throws(() => confirmFollowThrough(signal, dropped, now + 25000), /follow_through_price_lost/);
  // Price holding or extending the level -> confirmed, carrying the fresh price.
  const held = { ...e, flow: { ...e.flow, windows: { ...e.flow.windows, '1m': { ...e.flow.windows['1m'], priceUsd: 1.03 } } } };
  const ok = confirmFollowThrough(signal, held, now + 25000);
  assert.equal(ok.followThroughPriceUsd, 1.03);
  assert.ok(ok.followThroughMs >= POLICY.minFlowMomentumFollowThroughMs);
});
test('flow-only momentum lane admits an actively-traded token with no candle history', () => {
  const e = flowMomentumEvidence();
  const pattern = flowMomentumPattern(e, now);
  assert.equal(pattern.regime, 'flow_momentum');
  assert.ok(pattern.momentumPct >= .01);
  const selected = selectEntryPattern(e, [], now);
  assert.equal(selected.entryLane, 'flow_momentum');
  e.pattern = selected.pattern; e.entryLane = 'flow_momentum';
  assert.deepEqual(qualityIssues(e, 'flow_momentum'), []);
  assert.deepEqual(selectEntryPattern(e, null, now).entryLane, 'flow_momentum');
});
test('flow-only momentum lane rejects flat momentum, thin flow and weak buy pressure', () => {
  let e = flowMomentumEvidence(); e.flow.windows['1m'].priceUsd = 1.00;
  assert.throws(() => flowMomentumPattern(e, now), /gain_below_threshold/);
  e = flowMomentumEvidence(); e.flow.volume5mUsd = 4000; e.flow.windows['5m'].volumeUsd = 4000;
  assert.throws(() => flowMomentumPattern(e, now), /turnover_below_threshold/);
  e = flowMomentumEvidence(); e.flow.swaps1m = 10; e.flow.buys1m = 6; e.flow.sells1m = 4;
  assert.throws(() => flowMomentumPattern(e, now), /swaps_below_threshold/);
  e = flowMomentumEvidence();
  e.flow.buys1m = 11; e.flow.sells1m = 9;
  e.flow.windows['1m'] = { priceUsd: 1.02, volumeUsd: 2500, buyVolumeUsd: 1000, sellVolumeUsd: 1500 };
  assert.throws(() => flowMomentumPattern(e, now), /order_flow_below_threshold/);
});
test('flow-only momentum lane keeps the shared age, liquidity and concentration floors', () => {
  let e = flowMomentumEvidence(); e.ageSeconds = 599;
  assert.ok(qualityIssues(e, 'flow_momentum').includes('quality_ageSeconds_below_600'));
  e = flowMomentumEvidence(); e.liquidityUsd = 6999;
  assert.ok(qualityIssues(e, 'flow_momentum').includes('quality_liquidityUsd_below_7000'));
  e = flowMomentumEvidence(); e.concentration.top10 = .31;
  assert.ok(qualityIssues(e, 'flow_momentum').includes('quality_holder_concentration'));
  e = flowMomentumEvidence(); e.flow.windows['1m'].priceUsd = null;
  assert.ok(qualityIssues(e, 'flow_momentum').includes('flow_momentum_prices_unavailable'));
});
test('the flow-only lane never preempts the retrace or conviction lanes', () => {
  const retrace = qualityIssues(evidence());
  assert.deepEqual(retrace, []);
  assert.equal(selectEntryPattern(evidence(), candles(), now).entryLane, 'retrace');
  const mature = convictionEvidence();
  assert.equal(selectEntryPattern(mature, [], now).entryLane, 'conviction');
  // A mature token that also clears the flow floors still resolves to conviction.
  mature.flow.volume1mUsd = 2500; mature.flow.volume5mUsd = 10000; mature.flow.swaps1m = 20; mature.flow.buys1m = 13;
  mature.flow.windows['1m'] = { priceUsd: 1.02, volumeUsd: 2500, buyVolumeUsd: 1800, sellVolumeUsd: 700 };
  assert.equal(selectEntryPattern(mature, [], now).entryLane, 'conviction');
});
test('stale candle windows stop vetoing the candle-free flow lane', () => {
  const nowMs = now;
  const stale = candles().map(c => ({ ...c, time: c.time - 300 })); // newest bar 5 min old
  assert.equal(staleCandleHistory(stale, nowMs), true);
  assert.equal(staleCandleHistory(candles(), nowMs), false);
  assert.equal(staleCandleHistory([], nowMs), false);
  const e = flowMomentumEvidence();
  // With a freshly-closed window and no flow, no lane matches.
  const flat = { ...e, flow: { ...e.flow, volume1mUsd: 0, volume5mUsd: 0, swaps1m: 0, buys1m: 0, sells1m: 0,
    windows: { '1m': { priceUsd: 1.02, volumeUsd: 0 }, '5m': { priceUsd: 1.00, volumeUsd: 0 } } } };
  assert.throws(() => selectEntryPattern(flat, stale, nowMs));
  // With live flow, the stale window no longer blocks: flow_momentum confirms it.
  const selected = selectEntryPattern(flowMomentumEvidence(), stale, nowMs);
  assert.equal(selected.entryLane, 'flow_momentum');
});
test('deep retraces remain eligible only with stronger continuing flow', () => {
  const deep = candles();
  for (let i = 0; i < 30; i++) Object.assign(deep[i], { open: 490, high: i === 25 ? 510 : 500, low: 480, close: 495 });
  const pattern = supportPattern(deep, now);
  assert.equal(pattern.regime, 'deep_retrace');
  assert.ok(pattern.postHypeDrawdownPct >= .60 && pattern.postHypeDrawdownPct <= .85);
  const e = { ...evidence(), pattern };
  assert.ok(qualityIssues(e).some(x => x.startsWith('deep_retrace_volume5mUsd')));
  assert.ok(qualityIssues(e).some(x => x.startsWith('deep_retrace_swaps1m')));
  e.flow.volume5mUsd = 10000; e.flow.swaps1m = 8;
  assert.deepEqual(qualityIssues(e), []);
});
test('net round-trip costs and reserve exposure cap are enforced', () => {
  assert.deepEqual(executionIssues(evidence(), .05, .049, 100), []);
  assert.ok(executionIssues(evidence(), .05, .045, 100).length);
  assert.ok(executionIssues({ reserves: { quoteSol: 1 } }, .05, .049, 100).length);
  assert.ok(executionIssues({}, .05, NaN, 100).length);
});
