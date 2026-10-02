const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { exitQuote, retryDelay, nextExit } = require('./exit_quotes');
const { exitRisk } = require('./exit_risk');
const { Providers, SOL, sanitizeError } = require('./live_providers');
const { createLocalPaperTraderState, runLocalPaperTrader } = require('./local_paper_trader.ts');
test('400, timeout, rate limit, no route and invalid Bags pool fall back to independent verified pool', async () => {
  for (const reason of ['bags_http_400', 'bags_http_429', 'bags_request_failed', 'no_route', 'bad_pool']) {
    const events = [], verified = [];
    const p = { quote: async () => { if (reason !== 'bad_pool') throw Error(reason); return { routePlan: [{ marketKey: 'bad' }], contextSlot: 10 }; },
      jupiterQuote: async () => ({ routePlan: [{ marketKey: 'new-migrated-pool' }], contextSlot: 20, outAmount: '123' }) };
    const r = await exitQuote(p, 'mint', '10', async (pool, slot) => { if (pool === 'bad') throw Error('invalid_pool'); verified.push([pool, slot]); return 'owner'; }, e => events.push(e));
    assert.equal(r.source, 'jupiter'); assert.equal(events.length, 2);
    assert.deepEqual(verified, [['new-migrated-pool', 20]]);
  }
});
test('both sources failing leaves quote unresolved and retry delay is bounded', async () => {
  await assert.rejects(exitQuote({ quote: async () => { throw Error('failed'); }, jupiterQuote: async () => { throw Error('no_route'); } }, 'mint', '10', async () => {}), /all_exit_quotes_failed/);
  assert.equal(retryDelay(1), 5000); assert.equal(retryDelay(100), 300000);
});
test('Jupiter accepts exact direct quotes only and diagnostics redact credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-jup-'));
  const q = { inputMint: 'mint', outputMint: SOL, inAmount: '10', outAmount: '20', contextSlot: 10, swapMode: 'ExactIn', routePlan: [{ percent: 100, swapInfo: { inputMint: 'mint', outputMint: SOL, ammKey: 'pool' } }] };
  const p = new Providers(dir, { keys: {}, fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => q }) });
  try {
    assert.equal((await p.jupiterQuote('mint', SOL, '10')).routePlan[0].marketKey, 'pool');
    q.inAmount = '9'; p.state.providers.jupiter.lastAttempt = 0;
    await assert.rejects(p.jupiterQuote('mint', SOL, '10'), /invalid_quote/);
    assert.deepEqual(sanitizeError({ response: { code: 'route_not_found', message: 'secret-value', wallet: 'private' } }, ['secret-value']), { response: { code: 'route_not_found', message: '[redacted]' } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
const mint = SOL;
test('pending exits take priority, but cooling-down positions cannot starve other exits', () => {
  const a = { closedAt: null, exitHealth: { nextRetryAt: 0 } };
  const b = { closedAt: null, exitPending: { reason: 'stop_loss' }, exitHealth: { nextRetryAt: 0 } };
  assert.equal(nextExit([a, b], 10)[0], b);
  b.exitHealth.nextRetryAt = 100; assert.equal(nextExit([a, b], 10)[0], a);
  a.closedAt = 1; assert.equal(nextExit([a, b], 10).length, 0);
});
function tick(s, t, fresh, traffic) {
  return runLocalPaperTrader(s, { schemaVersion: 'local-paper-trader-input/v1', generatedAt: t, trafficByMint: traffic ? { [mint]: traffic } : {},
    candidates: t === 1 ? [{ mint, decision: 'paper_entry_candidate' }] : [],
    marksByMint: { [mint]: { fresh, updatedAt: t, priceSol: 1 } } });
}
test('inactivity latch survives missing quotes, restart and resumed activity; fill credited once', () => {
  let s = createLocalPaperTraderState({ modeledFeeBps: 0, rotationTrigger: 'inactivity', inactivityExit: 'full' }); tick(s, 1, true);
  tick(s, 600001, false, { checkedAt: 600001, quietSince: 0 });
  assert.equal(s.positions[0].exitPending.reason, 'inactivity_10m'); assert.equal(s.availableCapitalSol, 0.95);
  s = JSON.parse(JSON.stringify(s)); tick(s, 610001, true, { checkedAt: 610001, quietSince: null });
  assert.equal(s.positions[0].closeReason, 'inactivity_10m'); assert.equal(s.positions[0].exitDelayMs, 10000);
  assert.equal(s.availableCapitalSol, 1); tick(s, 610002, true); assert.equal(s.availableCapitalSol, 1);
});
test('maximum hold is latched without a quote; unresolved stress does not mutate ledger', () => {
  const s = createLocalPaperTraderState({ modeledFeeBps: 0 }); tick(s, 1, true); tick(s, 14400001, false);
  assert.equal(s.positions[0].exitPending.reason, 'max_hold_4h');
  s.capitalAdjustments = [{ amountSol: 9 }]; s.availableCapitalSol += 9;
  const before = JSON.stringify(s), risk = exitRisk(s, 14400001);
  assert.equal(risk.unresolved, 1); assert.equal(risk.funding, 10); assert.ok(Math.abs(risk.stressPnl + 0.05) < 1e-9);
  assert.equal(JSON.stringify(s), before);
});
test('persisted stop request executes after recovery even above the stop threshold', () => {
  let s = createLocalPaperTraderState({ modeledFeeBps: 0, stopLossPct: 40 }); tick(s, 1, true);
  s.positions[0].exitPending = { reason: 'stop_loss', triggeredAt: 2 };
  s = JSON.parse(JSON.stringify(s)); tick(s, 100, true);
  assert.equal(s.positions[0].closeReason, 'stop_loss');
  assert.equal(s.positions[0].exitDelayMs, 98); assert.equal(s.availableCapitalSol, 1);
});
test('a fade after banked upside exits near flat instead of riding the full base stop', () => {
  const s = createLocalPaperTraderState({ initialPositionSol: 1, modeledFeeBps: 0, stopLossPct: 8, breakevenAtPct: 5, trailingStopPct: 4 });
  const step = (t, price, entry) => runLocalPaperTrader(s, { schemaVersion: 'local-paper-trader-input/v1', generatedAt: t,
    marksByMint: { [mint]: { fresh: true, updatedAt: t, priceSol: price } }, candidates: entry ? [{ mint, decision: 'paper_entry_candidate', entryPriceSol: 1 }] : [] });
  step(1, 1, true);
  step(2, 1.05, false); // arms the breakeven step; stop becomes 1.05 * 0.96 = 1.008
  assert.equal(s.positions[0].closedAt, null);
  assert.ok(Math.abs(s.positions[0].peakRatio - 1.05) < 1e-9);
  step(3, 1, false); // a fade to entry, which the base 8% stop (0.92) would NOT catch
  assert.equal(s.positions[0].closedAt, 3);
  assert.equal(s.positions[0].closeReason, 'stop_loss');
  assert.ok(Math.abs(s.positions[0].realizedPnlSol) < 1e-9);
});
test('a position that never banks the breakeven step still uses the base stop', () => {
  const s = createLocalPaperTraderState({ initialPositionSol: 1, modeledFeeBps: 0, stopLossPct: 8, breakevenAtPct: 3, trailingStopPct: 4 });
  const step = (t, price, entry) => runLocalPaperTrader(s, { schemaVersion: 'local-paper-trader-input/v1', generatedAt: t,
    marksByMint: { [mint]: { fresh: true, updatedAt: t, priceSol: price } }, candidates: entry ? [{ mint, decision: 'paper_entry_candidate', entryPriceSol: 1 }] : [] });
  step(1, 1, true);
  step(2, 1.01, false); // only +1%, below the +3% breakeven step
  assert.equal(s.positions[0].closedAt, null);
  step(3, 0.90, false); // clears the base 8% stop at 0.92
  assert.equal(s.positions[0].closedAt, 3);
  assert.equal(s.positions[0].closeReason, 'stop_loss');
  assert.ok(Math.abs(s.positions[0].realizedPnlSol + 0.1) < 1e-9);
});
