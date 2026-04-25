const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeSignalWeight,
  computeAllWeights,
  computeWeightedScore,
  extractImpressions,
  ALL_SIGNAL_SOURCES,
} = require('./signal_weight_tracker.ts');

// ── computeSignalWeight (Laplace smoothing) ────────────────────────────────

test('computeSignalWeight: zero data returns 0.5 (equal prior)', () => {
  const w = computeSignalWeight(0, 0);
  assert.ok(Math.abs(w - 0.5) < 0.001);
});

test('computeSignalWeight: 100% accuracy small sample is tempered toward 0.857', () => {
  // (5+1)/(5+2) = 0.857
  const w = computeSignalWeight(5, 5);
  assert.ok(Math.abs(w - 0.857) < 0.01);
});

test('computeSignalWeight: 0% accuracy small sample is tempered toward 0.143', () => {
  // (0+1)/(5+2) = 0.143
  const w = computeSignalWeight(0, 5);
  assert.ok(Math.abs(w - 0.143) < 0.01);
});

test('computeSignalWeight: large sample converges to true accuracy', () => {
  // 700/1000 → (701)/(1002) ≈ 0.6996
  const w = computeSignalWeight(700, 1000);
  assert.ok(Math.abs(w - 0.7) < 0.01);
});

// ── computeAllWeights ──────────────────────────────────────────────────────

test('computeAllWeights: empty impressions gives all 0.5 weights', () => {
  const result = computeAllWeights([]);
  for (const src of ALL_SIGNAL_SOURCES) {
    assert.ok(Math.abs(result.weights[src].weight - 0.5) < 0.001);
    assert.equal(result.weights[src].total, 0);
  }
});

test('computeAllWeights: weights reflect accuracy per source', () => {
  const impressions = [
    { source: 'velocity', mint: 'a', signalTs: Date.now(), correct: true },
    { source: 'velocity', mint: 'b', signalTs: Date.now(), correct: true },
    { source: 'velocity', mint: 'c', signalTs: Date.now(), correct: false },
    { source: 'wallet', mint: 'a', signalTs: Date.now(), correct: false },
    { source: 'wallet', mint: 'b', signalTs: Date.now(), correct: false },
    { source: 'wallet', mint: 'c', signalTs: Date.now(), correct: false },
  ];
  const result = computeAllWeights(impressions);

  // velocity: 2/3 correct → (2+1)/(3+2) = 0.6
  assert.ok(Math.abs(result.weights.velocity.weight - 0.6) < 0.01);
  // wallet: 0/3 correct → (0+1)/(3+2) = 0.2
  assert.ok(Math.abs(result.weights.wallet.weight - 0.2) < 0.01);
  // catalyst: no data → 0.5
  assert.ok(Math.abs(result.weights.catalyst.weight - 0.5) < 0.01);
});

test('computeAllWeights: old impressions outside window are excluded', () => {
  const old = Date.now() - 25 * 60 * 60 * 1000;
  const impressions = [
    { source: 'velocity', mint: 'a', signalTs: old, correct: true },
    { source: 'velocity', mint: 'b', signalTs: Date.now(), correct: false },
  ];
  const result = computeAllWeights(impressions, 24 * 60 * 60 * 1000);

  // Only the recent one: 0 correct / 1 total → (0+1)/(1+2) = 0.333
  assert.ok(Math.abs(result.weights.velocity.weight - 0.333) < 0.01);
});

// ── computeWeightedScore ───────────────────────────────────────────────────

test('computeWeightedScore: equal weights returns simple average', () => {
  const weights = {};
  for (const src of ALL_SIGNAL_SOURCES) {
    weights[src] = { source: src, correct: 0, total: 0, weight: 0.5, accuracy: 0 };
  }
  const result = computeWeightedScore({ velocity: 0.8, wallet: 0.6 }, weights);
  // (0.5*0.8 + 0.5*0.6) / (0.5+0.5) = 0.7
  assert.ok(Math.abs(result.score - 0.7) < 0.01);
});

test('computeWeightedScore: higher weight signal dominates', () => {
  const weights = {};
  for (const src of ALL_SIGNAL_SOURCES) {
    weights[src] = { source: src, correct: 0, total: 0, weight: 0.2, accuracy: 0 };
  }
  weights.velocity.weight = 0.9;
  weights.wallet.weight = 0.1;

  const result = computeWeightedScore({ velocity: 1.0, wallet: 0.0 }, weights);
  // (0.9*1.0 + 0.1*0.0) / (0.9+0.1) = 0.9
  assert.ok(Math.abs(result.score - 0.9) < 0.01);
});

test('computeWeightedScore: missing signals are skipped', () => {
  const weights = {};
  for (const src of ALL_SIGNAL_SOURCES) {
    weights[src] = { source: src, correct: 0, total: 0, weight: 0.5, accuracy: 0 };
  }
  const result = computeWeightedScore({ velocity: 0.8 }, weights);
  assert.ok(Math.abs(result.score - 0.8) < 0.01);
});

test('computeWeightedScore: score is clamped to [0, 1]', () => {
  const weights = {};
  for (const src of ALL_SIGNAL_SOURCES) {
    weights[src] = { source: src, correct: 0, total: 0, weight: 0.5, accuracy: 0 };
  }
  const result = computeWeightedScore({ velocity: 1.5 }, weights);
  assert.ok(result.score <= 1.0);
});

// ── extractImpressions ─────────────────────────────────────────────────────

test('extractImpressions: extracts velocity impressions', () => {
  const trades = [
    { mint: 'abc', entryMode: 'velocity', pnlPct: 5.0, entryTs: Date.now() },
  ];
  const imps = extractImpressions(trades);
  assert.equal(imps.length, 1);
  assert.equal(imps[0].source, 'velocity');
  assert.equal(imps[0].correct, true);
});

test('extractImpressions: extracts multiple signal types from one trade', () => {
  const trades = [{
    mint: 'abc',
    entryMode: 'velocity',
    entrySource: 'gmgn-bridge',
    walletSignal: true,
    catalystBoost: 0.15,
    pnlPct: -2.0,
    entryTs: Date.now(),
  }];
  const imps = extractImpressions(trades);
  assert.equal(imps.filter(i => i.source === 'velocity').length, 1);
  assert.equal(imps.filter(i => i.source === 'wallet').length, 1);
  assert.equal(imps.filter(i => i.source === 'catalyst').length, 1);
  assert.equal(imps.filter(i => i.source === 'gmgn').length, 1);
  assert.ok(imps.every(i => i.correct === false));
});

test('extractImpressions: skips trades without mint or pnl', () => {
  const trades = [{ pnlPct: 5 }, { mint: 'abc' }];
  assert.equal(extractImpressions(trades).length, 0);
});
