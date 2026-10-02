const { test } = require('node:test');
const assert = require('node:assert/strict');
const { marketCap, marketCapLabel, marketCapSecondaryLabel } = require('./market_cap');
test('market cap uses circulating supply, rejects missing data and cross-mint responses', () => {
  const info = { address: 'mint', price: { price: '0.002' }, circulating_supply: '1000000' };
  const cap = marketCap(info, 'mint', 100);
  assert.equal(cap.usd, 2000);
  assert.equal(marketCapLabel(cap, 200), '$2.00K (GMGN)');
  assert.equal(marketCapLabel(cap, 30200), '$2.00K (stale)');
  assert.equal(marketCapLabel(marketCap({ ...info, circulating_supply: null }, 'mint', 100)), 'Unknown');
  assert.throws(() => marketCap(info, 'other', 100));
});
test('pre-bond curves separate float market cap from curve FDV', () => {
  const info = { address: 'mint', launchpad_status: 0, launchpad: 'meteora_virtual_curve', price: { price: '0.000068' }, circulating_supply: '1000000000', total_supply: '1000000000', max_supply: '1000000000' };
  const cap = marketCap(info, 'mint', 100, { exchange: 'meteora_virtual_curve', base_reserve: '999000000' });
  assert.equal(cap.usd, 68);
  assert.equal(cap.fdvUsd, 68000);
  assert.equal(cap.valuationType, 'curve_float');
  assert.match(marketCapLabel(cap, 100), /\$68\.00 float/);
  assert.match(marketCapSecondaryLabel(cap), /\$68\.00K curve FDV/);
});
