const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createLocalPaperTraderState,
  runLocalPaperTrader,
  summarizeLocalPaperTrader,
} = require('./local_paper_trader.ts');

const MINT = '11111111111111111111111111111111';
const START = 1_700_000_000_000;

function snapshot(generatedAt, overrides = {}) {
  return {
    schemaVersion: 'local-paper-trader-input/v1',
    generatedAt,
    candidates: [{ mint: MINT, symbol: 'PAPER', decision: 'paper_entry_candidate', entryPriceSol: 0.01 }],
    marksByMint: { [MINT]: { priceSol: 0.01, updatedAt: generatedAt, fresh: true } },
    ...overrides,
  };
}

test('opens a paper-only position without any execution capability', () => {
  const state = createLocalPaperTraderState({ startingCapitalSol: 1, initialPositionSol: 0.1, modeledFeeBps: 0 });
  const next = runLocalPaperTrader(state, snapshot(START));
  assert.equal(next.execution.mode, 'paper_only');
  assert.equal(next.execution.signing, 'disabled');
  assert.equal(next.execution.broadcasting, 'disabled');
  assert.equal(next.positions.length, 1);
  assert.equal(next.availableCapitalSol, 0.9);
});

test('rotates 75 percent of the original position at ten minutes and retains a 25 percent runner', () => {
  const state = runLocalPaperTrader(createLocalPaperTraderState({ startingCapitalSol: 1, initialPositionSol: 0.1, modeledFeeBps: 0 }), snapshot(START));
  const next = runLocalPaperTrader(state, snapshot(START + 10 * 60_000, {
    candidates: [],
    marksByMint: { [MINT]: { priceSol: 0.02, updatedAt: START + 10 * 60_000, fresh: true } },
  }));
  assert.equal(next.positions[0].rotationAt, START + 10 * 60_000);
  assert.equal(next.positions[0].remainingTokenAmount, next.positions[0].originalTokenAmount * 0.25);
  assert.equal(next.events[0].type, 'rotation_75');
  assert.equal(next.availableCapitalSol, 1.05);
});

test('closes the remaining runner only at the four-hour maximum hold', () => {
  const state = runLocalPaperTrader(createLocalPaperTraderState({ startingCapitalSol: 1, initialPositionSol: 0.1, modeledFeeBps: 0 }), snapshot(START));
  const rotated = runLocalPaperTrader(state, snapshot(START + 10 * 60_000, {
    candidates: [],
    marksByMint: { [MINT]: { priceSol: 0.02, updatedAt: START + 10 * 60_000, fresh: true } },
  }));
  const closed = runLocalPaperTrader(rotated, snapshot(START + 4 * 60 * 60_000, {
    candidates: [],
    marksByMint: { [MINT]: { priceSol: 0.03, updatedAt: START + 4 * 60 * 60_000, fresh: true } },
  }));
  assert.equal(closed.positions[0].closedAt, START + 4 * 60 * 60_000);
  assert.equal(closed.positions[0].remainingTokenAmount, 0);
  assert.equal(closed.events[0].type, 'force_close_4h');
  assert.equal(summarizeLocalPaperTrader(closed).largestWinSymbol, 'PAPER');
});

test('does not rotate or force-close against a stale mark', () => {
  const state = runLocalPaperTrader(createLocalPaperTraderState({ modeledFeeBps: 0 }), snapshot(START));
  const next = runLocalPaperTrader(state, snapshot(START + 4 * 60 * 60_000, {
    candidates: [],
    marksByMint: { [MINT]: { priceSol: 0, updatedAt: START, fresh: false } },
  }));
  assert.equal(next.positions[0].rotationAt, null);
  assert.equal(next.positions[0].closedAt, null);
  assert.equal(next.events[0].type, 'mark_stale');
});

test('harvests 75 percent of an active winner at the rotation age even when its traffic is loud', () => {
  const state = runLocalPaperTrader(createLocalPaperTraderState({ startingCapitalSol: 1, initialPositionSol: 0.1, modeledFeeBps: 0, rotationTrigger: 'inactivity', rotationMinGainPct: 5 }), snapshot(START));
  // +2% is below the profit gate and loud traffic blocks the inactivity rule, so the position stays open.
  const belowGate = runLocalPaperTrader(state, snapshot(START + 10 * 60_000, {
    candidates: [],
    marksByMint: { [MINT]: { priceSol: 0.0102, updatedAt: START + 10 * 60_000, fresh: true } },
    trafficByMint: { [MINT]: { checkedAt: START + 10 * 60_000, quietSince: null } },
  }));
  assert.equal(belowGate.positions[0].rotationAt, null);
  // +10% clears the gate, so 75% is harvested even though the traffic is still loud.
  const harvested = runLocalPaperTrader(belowGate, snapshot(START + 10 * 60_000 + 1, {
    candidates: [],
    marksByMint: { [MINT]: { priceSol: 0.011, updatedAt: START + 10 * 60_000 + 1, fresh: true } },
    trafficByMint: { [MINT]: { checkedAt: START + 10 * 60_000 + 1, quietSince: null } },
  }));
  assert.equal(harvested.positions[0].rotationAt, START + 10 * 60_000 + 1);
  assert.equal(harvested.positions[0].remainingTokenAmount, harvested.positions[0].originalTokenAmount * 0.25);
  assert.equal(harvested.events[0].type, 'rotation_75');
  assert.match(harvested.events[0].detail, /Harvested 75%/);
});

test('leaves the profit rotation disabled when rotationMinGainPct is unset', () => {
  const state = runLocalPaperTrader(createLocalPaperTraderState({ startingCapitalSol: 1, initialPositionSol: 0.1, modeledFeeBps: 0, rotationTrigger: 'inactivity' }), snapshot(START));
  const next = runLocalPaperTrader(state, snapshot(START + 10 * 60_000, {
    candidates: [],
    marksByMint: { [MINT]: { priceSol: 0.011, updatedAt: START + 10 * 60_000, fresh: true } },
    trafficByMint: { [MINT]: { checkedAt: START + 10 * 60_000, quietSince: null } },
  }));
  assert.equal(next.positions[0].rotationAt, null);
});
