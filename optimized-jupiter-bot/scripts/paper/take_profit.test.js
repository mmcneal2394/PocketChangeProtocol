const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLocalPaperTraderState, runLocalPaperTrader } = require('./local_paper_trader.ts');
const mint = 'So11111111111111111111111111111111111111112';
function setup() {
  const s = createLocalPaperTraderState({ startingCapitalSol: 10, stopLossPct: 8, takeProfitPct: 15, modeledFeeBps: 100, rotationTrigger: 'inactivity', inactivityExit: 'full' });
  runLocalPaperTrader(s, { schemaVersion: 'local-paper-trader-input/v1', generatedAt: 1, marksByMint: { [mint]: { fresh: true, priceSol: 1, updatedAt: 1 } }, candidates: [{ mint, decision: 'paper_entry_candidate' }] });
  return s;
}
function tick(s, net, t = 2, extra = {}) {
  const p = s.positions[0];
  runLocalPaperTrader(s, { schemaVersion: 'local-paper-trader-input/v1', generatedAt: t, marksByMint: { [mint]: { priceSol: 100, fresh: true, updatedAt: t, exitQuotes: [{ tokenAmount: p.remainingTokenAmount, proceedsSol: net / .99 }], ...extra } } });
}
test('15% net take-profit fully closes and credits once, independent of headline price', () => {
  const s = setup(); tick(s, .0574); assert.equal(s.positions[0].closedAt, null);
  tick(s, .0575, 3); assert.equal(s.positions[0].closeReason, 'take_profit');
  assert.ok(Math.abs(s.availableCapitalSol - 10.0075) < 1e-9);
  tick(s, 1, 4); assert.equal(s.events.filter(e => e.type === 'take_profit').length, 1);
});
test('8% stop uses net proceeds, including gap losses', () => {
  const s = setup(); tick(s, .0461); assert.equal(s.positions[0].closedAt, null);
  tick(s, .045, 3); assert.equal(s.positions[0].closeReason, 'stop_loss');
  assert.ok(Math.abs(s.availableCapitalSol - 9.995) < 1e-9);
});
test('stale and mismatched sell quotes never manufacture profit', () => {
  const s = setup(); tick(s, 1, 40000, { updatedAt: 1 }); assert.equal(s.positions[0].closedAt, null);
  tick(s, 1, 40001, { exitQuotes: [{ tokenAmount: 99, proceedsSol: 1 }] }); assert.equal(s.positions[0].closedAt, null);
});
test('pending take profit survives restart and fills at recovered quote, not target', () => {
  let s = setup(); s.positions[0].exitPending = { reason: 'take_profit', triggeredAt: 2 };
  s = JSON.parse(JSON.stringify(s)); tick(s, .05, 4);
  assert.equal(s.positions[0].closeReason, 'take_profit');
  assert.ok(Math.abs(s.availableCapitalSol - 10) < 1e-9);
});
