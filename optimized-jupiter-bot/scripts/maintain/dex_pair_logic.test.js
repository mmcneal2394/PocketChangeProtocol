const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDexScreenerPair } = require('./dex_pair_logic.ts');

test('normalizeDexScreenerPair preserves valuation, liquidity, and multi-window volume fields', () => {
  const normalized = normalizeDexScreenerPair({
    liquidity: { usd: '12345.67' },
    marketCap: '250000',
    fdv: '275000',
    priceChange: { m5: '12.5', h1: '88.2' },
    volume: { m5: '4321', h1: '55555', h6: '123456' },
    boosts: { active: 2 },
    pairCreatedAt: 123456789,
  });

  assert.equal(normalized.liquidity, 12345.67);
  assert.equal(normalized.marketCap, 250000);
  assert.equal(normalized.fdv, 275000);
  assert.equal(normalized.priceChange5m, 12.5);
  assert.equal(normalized.priceChange1h, 88.2);
  assert.equal(normalized.volume5m, 4321);
  assert.equal(normalized.volume1h, 55555);
  assert.equal(normalized.volume6h, 123456);
  assert.equal(normalized.boosted, true);
  assert.equal(normalized.pairCreatedAt, 123456789);
});

test('normalizeDexScreenerPair safely falls back when fdv and optional fields are missing', () => {
  const normalized = normalizeDexScreenerPair({
    liquidity: { usd: null },
    marketCap: '90000',
    boosts: { active: 0 },
  });

  assert.equal(normalized.liquidity, 0);
  assert.equal(normalized.marketCap, 90000);
  assert.equal(normalized.fdv, 90000);
  assert.equal(normalized.volume5m, 0);
  assert.equal(normalized.volume1h, 0);
  assert.equal(normalized.volume6h, 0);
  assert.equal(normalized.boosted, false);
});
