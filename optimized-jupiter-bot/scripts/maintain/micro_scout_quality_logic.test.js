const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeMicroScoutQualityConfig,
  evaluateMicroScoutQualityGate,
} = require('./micro_scout_quality_logic.ts');

test('holds micro probe when route quality is still unknown and samples are shallow', () => {
  const config = normalizeMicroScoutQualityConfig({});
  const result = evaluateMicroScoutQualityGate({
    entryMode: 'micro-scout',
    probeLike: true,
    momentum5mPct: 0,
    routeStrengthPct: null,
    sampleCount: 1,
  }, config);
  assert.equal(result.shouldHold, true);
  assert.equal(result.code, 'micro_scout_quality_wait');
});

test('allows micro probe when an upstream route-live fast-track already validated the entry', () => {
  const config = normalizeMicroScoutQualityConfig({});
  const result = evaluateMicroScoutQualityGate({
    entryMode: 'micro-scout',
    probeLike: true,
    fastTrackApproved: true,
    momentum5mPct: 44,
    routeStrengthPct: null,
    sampleCount: 1,
  }, config);
  assert.equal(result.allowEntry, true);
  assert.equal(result.code, 'micro_scout_quality_fast_track');
});

test('allows strong route-strength micro probe after enough samples', () => {
  const config = normalizeMicroScoutQualityConfig({});
  const result = evaluateMicroScoutQualityGate({
    entryMode: 'micro-scout',
    probeLike: true,
    momentum5mPct: 0,
    routeStrengthPct: 47.5,
    sampleCount: 6,
  }, config);
  assert.equal(result.allowEntry, true);
});

test('holds promising route-strength probe until sample floor is met', () => {
  const config = normalizeMicroScoutQualityConfig({});
  const result = evaluateMicroScoutQualityGate({
    entryMode: 'micro-scout',
    probeLike: true,
    momentum5mPct: 0,
    routeStrengthPct: 53,
    sampleCount: 4,
  }, config);
  assert.equal(result.shouldHold, true);
  assert.equal(result.code, 'micro_scout_quality_wait');
});

test('allows momentum-window probe with adequate route strength and samples', () => {
  const config = normalizeMicroScoutQualityConfig({});
  const result = evaluateMicroScoutQualityGate({
    entryMode: 'micro-scout',
    probeLike: true,
    momentum5mPct: 84.9,
    routeStrengthPct: 16.2,
    sampleCount: 4,
  }, config);
  assert.equal(result.allowEntry, true);
});

test('allows extended high-momentum probe only with strong route confirmation and deep samples', () => {
  const config = normalizeMicroScoutQualityConfig({});
  const result = evaluateMicroScoutQualityGate({
    entryMode: 'micro-scout',
    probeLike: true,
    momentum5mPct: 124,
    routeStrengthPct: 24,
    sampleCount: 9,
  }, config);
  assert.equal(result.allowEntry, true);
});

test('holds shallow late probe while waiting for one more terrain confirmation', () => {
  const config = normalizeMicroScoutQualityConfig({});
  const result = evaluateMicroScoutQualityGate({
    entryMode: 'micro-scout',
    probeLike: true,
    momentum5mPct: 54,
    routeStrengthPct: 18,
    sampleCount: 3,
    priceDelta5mPct: -12,
    priceOffPeak5mPct: 24,
    strongFlowSamples: 1,
  }, config);
  assert.equal(result.shouldHold, true);
  assert.equal(result.code, 'micro_scout_quality_wait');
});

test('blocks late probe when price has rolled over and route recovery is not strong enough', () => {
  const config = normalizeMicroScoutQualityConfig({});
  const result = evaluateMicroScoutQualityGate({
    entryMode: 'micro-scout',
    probeLike: true,
    momentum5mPct: 53.17,
    routeStrengthPct: 17.9,
    sampleCount: 5,
    priceDelta5mPct: -42.6,
    priceOffPeak5mPct: 42.6,
    strongFlowSamples: 0,
  }, config);
  assert.equal(result.shouldBlock, true);
  assert.equal(result.code, 'micro_scout_quality_late_entry');
});

test('allows late probe only when route recovery is genuinely strong and repeated', () => {
  const config = normalizeMicroScoutQualityConfig({});
  const result = evaluateMicroScoutQualityGate({
    entryMode: 'micro-scout',
    probeLike: true,
    momentum5mPct: 82,
    routeStrengthPct: 52,
    sampleCount: 6,
    priceDelta5mPct: -4,
    priceOffPeak5mPct: 22,
    strongFlowSamples: 3,
  }, config);
  assert.equal(result.allowEntry, true);
});

