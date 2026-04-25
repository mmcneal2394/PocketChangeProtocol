const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeRawKelly,
  computeKellySize,
  computeWinLossRatio,
  computeSyntheticAtrPct,
} = require('./kelly_sizing_logic.ts');

// ── computeRawKelly ────────────────────────────────────────────────────────

test('computeRawKelly: 50/50 with even odds = zero edge', () => {
  // f* = (0.5 × 1 - 0.5) / 1 = 0
  assert.ok(Math.abs(computeRawKelly(0.5, 1.0)) < 0.001);
});

test('computeRawKelly: 60% win rate with 1:1 = 0.2 edge', () => {
  // f* = (0.6 × 1 - 0.4) / 1 = 0.2
  assert.ok(Math.abs(computeRawKelly(0.6, 1.0) - 0.2) < 0.001);
});

test('computeRawKelly: 40% win rate with 2:1 = positive edge', () => {
  // f* = (0.4 × 2 - 0.6) / 2 = 0.1
  assert.ok(Math.abs(computeRawKelly(0.4, 2.0) - 0.1) < 0.001);
});

test('computeRawKelly: 30% win rate 1:1 = negative (no edge)', () => {
  assert.ok(computeRawKelly(0.3, 1.0) < 0);
});

test('computeRawKelly: zero win/loss ratio returns 0', () => {
  assert.equal(computeRawKelly(0.5, 0), 0);
});

// ── computeKellySize ───────────────────────────────────────────────────────

test('computeKellySize: no edge skips trade', () => {
  const result = computeKellySize({
    winProbability: 0.3, winLossRatio: 1.0,
    bankrollSol: 2.0, atrPct: 5.0,
  });
  assert.equal(result.skipTrade, true);
  assert.equal(result.sizeSol, 0);
});

test('computeKellySize: strong edge produces reasonable size under cap', () => {
  const result = computeKellySize({
    winProbability: 0.65, winLossRatio: 1.5,
    bankrollSol: 2.0, atrPct: 5.0, reserveSol: 0.05,
  });
  assert.equal(result.skipTrade, false);
  assert.ok(result.sizeSol > 0);
  assert.ok(result.sizeSol <= 0.05);
});

test('computeKellySize: high ATR reduces position size', () => {
  const lowVol = computeKellySize({
    winProbability: 0.6, winLossRatio: 1.5,
    bankrollSol: 2.0, atrPct: 3.0,
  });
  const highVol = computeKellySize({
    winProbability: 0.6, winLossRatio: 1.5,
    bankrollSol: 2.0, atrPct: 10.0,
  });
  assert.ok(lowVol.sizeSol >= highVol.sizeSol);
});

test('computeKellySize: regime multiplier scales size', () => {
  const normal = computeKellySize({
    winProbability: 0.6, winLossRatio: 1.5,
    bankrollSol: 2.0, atrPct: 5.0, regimeMultiplier: 1.0,
  });
  const cautious = computeKellySize({
    winProbability: 0.6, winLossRatio: 1.5,
    bankrollSol: 2.0, atrPct: 5.0, regimeMultiplier: 0.5,
  });
  assert.ok(normal.sizeSol >= cautious.sizeSol);
});

test('computeKellySize: reward asymmetry factor scales size around the same edge', () => {
  const neutral = computeKellySize({
    winProbability: 0.6, winLossRatio: 1.5,
    bankrollSol: 2.0, atrPct: 5.0, rewardAsymmetryFactor: 0,
    maxSizeSol: 0.5,
  });
  const aggressive = computeKellySize({
    winProbability: 0.6, winLossRatio: 1.5,
    bankrollSol: 2.0, atrPct: 5.0, rewardAsymmetryFactor: 0.2,
    maxSizeSol: 0.5,
  });
  const defensive = computeKellySize({
    winProbability: 0.6, winLossRatio: 1.5,
    bankrollSol: 2.0, atrPct: 5.0, rewardAsymmetryFactor: -0.2,
    maxSizeSol: 0.5,
  });

  assert.ok(aggressive.adjustedKellyFraction > neutral.adjustedKellyFraction);
  assert.ok(defensive.adjustedKellyFraction < neutral.adjustedKellyFraction);
});

test('computeKellySize: never exceeds maxSizeSol', () => {
  const result = computeKellySize({
    winProbability: 0.95, winLossRatio: 5.0,
    bankrollSol: 100, atrPct: 1.0, maxSizeSol: 0.05,
  });
  assert.ok(result.sizeSol <= 0.05);
});

test('computeKellySize: zero bankroll skips', () => {
  const result = computeKellySize({
    winProbability: 0.7, winLossRatio: 2.0,
    bankrollSol: 0, atrPct: 5.0,
  });
  assert.equal(result.skipTrade, true);
});

// ── computeWinLossRatio ────────────────────────────────────────────────────

test('computeWinLossRatio: even wins/losses returns ~1', () => {
  const trades = [
    { pnlPct: 5 }, { pnlPct: -5 }, { pnlPct: 10 }, { pnlPct: -10 },
    { pnlPct: 8 }, { pnlPct: -8 }, { pnlPct: 3 }, { pnlPct: -3 },
    { pnlPct: 6 }, { pnlPct: -6 },
  ];
  assert.ok(Math.abs(computeWinLossRatio(trades) - 1.0) < 0.1);
});

test('computeWinLossRatio: bigger wins gives ratio > 1', () => {
  const trades = [
    { pnlPct: 20 }, { pnlPct: -5 }, { pnlPct: 15 }, { pnlPct: -3 },
    { pnlPct: 25 }, { pnlPct: -4 }, { pnlPct: 18 }, { pnlPct: -6 },
    { pnlPct: 22 }, { pnlPct: -5 },
  ];
  assert.ok(computeWinLossRatio(trades) > 1);
});

test('computeWinLossRatio: insufficient data returns 1.0', () => {
  assert.equal(computeWinLossRatio([{ pnlPct: 5 }]), 1.0);
});

// ── computeSyntheticAtrPct ─────────────────────────────────────────────────

test('computeSyntheticAtrPct: stable prices give low ATR', () => {
  const changes = [0.1, -0.1, 0.2, -0.2, 0.1, -0.1, 0.15];
  assert.ok(computeSyntheticAtrPct(changes) < 1.0);
});

test('computeSyntheticAtrPct: volatile prices give high ATR', () => {
  const changes = [15, -20, 25, -10, 30, -15, 20];
  assert.ok(computeSyntheticAtrPct(changes) > 5);
});

test('computeSyntheticAtrPct: insufficient data returns default 5%', () => {
  assert.equal(computeSyntheticAtrPct([]), 5.0);
  assert.equal(computeSyntheticAtrPct([1]), 5.0);
});
