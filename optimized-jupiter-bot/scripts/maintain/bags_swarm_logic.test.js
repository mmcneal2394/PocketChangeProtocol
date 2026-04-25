const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractCandidateMintsFromParsedTx,
  buildBagsTrendingEntry,
  estimateBagsVelocitySignal,
} = require('./bags_swarm_logic.ts');

test('extractCandidateMintsFromParsedTx excludes quote mints and keeps token candidates', () => {
  const mints = extractCandidateMintsFromParsedTx({
    meta: {
      postTokenBalances: [
        { mint: 'So11111111111111111111111111111111111111112' },
        { mint: 'MintAAA' },
      ],
      preTokenBalances: [
        { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
        { mint: 'MintBBB' },
      ],
    },
  });

  assert.deepEqual(mints.sort(), ['MintAAA', 'MintBBB']);
});

test('buildBagsTrendingEntry produces Dex-style trending payload', () => {
  const entry = buildBagsTrendingEntry({
    mint: 'MintAAA',
    symbol: 'BAGS',
    name: 'Bags Token',
    url: 'https://dexscreener.com/solana/test',
    dexId: 'bags-fm',
    liquidityUsd: 12000,
    volume1h: 50000,
    volume5m: 2500,
    priceChange1h: 12,
    priceChange5m: 4,
    fdvUsd: 70000,
    pairCreatedAt: 123,
    buys1h: 42,
    sells1h: 10,
  }, {
    source: 'bags-swarm',
    signature: 'sig123',
    launchpad: 'pumpfun',
    updatedAt: 456,
  });

  assert.equal(entry.dexId, 'bags-fm');
  assert.equal(entry.baseToken.address, 'MintAAA');
  assert.equal(entry._bags.launchpad, 'pumpfun');
  assert.equal(entry.txns.h1.buys, 42);
});

test('estimateBagsVelocitySignal derives conservative launch velocity from pair stats', () => {
  const now = Date.now();
  const signal = estimateBagsVelocitySignal({
    mint: 'MintAAA',
    symbol: 'BAGS',
    dexId: 'bags-fm',
    liquidityUsd: 20000,
    volume1h: 120000,
    volume5m: 3000,
    priceChange1h: 10,
    priceChange5m: 3,
    fdvUsd: 150000,
    pairCreatedAt: now - 5 * 60_000,
    buys1h: 100,
    sells1h: 20,
  }, now, 150);

  assert.equal(signal.isAccelerating, true);
  assert.ok(signal.buys60s >= 20);
  assert.ok(signal.buyRatio60s > 0.5);
  assert.ok(signal.solVolume60s > 0);
});
