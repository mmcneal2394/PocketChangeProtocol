const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveMicroScoutPacing } = require('./micro_scout_pacing_logic.ts');

const baseProbeConfig = {
  minRawBuys60s: 14,
  minRawBuyRatio60s: 0.8,
  minRawSolVolume60s: 1.5,
  minVelocity: 10,
  maxCandidatesPerPoll: 5,
};

const underfilledBook = {
  enabled: true,
  maxFillRatio: 0.3,
  minRawBuys60s: 8,
  minRawBuyRatio60s: 0.72,
  minRawSolVolume60s: 1,
  minVelocity: 8,
  maxCandidatesPerPoll: 8,
};

test('resolveMicroScoutPacing relaxes scout floors when the book is underfilled', () => {
  const result = resolveMicroScoutPacing({
    currentOpenPositions: 0,
    maxOpenPositions: 10,
    baseProbeConfig,
    underfilledBook,
  });

  assert.equal(result.underfilledBookActive, true);
  assert.equal(result.remainingSlots, 10);
  assert.equal(result.maxCandidatesPerPoll, 8);
  assert.deepEqual(result.probeConfig, {
    minRawBuys60s: 8,
    minRawBuyRatio60s: 0.72,
    minRawSolVolume60s: 1,
    minVelocity: 8,
  });
});

test('resolveMicroScoutPacing keeps relaxed mode active through the configured fill threshold', () => {
  const result = resolveMicroScoutPacing({
    currentOpenPositions: 3,
    maxOpenPositions: 10,
    baseProbeConfig,
    underfilledBook,
  });

  assert.equal(result.underfilledBookActive, true);
  assert.equal(result.fillRatio, 0.3);
});

test('resolveMicroScoutPacing falls back to the stricter base profile once the book is filling', () => {
  const result = resolveMicroScoutPacing({
    currentOpenPositions: 4,
    maxOpenPositions: 10,
    baseProbeConfig,
    underfilledBook,
  });

  assert.equal(result.underfilledBookActive, false);
  assert.equal(result.maxCandidatesPerPoll, 5);
  assert.deepEqual(result.probeConfig, {
    minRawBuys60s: 14,
    minRawBuyRatio60s: 0.8,
    minRawSolVolume60s: 1.5,
    minVelocity: 10,
  });
});

test('resolveMicroScoutPacing ignores the underfilled profile when disabled', () => {
  const result = resolveMicroScoutPacing({
    currentOpenPositions: 0,
    maxOpenPositions: 10,
    baseProbeConfig,
    underfilledBook: { ...underfilledBook, enabled: false },
  });

  assert.equal(result.underfilledBookActive, false);
  assert.equal(result.maxCandidatesPerPoll, 5);
});
