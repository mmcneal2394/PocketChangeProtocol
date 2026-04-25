const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeGmgnBanUntilMs,
  getGmgnBanWaitMs,
  isGmgnRateLimitMessage,
  isGmgnTemporaryBanMessage,
  normalizeGmgnMessage,
} = require('./gmgn_pressure_logic.ts');

test('normalizeGmgnMessage collapses ANSI and multiline output', () => {
  assert.equal(
    normalizeGmgnMessage('\u001b[31m[gmgn-cli]\u001b[0m GET failed:\r\nHTTP 429 code=429 error=RATE_LIMIT_BANNED'),
    '[gmgn-cli] GET failed:\nHTTP 429 code=429 error=RATE_LIMIT_BANNED',
  );
});

test('isGmgnTemporaryBanMessage detects GMGN ban wording', () => {
  assert.equal(
    isGmgnTemporaryBanMessage('IP is temporarily banned due to repeated rate limit violations.'),
    true,
  );
  assert.equal(isGmgnTemporaryBanMessage('plain 429 without ban wording'), false);
  assert.equal(
    isGmgnTemporaryBanMessage('[gmgn-cli] GET failed:\nIP is temporarily banned due to repeated rate limit violations.'),
    true,
  );
});

test('isGmgnRateLimitMessage detects generic rate-limit failures', () => {
  assert.equal(isGmgnRateLimitMessage('HTTP 429 code=429 error=RATE_LIMIT_BANNED'), true);
  assert.equal(isGmgnRateLimitMessage('Too Many Requests'), true);
  assert.equal(isGmgnRateLimitMessage('network timeout'), false);
});

test('getGmgnBanWaitMs parses remaining-seconds hints', () => {
  assert.equal(
    getGmgnBanWaitMs('Rate limit resets at ... (~300s remaining).', 60_000),
    302_000,
  );
});

test('computeGmgnBanUntilMs falls back when no hint is present', () => {
  assert.equal(
    computeGmgnBanUntilMs('HTTP 429 without countdown', 90_000, 1_000),
    91_000,
  );
});
