const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLocalPaperTraderState, runLocalPaperTrader } = require('./local_paper_trader.ts');
const mint = 'So11111111111111111111111111111111111111112';
function tick(s, t, traffic, fresh = true) {
  runLocalPaperTrader(s, { schemaVersion: 'local-paper-trader-input/v1', generatedAt: t, marksByMint: { [mint]: { fresh, priceSol: 1, updatedAt: t } },
    trafficByMint: { [mint]: traffic }, candidates: t === 1 ? [{ mint, decision: 'paper_entry_candidate' }] : [] });
}
function setup() { const s = createLocalPaperTraderState({ inactivityExit: 'full', rotationTrigger: 'inactivity', modeledFeeBps: 0 }); tick(s, 1); return s; }
test('full inactivity exit releases all capital once without creating a runner', () => {
  const s = setup(); tick(s, 600000, { checkedAt: 600000, quietSince: 0 });
  assert.equal(s.positions[0].closedAt, null);
  tick(s, 600001, { checkedAt: 600001, quietSince: 0 });
  assert.equal(s.positions[0].closeReason, 'inactivity_10m');
  assert.equal(s.positions[0].remainingTokenAmount, 0);
  assert.equal(s.availableCapitalSol, 1);
  tick(s, 600002, { checkedAt: 600002, quietSince: 0 });
  assert.equal(s.availableCapitalSol, 1);
});
test('activity, unknown traffic, stale traffic or stale prices cannot cause inactivity exit', () => {
  for (const traffic of [undefined, { checkedAt: 600001, quietSince: null }, { checkedAt: 1, quietSince: 0 }]) {
    const s = setup(); tick(s, 600001, traffic); assert.equal(s.positions[0].closedAt, null);
  }
  const s = setup(); tick(s, 600001, { checkedAt: 600001, quietSince: 0 }, false); assert.equal(s.positions[0].closedAt, null);
});
test('full inactivity policy closes a legacy runner', () => {
  const s = setup(); s.config.inactivityExit = 'rotate_75';
  tick(s, 600001, { checkedAt: 600001, quietSince: 0 });
  assert.ok(s.positions[0].rotationAt);
  s.config.inactivityExit = 'full'; tick(s, 600002, { checkedAt: 600002, quietSince: 0 });
  assert.equal(s.positions[0].closeReason, 'inactivity_10m');
  assert.ok(Math.abs(s.availableCapitalSol - 1) < 1e-10);
});
