const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateEntryRisk } = require('./entry_risk_logic.ts');

test('evaluateEntryRisk rejects extreme combined risk', () => {
  const decision = evaluateEntryRisk({
    duplicateImageRisk: 'high',
    isJitterBundle: true,
    top10Pct: 55,
    holderCount: 8,
    bullishSignals: 2,
  });

  assert.equal(decision.reject, true);
  assert.equal(decision.positionMultiplier, 0);
  assert.equal(decision.riskBand, 'extreme');
});

test('evaluateEntryRisk uses probe mode for elevated but supported risk', () => {
  const decision = evaluateEntryRisk({
    duplicateImageRisk: 'medium',
    top10Pct: 38,
    holderCount: 14,
    bullishSignals: 2,
  });

  assert.equal(decision.reject, false);
  assert.equal(decision.probeMode, true);
  assert.equal(decision.positionMultiplier, 0.3);
});

test('evaluateEntryRisk scales size down linearly for moderate risk', () => {
  const decision = evaluateEntryRisk({
    duplicateImageRisk: 'low',
    top10Pct: 32,
    holderCount: 40,
    bullishSignals: 0,
  });

  assert.equal(decision.reject, false);
  assert.equal(decision.probeMode, false);
  assert.ok(decision.positionMultiplier < 1);
  assert.ok(decision.positionMultiplier > 0.5);
});

test('evaluateEntryRisk converts soft rugcheck lp-unlock warning into size reduction instead of hard reject', () => {
  const decision = evaluateEntryRisk({
    top10Pct: 42,
    holderCount: 18,
    bullishSignals: 2,
    rugCheckWarnings: ['Large Amount of LP Unlocked'],
  });

  assert.equal(decision.reject, false);
  assert.equal(decision.probeMode, true);
  assert.equal(decision.positionMultiplier, 0.3);
  assert.match(decision.reasons.join(' | '), /rugcheck lp unlock risk/i);
});
