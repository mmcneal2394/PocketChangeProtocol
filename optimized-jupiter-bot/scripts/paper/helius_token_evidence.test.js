const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHeliusTokenEvidence, reinforceDiscoveryEvidence } = require('./helius_token_evidence');

test('Helius token evidence derives supply and top-account concentration without claiming holder identity', () => {
  const supply = { context: { slot: 100 }, rpcProvider: 'helius', value: { amount: '1000000000', decimals: 6 } };
  const largest = { context: { slot: 101 }, rpcProvider: 'helius', value: [
    { address: 'a', amount: '200000000', decimals: 6 },
    { address: 'b', amount: '100000000', decimals: 6 },
  ] };
  const evidence = normalizeHeliusTokenEvidence('mint', supply, largest, 2000);
  assert.equal(evidence.supply.total, 1000);
  assert.equal(evidence.top10AccountRatio, 0.3);
  assert.match(evidence.interpretation, /not beneficial-owner/);
});

test('Helius fills missing GMGN supply and concentration but preserves present GMGN values', () => {
  const helius = { source: 'helius_rpc', supply: { total: 1000 }, top10AccountRatio: 0.3 };
  const missing = { supply: { total: null }, concentration: { top10: null } };
  reinforceDiscoveryEvidence(missing, helius);
  assert.equal(missing.supply.total, 1000);
  assert.equal(missing.concentration.top10, 0.3);
  assert.equal(missing.reinforcement.comparison.supplyDifferenceRatio, null);
  const present = { supply: { total: 900 }, concentration: { top10: 0.2 } };
  reinforceDiscoveryEvidence(present, helius);
  assert.equal(present.supply.total, 900);
  assert.equal(present.concentration.top10, 0.2);
  assert.equal(present.reinforcement.comparison.supplyDifferenceRatio, 100 / 900);
});
