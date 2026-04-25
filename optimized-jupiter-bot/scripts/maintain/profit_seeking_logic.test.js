const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculateProfitSeekingScore,
  computeProfitSeekingRatio,
  deriveKellyRewardAsymmetryFactor,
  summarizeProfitSeekingScores,
} = require('./profit_seeking_logic.ts');

test('calculateProfitSeekingScore rewards wins and penalizes losses asymmetrically', () => {
  assert.equal(calculateProfitSeekingScore(0.5), 25);
  assert.equal(calculateProfitSeekingScore(-0.5), -50);
  assert.equal(calculateProfitSeekingScore(0), 0);
});

test('summarizeProfitSeekingScores aggregates positive, negative, total, and PSR', () => {
  const summary = summarizeProfitSeekingScores([0.4, -0.1, 0.2]);
  assert.equal(summary.positiveScore, 20);
  assert.equal(summary.negativeScoreAbs, 2);
  assert.equal(summary.totalScore, 18);
  assert.equal(summary.profitSeekingRatio, 10);
});

test('computeProfitSeekingRatio handles lossless books safely', () => {
  assert.equal(computeProfitSeekingRatio(0, 0), 0);
  assert.equal(computeProfitSeekingRatio(5, 0), 100);
  assert.equal(computeProfitSeekingRatio(6, 3), 2);
});

test('deriveKellyRewardAsymmetryFactor rewards strong PSR and penalizes weak books', () => {
  const positive = deriveKellyRewardAsymmetryFactor({ profitSeekingRatio: 2.4, totalProfitSeekingScore: 12, tradeCount: 30 });
  const negative = deriveKellyRewardAsymmetryFactor({ profitSeekingRatio: 0.7, totalProfitSeekingScore: -8, tradeCount: 30 });
  assert.ok(positive > 0);
  assert.ok(negative < 0);
});
