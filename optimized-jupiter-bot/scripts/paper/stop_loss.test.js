const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLocalPaperTraderState, runLocalPaperTrader } = require('./local_paper_trader.ts');
const mint = 'So11111111111111111111111111111111111111112';
function setup() {
  const s = createLocalPaperTraderState({ stopLossPct: 40, modeledFeeBps: 0, rotationTrigger: 'inactivity' });
  tick(s, 1, 1, { candidates: [{ mint, decision: 'paper_entry_candidate' }] });
  return s;
}
function tick(s, t, price, extra = {}) {
  runLocalPaperTrader(s, { schemaVersion: 'local-paper-trader-input/v1', generatedAt: t,
    marksByMint: { [mint]: { fresh: true, priceSol: price, updatedAt: t } }, ...extra });
}
test('40% stop closes fully at threshold, releases capital once, and precedes rotation', () => {
  const s = setup(); tick(s, 2, 0.601); assert.equal(s.positions[0].closedAt, null);
  tick(s, 600001, 0.6, { trafficByMint: { [mint]: { checkedAt: 600001, quietSince: 0 } } });
  assert.equal(s.positions[0].closeReason, 'stop_loss');
  assert.equal(s.positions[0].remainingTokenAmount, 0);
  assert.equal(s.positions[0].rotationAt, null);
  assert.ok(Math.abs(s.availableCapitalSol - 0.98) < 1e-10);
  tick(s, 600002, 0.5); assert.equal(s.events.filter(e => e.type === 'stop_loss').length, 1);
});
test('stale and wrong-size quotes cannot trigger stop; fresh gap fills at observed value', () => {
  const s = setup();
  tick(s, 40000, 0.3, { marksByMint: { [mint]: { fresh: true, priceSol: 0.3, updatedAt: 1 } } });
  assert.equal(s.positions[0].closedAt, null);
  tick(s, 40001, 0.3, { marksByMint: { [mint]: { fresh: true, priceSol: 0.3, updatedAt: 40001, exitQuotes: [{ tokenAmount: 99, proceedsSol: 0.01 }] } } });
  assert.equal(s.positions[0].closedAt, null);
  tick(s, 40002, 0.3); assert.ok(Math.abs(s.positions[0].realizedPnlSol + 0.035) < 1e-10);
});
test('stop also closes retained runner using its proportional entry cost', () => {
  const s = setup(); tick(s, 600001, 1, { trafficByMint: { [mint]: { checkedAt: 600001, quietSince: 0 } } });
  assert.ok(s.positions[0].rotationAt);
  tick(s, 600002, 0.5); assert.equal(s.positions[0].closeReason, 'stop_loss');
  assert.ok(Math.abs(s.positions[0].realizedPnlSol + 0.00625) < 1e-10);
});
