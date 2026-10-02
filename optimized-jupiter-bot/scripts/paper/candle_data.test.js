const { test } = require('node:test');
const assert = require('node:assert/strict');
const { candleRequest, normalizeCandles } = require('./candle_data');
const { closedCandles } = require('./quality_entry');
test('requests use observed live endpoint millisecond contract', () => {
  assert.deepEqual(candleRequest('mint', 1790196847415), { chain: 'sol', address: 'mint', resolution: '1m', from: 1790189647415, to: 1790196847415 });
});
test('millisecond and second responses normalize to identical closed history', () => {
  const now = 1790196847415, current = Math.floor(now / 60000) * 60000;
  const raw = Array.from({ length: 101 }, (_, i) => ({ time: current - (100 - i) * 60000, open: '1', high: '1.1', low: '.9', close: '1' }));
  const normalized = normalizeCandles(raw);
  assert.deepEqual(normalized, normalizeCandles(raw.map(c => ({ ...c, time: c.time / 1000 }))));
  assert.equal(raw[0].time, current - 6000000);
  assert.equal(closedCandles(normalized, now).length, 90);
  assert.equal(closedCandles(normalized, now).at(-1).time, current / 1000 - 60);
  const captured = normalizeCandles(raw, now);
  assert.equal(captured.length, 100);
  assert.throws(() => closedCandles(captured, now + 60000), /stale/);
});
test('empty, bad timestamps, fractional milliseconds and invalid OHLC fail closed', () => {
  assert.throws(() => closedCandles(normalizeCandles([]), Date.now()), /insufficient/);
  for (const time of [null, '', NaN, -1, 1790196840001]) assert.throws(() => normalizeCandles([{ time }]));
  assert.throws(() => normalizeCandles({}));
  assert.throws(() => normalizeCandles([{ time: 1790196900000 }], 1790196847415), /future/);
  assert.throws(() => normalizeCandles([], NaN), /capture/);
  assert.throws(() => closedCandles(normalizeCandles([{ time: 1790196840000, open: '1', high: '.5', low: '.1', close: '1' }]), 1790196900000), /invalid/);
});
