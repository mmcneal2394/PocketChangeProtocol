const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractTrendingEntries,
  normalizeTrendingEntry,
  buildTrendingMap,
} = require('./trending_signal_logic.ts');

test('extractTrendingEntries supports flat array and legacy mints wrapper', () => {
  assert.equal(extractTrendingEntries([{ mint: 'A' }]).length, 1);
  assert.equal(extractTrendingEntries({ mints: [{ mint: 'B' }] }).length, 1);
  assert.equal(extractTrendingEntries({ nope: [] }).length, 0);
});

test('normalizeTrendingEntry extracts Dex-style bags entries', () => {
  const normalized = normalizeTrendingEntry({
    dexId: 'bags-fm',
    url: 'https://dexscreener.com/solana/test',
    baseToken: { address: 'Mint111', symbol: 'BAGS', name: 'Bags Token' },
    volume: { h1: 50000, m5: 2000 },
    priceChange: { h1: 12, m5: 4 },
    liquidity: { usd: 12000 },
    fdv: 75000,
    txns: { h1: { buys: 42, sells: 21 } },
    _gmgn: { source: 'bags-swarm', smartMoney: 2, holders: 88 },
  });

  assert.equal(normalized.mint, 'Mint111');
  assert.equal(normalized.symbol, 'BAGS');
  assert.equal(normalized.volume1h, 50000);
  assert.equal(normalized.priceChange5m, 4);
  assert.equal(normalized.buyRatio, 2);
  assert.equal(normalized.bagsSignal, true);
  assert.equal(normalized.source, 'bags-swarm');
});

test('normalizeTrendingEntry preserves legacy direct sniper fields', () => {
  const normalized = normalizeTrendingEntry({
    mint: 'Mint222',
    symbol: 'LEGACY',
    volume1h: 9000,
    priceChange1h: 5,
    buys1h: 30,
    sells1h: 10,
    buyRatio: 3,
    pairCreatedAt: 123456,
    source: 'gmgn-bridge',
  });

  assert.equal(normalized.mint, 'Mint222');
  assert.equal(normalized.buyRatio, 3);
  assert.equal(normalized.pairCreatedAt, 123456);
  assert.equal(normalized.bagsSignal, false);
});

test('buildTrendingMap indexes by mint across mixed shapes', () => {
  const map = buildTrendingMap([
    {
      dexId: 'bags-fm',
      baseToken: { address: 'MintA', symbol: 'BAGS' },
      volume: { h1: 2000, m5: 250 },
      priceChange: { h1: 3, m5: 1 },
      txns: { h1: { buys: 8, sells: 2 } },
      _gmgn: { source: 'bags-swarm' },
    },
    {
      mint: 'MintB',
      symbol: 'GMGN',
      volume1h: 10000,
      priceChange1h: 7,
      buys1h: 14,
      sells1h: 7,
      buyRatio: 2,
    },
  ]);

  assert.equal(map.size, 2);
  assert.equal(map.get('MintA').bagsSignal, true);
  assert.equal(map.get('MintB').volume1h, 10000);
});
