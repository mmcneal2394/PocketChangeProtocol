const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStagedLaunchRadar } = require('./staged_launch_radar.ts');

const MINT = '11111111111111111111111111111111';

function input(overrides = {}) {
  return {
    schemaVersion: 'staged-launch-radar-input/v1',
    generatedAt: 1_700_000_000_000,
    gmgnCandidates: [{
      mint: MINT,
      detectedAt: 1_700_000_000_000,
      poolId: 'pool-a',
      name: 'Unique Token',
      symbol: 'UNIQ',
      imageUrl: 'https://cdn.example.com/unique.png?cache=1',
    }],
    ...overrides,
  };
}

test('issues a paper-only entry candidate after parallel evidence agrees', () => {
  const result = buildStagedLaunchRadar(input({
    heliusByMint: { [MINT]: { confirmed: true, mintSafe: true, poolId: 'pool-a' } },
    bagsByMint: { [MINT]: { launchKnown: true, poolId: 'pool-a' } },
    marketByMint: { [MINT]: { fresh: true, poolId: 'pool-a', priceUsd: 0.0001, liquidityUsd: 2500 } },
  }));
  assert.equal(result.execution.mode, 'paper_only');
  assert.equal(result.execution.signing, 'disabled');
  assert.equal(result.candidates[0].decision, 'paper_entry_candidate');
});

test('keeps a fast GMGN trigger provisional while critical enrichment is pending', () => {
  const result = buildStagedLaunchRadar(input());
  assert.equal(result.candidates[0].decision, 'provisional_candidate');
  assert.ok(result.candidates[0].reasons.includes('awaiting_helius_confirmation'));
  assert.ok(result.candidates[0].reasons.includes('awaiting_fresh_independent_market_mark'));
});

test('rejects conflicts and suspected common-control flow', () => {
  const result = buildStagedLaunchRadar(input({
    heliusByMint: { [MINT]: { confirmed: true, mintSafe: true, poolId: 'pool-b', commonControlSuspected: true } },
    marketByMint: { [MINT]: { fresh: true, poolId: 'pool-a', priceUsd: 0.0001, liquidityUsd: 2500 } },
  }));
  assert.equal(result.candidates[0].decision, 'reject');
  assert.ok(result.candidates[0].reasons.includes('cross_pool_conflict'));
  assert.ok(result.candidates[0].reasons.includes('common_control_flow_suspected'));
});

test('deduplicates GMGN snapshots without applying a duplicate-media boundary', () => {
  const result = buildStagedLaunchRadar(input({
    gmgnCandidates: [
      { mint: MINT, detectedAt: 10, poolId: 'pool-a', name: 'Unique Token', symbol: 'UNIQ', imageUrl: 'https://cdn.example.com/unique.png?one' },
      { mint: MINT, detectedAt: 20, poolId: 'pool-a', name: 'Unique Token', symbol: 'UNIQ', imageUrl: 'https://cdn.example.com/unique.png?two' },
    ],
    knownDeployments: [{
      mint: 'SysvarRent111111111111111111111111111111111',
      firstSeenAt: 5,
      name: 'Unique Token',
      symbol: 'UNIQ',
      imageUrl: 'https://cdn.example.com/unique.png',
    }],
  }));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].provisional.detectedAt, 20);
  assert.ok(!result.candidates[0].reasons.includes('duplicate_media_noncanonical_deployment'));
});
