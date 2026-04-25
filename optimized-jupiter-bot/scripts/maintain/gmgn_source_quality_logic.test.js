const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateGmgnSourceQuality } = require('./gmgn_source_quality_logic.ts');

test('blocks flat stale gmgn plateau candidates with no smart-money support', () => {
  const result = evaluateGmgnSourceQuality({
    source: 'gmgn-bridge',
    priceChange5m: 0,
    priceChange1h: 0,
    volume5mUsd: 12_000,
    holders: 150,
    smartMoney: 0,
    pairCreatedAt: Math.floor((Date.now() - (20 * 60_000)) / 1000),
    now: Date.now(),
  });

  assert.equal(result.include, false);
  assert.equal(result.code, 'gmgn_plateau_no_support');
});

test('blocks flat gmgn candidates that still have no fresh turnover', () => {
  const result = evaluateGmgnSourceQuality({
    source: 'gmgn-bridge',
    priceChange5m: 0.2,
    priceChange1h: 2,
    volume5mUsd: 2_400,
    holders: 220,
    smartMoney: 0,
    pairCreatedAt: Math.floor((Date.now() - (5 * 60_000)) / 1000),
    now: Date.now(),
  });

  assert.equal(result.include, false);
  assert.equal(result.code, 'gmgn_plateau_low_volume');
});

test('keeps gmgn candidates with real price response', () => {
  const result = evaluateGmgnSourceQuality({
    source: 'gmgn-bridge',
    priceChange5m: 7.5,
    priceChange1h: 24,
    volume5mUsd: 11_000,
    holders: 95,
    smartMoney: 0,
    pairCreatedAt: Math.floor((Date.now() - (12 * 60_000)) / 1000),
    now: Date.now(),
  });

  assert.equal(result.include, true);
  assert.equal(result.code, null);
});

test('keeps flat gmgn candidates when executable wallet support exists upstream', () => {
  const result = evaluateGmgnSourceQuality({
    source: 'gmgn-bridge',
    priceChange5m: 0,
    priceChange1h: 0,
    volume5mUsd: 9_000,
    holders: 50,
    smartMoney: 0,
    walletExecutable: true,
    pairCreatedAt: Math.floor((Date.now() - (20 * 60_000)) / 1000),
    now: Date.now(),
  });

  assert.equal(result.include, true);
});
