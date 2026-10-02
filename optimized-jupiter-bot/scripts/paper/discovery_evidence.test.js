const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalize, admissionIssues, reserveEvidence, updateTraffic } = require('./discovery_evidence');
const { TOKEN, SOL } = require('./live_providers');
function fixture() {
  return normalize('mint', { address: 'mint', creation_timestamp: 10, biggest_pool_address: 'pool', holder_count: 20, og: true, image_dup_count: 1, price: { buys_1m: 1, sells_1m: 2, swaps_1m: 3, volume_1m: '10' } }, { address: 'mint', renounced_mint: true, renounced_freeze_account: true, flags: [], top_10_holder_rate: '0.2' }, { address: 'mint', base_address: 'mint', pool_address: 'pool', quote_address: SOL, liquidity: '5000' }, 20000);
}
test('discovery retains unknowns and rejects cross-mint and cross-pool data', () => {
  const e = fixture(); assert.equal(e.ageSeconds, 10); assert.equal(e.concentration.insider, null);
  assert.equal(e.providerPayload.info.address, 'mint');
  assert.equal(e.checks.poolIdentity.status, 'pass');
  assert.equal(e.checks.flowArithmetic.status, 'pass');
  assert.deepEqual(admissionIssues(e, 21000), []);
  assert.throws(() => normalize('wrong', {}, {}, {}, 20000), /mint_conflict/);
  assert.deepEqual(admissionIssues(e, 60000), ['stale_discovery_evidence']);
});
test('duplicate image metadata does not affect admission while security alerts still block entry', () => {
  const e = fixture(); e.media.duplicateCount = 2; e.media.providerOg = false;
  e.security.alert = true;
  assert.ok(!admissionIssues(e, 21000).includes('duplicate_image_not_provider_og'));
  assert.ok(admissionIssues(e, 21000).includes('provider_security_alert'));
  e.flow.swaps1m = null;
  assert.ok(admissionIssues(e, 21000).includes('missing_recent_flow'));
});
test('independent balances require matching vault mints and authority', () => {
  const vault = mint => ({ owner: TOKEN, data: { parsed: { type: 'account', info: { mint, state: 'initialized', owner: 'authority', tokenAmount: { amount: '1000000', decimals: 6 } } } } });
  const a = { context: { slot: 100 }, rpcProvider: 'orbitflare', value: [{ owner: 'pool-program', executable: false }, vault('mint'), vault(SOL)] };
  const reserves = reserveEvidence(fixture(), a, 20000);
  assert.equal(reserves.reserveRatioSol, 1);
  assert.equal(reserves.source, 'orbitflare_confirmed_vault_balances');
  a.value[0].owner = TOKEN;
  assert.throws(() => reserveEvidence(fixture(), a, 20000), /invalid_pool_owner/);
  a.value[0].owner = 'pool-program'; a.value[1].data.parsed.info.mint = 'other';
  assert.throws(() => reserveEvidence(fixture(), a, 20000), /vault_mint/);
});
test('overlapping zero-trade windows accumulate; activity or gaps reset coverage', () => {
  const zero = { buys1m: 0, sells1m: 0, swaps1m: 0, volume1mUsd: 0 };
  let p = updateTraffic(null, zero, 60000);
  for (let t = 90000; t <= 660000; t += 30000) p = updateTraffic(p, zero, t);
  assert.equal(p.quietSince, 0);
  assert.equal(updateTraffic(p, { ...zero, buys1m: 1 }, 670000).quietSince, null);
  assert.equal(updateTraffic(p, zero, 800000).quietSince, 740000);
  assert.equal(updateTraffic(p, { ...zero, buys1m: null }, 670000).quietSince, null);
});
