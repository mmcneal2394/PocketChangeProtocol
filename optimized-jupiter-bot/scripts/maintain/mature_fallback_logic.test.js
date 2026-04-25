const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeMatureFallbackConfig,
  shouldAllowMatureFallbackCandidate,
  getMatureFallbackRejectCooldownSec,
  scoreMatureFallbackCandidate,
  shouldDeferMatureFallback,
} = require('./mature_fallback_logic.ts');

test('normalizeMatureFallbackConfig applies safe defaults', () => {
  const config = normalizeMatureFallbackConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.candidatePoolSize, 8);
  assert.equal(config.maxCandidatesPerPoll, 2);
  assert.equal(config.minCandidateBuyRatio, 1.7);
  assert.equal(config.minCandidateAgeSec, 15 * 60);
  assert.equal(config.maxCandidateAgeSec, 6 * 60 * 60);
  assert.equal(config.maxCandidateMomentum5mPct, 30);
  assert.equal(config.maxCandidateMomentum1hPct, 180);
  assert.equal(config.maxScoreMomentum5mPct, 12);
  assert.equal(config.buyRatioThresholdScale, 1);
  assert.equal(config.buyCountThresholdScale, 1);
  assert.equal(config.deferWhenEligibleVelocityCountGte, 1);
  assert.equal(config.rejectCooldownSeconds, 300);
  assert.equal(config.hydrationMissRejectCooldownSeconds, 420);
});

test('shouldAllowMatureFallbackCandidate blocks weak-ratio mature names', () => {
  const config = normalizeMatureFallbackConfig({ minCandidateBuyRatio: 1.7 });
  assert.equal(
    shouldAllowMatureFallbackCandidate({ buyRatio: 1.1, tokenAgeSec: 7200, priceChange5m: 8, priceChange1h: 60 }, config),
    false,
  );
});

test('shouldAllowMatureFallbackCandidate allows near-threshold mature names', () => {
  const config = normalizeMatureFallbackConfig({ minCandidateBuyRatio: 1.7 });
  assert.equal(
    shouldAllowMatureFallbackCandidate({ buyRatio: 1.7, tokenAgeSec: 7200, priceChange5m: 8, priceChange1h: 60 }, config),
    true,
  );
  assert.equal(
    shouldAllowMatureFallbackCandidate({ buyRatio: 1.8, tokenAgeSec: 7200, priceChange5m: 12, priceChange1h: 75 }, config),
    true,
  );
});

test('shouldAllowMatureFallbackCandidate blocks overextended or too-old names', () => {
  const config = normalizeMatureFallbackConfig({
    maxCandidateAgeSec: 4 * 60 * 60,
    maxCandidateMomentum5mPct: 25,
    maxCandidateMomentum1hPct: 140,
  });
  assert.equal(
    shouldAllowMatureFallbackCandidate({ buyRatio: 2.0, tokenAgeSec: 5 * 60 * 60, priceChange5m: 10, priceChange1h: 80 }, config),
    false,
  );
  assert.equal(
    shouldAllowMatureFallbackCandidate({ buyRatio: 2.0, tokenAgeSec: 2 * 60 * 60, priceChange5m: 40, priceChange1h: 80 }, config),
    false,
  );
  assert.equal(
    shouldAllowMatureFallbackCandidate({ buyRatio: 2.0, tokenAgeSec: 2 * 60 * 60, priceChange5m: 10, priceChange1h: 200 }, config),
    false,
  );
});

test('getMatureFallbackRejectCooldownSec uses longer cooldown after hydration miss', () => {
  const config = normalizeMatureFallbackConfig({
    rejectCooldownSeconds: 180,
    hydrationMissRejectCooldownSeconds: 420,
  });
  assert.equal(getMatureFallbackRejectCooldownSec({ hadVelocityHydrationMiss: false }, config), 180);
  assert.equal(getMatureFallbackRejectCooldownSec({ hadVelocityHydrationMiss: true }, config), 420);
});

test('scoreMatureFallbackCandidate caps raw momentum so exploded moves do not dominate', () => {
  const config = normalizeMatureFallbackConfig({ maxScoreMomentum5mPct: 12 });
  const moderate = scoreMatureFallbackCandidate({
    volume1hUsd: 50000,
    liquidityUsd: 20000,
    buyRatio: 2.0,
    tokenAgeSec: 45 * 60,
    priceChange5m: 12,
  }, config);
  const exploded = scoreMatureFallbackCandidate({
    volume1hUsd: 50000,
    liquidityUsd: 20000,
    buyRatio: 2.0,
    tokenAgeSec: 45 * 60,
    priceChange5m: 120,
  }, config);
  assert.equal(exploded, moderate);
});

test('shouldDeferMatureFallback waits when fresh eligible velocity names still exist', () => {
  const config = normalizeMatureFallbackConfig({ deferWhenEligibleVelocityCountGte: 1 });
  assert.equal(shouldDeferMatureFallback({ eligibleVelocityCount: 1 }, config), true);
  assert.equal(shouldDeferMatureFallback({ eligibleVelocityCount: 0 }, config), false);
});
