const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectRegime,
  createAtrBuffer,
  pushAtr,
  getAtrStats,
} = require('./regime_detection_logic.ts');

// ── detectRegime ───────────────────────────────────────────────────────────

test('detectRegime: high volatility regime when ratio > 1.3', () => {
  const result = detectRegime({ currentAtr: 10, longTermAtr: 5 });
  assert.equal(result.label, 'HIGH_VOL');
  assert.ok(Math.abs(result.regimeFactor - 2.0) < 0.01);
  assert.equal(result.kellyMultiplier, 0.5);
});

test('detectRegime: low volatility regime when ratio < 0.8', () => {
  const result = detectRegime({ currentAtr: 3, longTermAtr: 5 });
  assert.equal(result.label, 'LOW_VOL');
  assert.ok(Math.abs(result.regimeFactor - 0.6) < 0.01);
  assert.equal(result.kellyMultiplier, 1.2);
});

test('detectRegime: normal regime when 0.8 <= ratio <= 1.3', () => {
  const result = detectRegime({ currentAtr: 5, longTermAtr: 5 });
  assert.equal(result.label, 'NORMAL');
  assert.ok(Math.abs(result.regimeFactor - 1.0) < 0.01);
  assert.equal(result.kellyMultiplier, 1.0);
});

test('detectRegime: exactly at high threshold is NORMAL (not >)', () => {
  const result = detectRegime({ currentAtr: 6.5, longTermAtr: 5 });
  // 6.5/5 = 1.3 — boundary is NORMAL
  assert.equal(result.label, 'NORMAL');
});

test('detectRegime: custom thresholds work', () => {
  const result = detectRegime({ currentAtr: 6, longTermAtr: 5, highVolThreshold: 1.1 });
  // 6/5 = 1.2 > 1.1 → HIGH_VOL
  assert.equal(result.label, 'HIGH_VOL');
});

test('detectRegime: custom multipliers work', () => {
  const result = detectRegime({ currentAtr: 10, longTermAtr: 5, highVolMultiplier: 0.3 });
  assert.equal(result.kellyMultiplier, 0.3);
});

test('detectRegime: zero longTermAtr does not crash', () => {
  const result = detectRegime({ currentAtr: 5, longTermAtr: 0 });
  assert.equal(result.label, 'HIGH_VOL');
});

// ── ATR buffer management ──────────────────────────────────────────────────

test('ATR buffer: empty buffer returns defaults', () => {
  const buffer = createAtrBuffer(50);
  const stats = getAtrStats(buffer);
  assert.equal(stats.currentAtr, 5.0);
  assert.equal(stats.longTermAtr, 5.0);
  assert.equal(stats.sampleCount, 0);
});

test('ATR buffer: pushAtr adds values', () => {
  let buffer = createAtrBuffer(50);
  buffer = pushAtr(buffer, 3.0);
  buffer = pushAtr(buffer, 5.0);
  buffer = pushAtr(buffer, 7.0);
  assert.deepEqual(buffer.values, [3, 5, 7]);
});

test('ATR buffer: caps at maxSize', () => {
  let buffer = createAtrBuffer(3);
  buffer = pushAtr(buffer, 1);
  buffer = pushAtr(buffer, 2);
  buffer = pushAtr(buffer, 3);
  buffer = pushAtr(buffer, 4);
  assert.deepEqual(buffer.values, [2, 3, 4]);
});

test('ATR buffer: getAtrStats computes correct means', () => {
  let buffer = createAtrBuffer(50);
  for (let i = 0; i < 10; i++) buffer = pushAtr(buffer, 2.0);
  for (let i = 0; i < 10; i++) buffer = pushAtr(buffer, 8.0);

  const stats = getAtrStats(buffer, 10);
  assert.ok(Math.abs(stats.currentAtr - 8.0) < 0.01);
  assert.ok(Math.abs(stats.longTermAtr - 5.0) < 0.01);
  assert.equal(stats.sampleCount, 20);
});
