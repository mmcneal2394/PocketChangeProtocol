const test = require('node:test');
const assert = require('node:assert/strict');

const {
  profileToSnapshot,
  diffProfileSnapshot,
  scoreDexBoost,
  scoreDexOrders,
  scoreSocialUpdate,
  scoreGmgnCto,
  dedupeSignals,
  computeCatalystBoost,
} = require('./catalyst_signal_logic.ts');

test('scoreDexBoost maps paid boost amounts into positive catalyst signals', () => {
  const signal = scoreDexBoost({
    chainId: 'solana',
    tokenAddress: 'MintA',
    amount: 50,
  }, 1_000);

  assert.equal(signal.type, 'DEX_BOOST');
  assert.equal(signal.token_address, 'MintA');
  assert.equal(signal.metadata.boost, 0.16);
  assert.equal(signal.confidence, 0.62);
});

test('scoreDexOrders recognizes community takeover style paid orders', () => {
  const signals = scoreDexOrders('MintB', [
    { type: 'community_takeover', date: '2026-04-22T00:00:00.000Z' },
    { type: 'tokenProfile', date: '2026-04-22T00:00:00.000Z' },
  ], 2_000);

  assert.equal(signals.length, 2);
  assert.equal(signals[0].type, 'DEX_PAID');
  assert.ok(signals.some((signal) => signal.metadata.boost === 0.3));
  assert.ok(signals.some((signal) => signal.metadata.boost === 0.12));
});

test('profile snapshot diff detects social additions and deletions', () => {
  const previous = profileToSnapshot({
    chainId: 'solana',
    tokenAddress: 'MintC',
    links: [
      { type: 'twitter', url: 'https://twitter.com/a' },
      { type: 'telegram', url: 'https://t.me/a' },
    ],
    description: 'alpha',
  }, 1_000);
  const next = profileToSnapshot({
    chainId: 'solana',
    tokenAddress: 'MintC',
    links: [
      { type: 'website', url: 'https://example.com' },
    ],
    description: '',
  }, 2_000);

  const diffs = diffProfileSnapshot(previous, next);
  assert.deepEqual(
    diffs.map((diff) => `${diff.field}:${diff.change}`).sort(),
    ['description:removed', 'telegram:removed', 'twitter:removed', 'website:added'],
  );

  const signals = scoreSocialUpdate('MintC', previous, next, 2_000);
  assert.equal(signals.length, 2);
  assert.ok(signals.some((signal) => signal.metadata.change === 'added'));
  assert.ok(signals.some((signal) => signal.metadata.change === 'removed'));
});

test('scoreGmgnCto emits a CTO_DETECTED signal from GMGN community takeover hints', () => {
  const signal = scoreGmgnCto({
    mint: 'MintD',
    symbol: 'CTO',
    is_cto: true,
  }, 5_000);

  assert.equal(signal.type, 'CTO_DETECTED');
  assert.equal(signal.metadata.boost, 0.35);
});

test('dedupeSignals keeps newest active signal per signal key and computeCatalystBoost caps totals', () => {
  const duplicated = dedupeSignals([
    {
      id: 'a',
      source: 'dexscreener',
      type: 'DEX_BOOST',
      timestamp: 100,
      token_address: 'MintE',
      sentiment_score: 1,
      confidence: 0.5,
      kol_reputation_score: 0,
      expires_at: 10_000,
      metadata: { boost: 0.16, signalKey: 'same' },
    },
    {
      id: 'b',
      source: 'dexscreener',
      type: 'DEX_BOOST',
      timestamp: 200,
      token_address: 'MintE',
      sentiment_score: 1,
      confidence: 0.6,
      kol_reputation_score: 0,
      expires_at: 10_000,
      metadata: { boost: 0.20, signalKey: 'same' },
    },
    {
      id: 'c',
      source: 'dexscreener',
      type: 'SOCIAL_UPDATE',
      timestamp: 300,
      token_address: 'MintE',
      sentiment_score: -1,
      confidence: 1,
      kol_reputation_score: 0,
      expires_at: 10_000,
      metadata: { boost: -0.15, signalKey: 'neg' },
    },
  ], 500);

  assert.equal(duplicated.length, 2);
  const decision = computeCatalystBoost('MintE', duplicated, 500);
  assert.equal(decision.totalBoost, 0.05);
  assert.equal(decision.activeSignals.length, 2);
});
