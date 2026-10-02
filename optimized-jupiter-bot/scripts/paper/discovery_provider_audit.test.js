'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProviderCandidate, records } = require('./discovery_provider_audit');

test('normalizes common market fields into one discovery contract', () => {
  const row = normalizeProviderCandidate('dexscreener', {
    pairAddress: 'pool',
    baseToken: { address: 'mint', symbol: 'TOK', name: 'Token' },
    liquidity: { usd: 8000 },
    volume: { m5: 150, h1: 900 },
    txns: { m5: { buys: 9, sells: 4 } },
    marketCap: 42000,
  });
  assert.deepEqual({
    source: row.source,
    mint: row.mint,
    symbol: row.symbol,
    poolAddress: row.poolAddress,
    liquidityUsd: row.liquidityUsd,
    volume5mUsd: row.volume5mUsd,
    volume1hUsd: row.volume1hUsd,
    buys5m: row.buys5m,
    sells5m: row.sells5m,
    marketCapUsd: row.marketCapUsd,
  }, {
    source: 'dexscreener', mint: 'mint', symbol: 'TOK', poolAddress: 'pool', liquidityUsd: 8000,
    volume5mUsd: 150, volume1hUsd: 900, buys5m: 9, sells5m: 4, marketCapUsd: 42000,
  });
});

test('extracts arrays from provider wrapper shapes', () => {
  assert.equal(records({ data: { data: [{ id: 1 }] } }).length, 1);
  assert.equal(records({ response: [{ id: 1 }, { id: 2 }] }).length, 2);
  assert.deepEqual(records(null), []);
});