test('holds shallow weak-route probe with promising momentum instead of blocking immediately', () => {
  const config = normalizeMicroScoutQualityConfig({});
  const result = evaluateMicroScoutQualityGate({
    entryMode: 'micro-scout',
    probeLike: true,
    momentum5mPct: 88,
    routeStrengthPct: 0,
    sampleCount: 2,
  }, config);
  assert.equal(result.shouldHold, true);
  assert.equal(result.code, 'micro_scout_quality_wait');
});

test('blocks weak-route micro probe even when traffic is loud', () => {
  const config = normalizeMicroScoutQualityConfig({});
  const result = evaluateMicroScoutQualityGate({
    entryMode: 'micro-scout',
    probeLike: true,
    momentum5mPct: 48.1,
    routeStrengthPct: 4.3,
    sampleCount: 4,
  }, config);
  assert.equal(result.shouldBlock, true);
  assert.equal(result.code, 'micro_scout_quality_route_weak');
});

test('allows early weak-route probe when price response is already real and still near peak', () => {
  const config = normalizeMicroScoutQualityConfig({});
  const result = evaluateMicroScoutQualityGate({
    entryMode: 'micro-scout',
    probeLike: true,
    momentum5mPct: 20.8,
    routeStrengthPct: 0,
    sampleCount: 4,
    priceDelta5mPct: 20.8,
    priceOffPeak5mPct: 0,
  }, config);
  assert.equal(result.allowEntry, true);
});

test('allows route-live continuation probe when current momentum is intact near peak', () => {
  const config = normalizeMicroScoutQualityConfig({});
  const result = evaluateMicroScoutQualityGate({
    entryMode: 'micro-scout',
    probeLike: true,
    routeLive: true,
    momentum5mPct: 18.7,
    routeStrengthPct: null,
    sampleCount: 2,
    priceDelta5mPct: -0.9,
    priceOffPeak5mPct: 0.9,
  }, config);
  assert.equal(result.allowEntry, true);
});

test('holds instead of blocking when route quality probe is rate-limited', () => {
  const config = normalizeMicroScoutQualityConfig({});
  const result = evaluateMicroScoutQualityGate({
    entryMode: 'micro-scout',
    probeLike: true,
    routeProbeRateLimited: true,
    momentum5mPct: 18.7,
    routeStrengthPct: null,
    sampleCount: 5,
  }, config);
  assert.equal(result.shouldHold, true);
  assert.equal(result.code, 'micro_scout_quality_wait');
});

test('does not classify tiny near-peak drift as late-entry rollover', () => {
  const config = normalizeMicroScoutQualityConfig({});
  const result = evaluateMicroScoutQualityGate({
    entryMode: 'micro-scout',
    probeLike: true,
    momentum5mPct: 15.9,
    routeStrengthPct: null,
    sampleCount: 4,
    priceDelta5mPct: -0.04,
    priceOffPeak5mPct: 0.04,
  }, config);
  assert.notEqual(result.code, 'micro_scout_quality_late_entry');
});

test('still blocks weak-route probe when price response is rolling off despite enough samples', () => {
  const config = normalizeMicroScoutQualityConfig({});
  const result = evaluateMicroScoutQualityGate({
    entryMode: 'micro-scout',
    probeLike: true,
    momentum5mPct: 20.8,
    routeStrengthPct: 0,
    sampleCount: 4,
    priceDelta5mPct: 6,
    priceOffPeak5mPct: 7,
  }, config);
  assert.equal(result.shouldBlock, true);
  assert.equal(result.code, 'micro_scout_quality_route_weak');
});

test('blocks weak-route momentum probe once the shallow hold window has expired', () => {
  const config = normalizeMicroScoutQualityConfig({});
  const result = evaluateMicroScoutQualityGate({
    entryMode: 'micro-scout',
    probeLike: true,
    momentum5mPct: 88,
    routeStrengthPct: 0,
    sampleCount: 4,
  }, config);
  assert.equal(result.shouldBlock, true);
  assert.equal(result.code, 'micro_scout_quality_route_weak');
});

test('blocks overextended momentum outside validated entry window', () => {
  const config = normalizeMicroScoutQualityConfig({});
  const result = evaluateMicroScoutQualityGate({
    entryMode: 'micro-scout',
    probeLike: true,
    momentum5mPct: 130,
    routeStrengthPct: 20.4,
    sampleCount: 4,
  }, config);
  assert.equal(result.shouldBlock, true);
  assert.equal(result.code, 'micro_scout_quality_momentum');
});

test('does not apply to non-probe entries', () => {
  const config = normalizeMicroScoutQualityConfig({});
  const result = evaluateMicroScoutQualityGate({
    entryMode: 'normal',
    probeLike: false,
    momentum5mPct: 0,
    routeStrengthPct: null,
    sampleCount: 0,
  }, config);
  assert.equal(result.allowEntry, true);
});
