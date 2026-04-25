const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRetryAfterMs,
  resolveJupiterRateLimitBackoffMs,
  getJupiterRateLimitRemainingMs,
  isJupiterRateLimitActive,
} = require('./jupiter_rate_limit_logic.ts');

test('parseRetryAfterMs parses retry-after seconds', () => {
  assert.equal(parseRetryAfterMs('4'), 4000);
});

test('resolveJupiterRateLimitBackoffMs uses retry-after header when present', () => {
  assert.equal(
    resolveJupiterRateLimitBackoffMs({
      retryAfterHeader: '7',
      strikeCount: 4,
      minBackoffMs: 2000,
      maxBackoffMs: 20000,
    }),
    7000,
  );
});

test('resolveJupiterRateLimitBackoffMs falls back to exponential backoff', () => {
  assert.equal(
    resolveJupiterRateLimitBackoffMs({
      strikeCount: 3,
      minBackoffMs: 2000,
      maxBackoffMs: 20000,
    }),
    16000,
  );
});

test('getJupiterRateLimitRemainingMs clamps elapsed windows to zero', () => {
  assert.equal(getJupiterRateLimitRemainingMs(Date.now() - 1000, Date.now()), 0);
});

test('isJupiterRateLimitActive reports true while cooldown remains', () => {
  const now = Date.now();
  assert.equal(isJupiterRateLimitActive(now + 1500, now), true);
  assert.equal(isJupiterRateLimitActive(now - 1, now), false);
});
