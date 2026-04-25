const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyVelocityStreamError,
  resolveVelocityStreamReconnectDelayMs,
} = require('./velocity_stream_reconnect_logic.ts');

test('classifyVelocityStreamError detects 429 rate limits', () => {
  const result = classifyVelocityStreamError('Unexpected server response: 429');
  assert.equal(result.rateLimited, true);
  assert.equal(result.idleTimeout, false);
});

test('classifyVelocityStreamError detects idle timeout', () => {
  const result = classifyVelocityStreamError('stream idle timeout exceeded');
  assert.equal(result.rateLimited, false);
  assert.equal(result.idleTimeout, true);
});

test('resolveVelocityStreamReconnectDelayMs uses stronger backoff for 429', () => {
  const generic = resolveVelocityStreamReconnectDelayMs({ attempt: 1, baseMs: 2_000, rateLimitedBaseMs: 10_000 });
  const rateLimited = resolveVelocityStreamReconnectDelayMs({ attempt: 1, rateLimited: true, baseMs: 2_000, rateLimitedBaseMs: 10_000 });
  assert.equal(generic, 4_000);
  assert.equal(rateLimited, 20_000);
});

test('resolveVelocityStreamReconnectDelayMs caps at max', () => {
  const delay = resolveVelocityStreamReconnectDelayMs({
    attempt: 8,
    rateLimited: true,
    rateLimitedBaseMs: 10_000,
    maxMs: 60_000,
  });
  assert.equal(delay, 60_000);
});
