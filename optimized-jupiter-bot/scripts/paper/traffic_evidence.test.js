const { test } = require('node:test');
const assert = require('node:assert/strict');
const { trafficEvidence } = require('./traffic_evidence');
const { createLocalPaperTraderState, rotationDue, runLocalPaperTrader } = require('./local_paper_trader.ts');
const now = 1200000;
const quiet = () => Array.from({ length: 11 }, (_, i) => ({ time: 600000 + i * 60000, volume: '0', amount: '0' }));
test('complete zero-volume coverage enables inactivity, missing or active bars do not', () => {
  assert.equal(trafficEvidence(quiet(), now).quietSince, 600000);
  assert.equal(trafficEvidence(quiet().slice(1), now).quietSince, null);
  const active = quiet(); active[10].volume = '12';
  assert.equal(trafficEvidence(active, now).quietSince, null);
  const malformed = quiet(); malformed[0].volume = null;
  assert.equal(trafficEvidence(malformed, now).quietSince, null);
});
test('entry age cannot cause inactivity rotation; stale traffic defers it', () => {
  const state = createLocalPaperTraderState({ rotationTrigger: 'inactivity' });
  const p = { openedAt: 0 };
  assert.equal(rotationDue(state, p, now), false);
  assert.equal(rotationDue(state, p, now, { checkedAt: now, quietSince: null }), false);
  assert.equal(rotationDue(state, p, now, { checkedAt: now - 31000, quietSince: 0 }), false);
  assert.equal(rotationDue(state, p, now, trafficEvidence(quiet(), now)), true);
  assert.equal(rotationDue(state, { openedAt: now - 1000 }, now, trafficEvidence(quiet(), now)), false);
});
test('four-hour close remains independent of missing activity evidence', () => {
  const s = createLocalPaperTraderState({ rotationTrigger: 'inactivity' });
  const mint = 'So11111111111111111111111111111111111111112';
  const input = t => ({ schemaVersion: 'local-paper-trader-input/v1', generatedAt: t, marksByMint: { [mint]: { fresh: true, priceSol: 1, updatedAt: t } } });
  runLocalPaperTrader(s, { ...input(1), candidates: [{ mint, decision: 'paper_entry_candidate' }] });
  runLocalPaperTrader(s, input(600001));
  assert.equal(s.positions[0].rotationAt, null);
  runLocalPaperTrader(s, input(14400001));
  assert.equal(s.positions[0].closedAt, 14400001);
});
