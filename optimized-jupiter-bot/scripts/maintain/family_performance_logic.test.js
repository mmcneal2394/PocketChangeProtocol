const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeEntryFamily,
  buildFamilyPerformanceMemory,
  evaluateEntryFamilyPerformance,
  recordFamilyTrade,
} = require('./family_performance_logic.ts');

test('normalizeEntryFamily prefers explicit family', () => {
  assert.equal(normalizeEntryFamily({ entryFamily: 'micro-probe' }), 'micro-probe');
});

test('normalizeEntryFamily derives velocity-first from source lane', () => {
  assert.equal(
    normalizeEntryFamily({ sourceLane: 'velocity-first', entryMode: 'micro-scout' }),
    'velocity-first',
  );
});

test('normalizeEntryFamily derives micro-probe from probe-like micro entry', () => {
  assert.equal(
    normalizeEntryFamily({ entryMode: 'micro-scout', probeLikeEntry: true }),
    'micro-probe',
  );
});

test('evaluateEntryFamilyPerformance halves size for weak recent win rate', () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    action: 'SELL',
    entryFamily: 'velocity-first',
    pnlSol: index < 5 ? 0.001 : -0.0002,
    timestamp: index + 1,
  }));
  const memory = buildFamilyPerformanceMemory(rows);
  const decision = evaluateEntryFamilyPerformance('velocity-first', memory);

  assert.equal(decision.disabled, false);
  assert.equal(decision.sizeMultiplier, 0.5);
  assert.ok(decision.reason.includes('win rate'));
});

test('evaluateEntryFamilyPerformance disables family on recent net loss threshold breach', () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({
    action: 'SELL',
    entryFamily: 'mature-fallback',
    pnlSol: -0.001,
    timestamp: index + 1,
  }));
  const memory = buildFamilyPerformanceMemory(rows);
  const decision = evaluateEntryFamilyPerformance('mature-fallback', memory);

  assert.equal(decision.disabled, true);
  assert.equal(decision.sizeMultiplier, 0);
  assert.ok(decision.reason.includes('recent 20-trade net'));
});

test('recordFamilyTrade keeps only most recent maxHistory samples', () => {
  const memory = buildFamilyPerformanceMemory([]);
  for (let index = 0; index < 60; index += 1) {
    recordFamilyTrade(memory, {
      action: 'SELL',
      entryFamily: 'micro-core',
      pnlSol: 0.0001,
      timestamp: index + 1,
    });
  }

  const decision = evaluateEntryFamilyPerformance('micro-core', memory, { recentTradeWindow: 50 });
  assert.equal(decision.sampleCount, 50);
  assert.equal(memory['micro-core'].recent.length, 50);
});
