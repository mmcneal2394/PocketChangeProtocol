const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rankDiscoveryQueue } = require('./live_paper_worker');

const row = (mint, source, liquidityUsd) => ({ mint, source, liquidityUsd, discoveredAt: 100 });

test('discovery ranking interleaves acceleration, retrace, and Bags lanes', () => {
  const ranked = rankDiscoveryQueue([
    row('a-low', 'gmgn-1m', 8_000),
    row('a-high', 'gmgn-1m', 80_000),
    row('r-low', 'gmgn-1h', 9_000),
    row('r-high', 'gmgn-1h', 90_000),
    row('b-one', 'bags', 0),
    row('b-two', 'bags', 0),
  ]);
  assert.deepEqual(ranked.slice(0, 3).map(candidate => candidate.mint), ['a-high', 'r-high', 'b-one']);
  assert.deepEqual(ranked.slice(3).map(candidate => candidate.mint), ['a-low', 'r-low', 'b-two']);
});

test('never-checked candidates rank before revisits and older checks rank first', () => {
  const observations = new Map([
    ['recent', { checkedAt: 300 }],
    ['older', { checkedAt: 200 }],
  ]);
  const ranked = rankDiscoveryQueue([
    row('recent', 'gmgn-1m', 1_000_000),
    row('new', 'gmgn-1m', 8_000),
    row('older', 'gmgn-1m', 10_000),
  ], observations);
  assert.deepEqual(ranked.map(candidate => candidate.mint), ['new', 'older', 'recent']);
});

test('duplicate mints prefer GMGN lane metadata and retain strongest known liquidity', () => {
  const ranked = rankDiscoveryQueue([
    row('same', 'bags', 0),
    row('same', 'gmgn-1h', 25_000),
    row('same', 'gmgn-1m', 20_000),
  ]);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].source, 'gmgn-1m');
  assert.equal(ranked[0].liquidityUsd, 25_000);
  assert.deepEqual(ranked[0].discoverySources, ['bags', 'gmgn-1h', 'gmgn-1m']);
});
