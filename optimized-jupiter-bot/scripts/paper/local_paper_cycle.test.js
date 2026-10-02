const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLocalPaperTraderInput } = require('./local_paper_cycle.ts');

const MINT = '11111111111111111111111111111111';

test('converts agreeing source snapshots into a paper-only trader input', () => {
  const output = buildLocalPaperTraderInput({
    schemaVersion: 'local-paper-cycle-input/v1',
    radarInput: {
      schemaVersion: 'staged-launch-radar-input/v1',
      generatedAt: 1_700_000_000_000,
      gmgnCandidates: [{ mint: MINT, detectedAt: 1_700_000_000_000, poolId: 'pool-a', symbol: 'PAPER' }],
      heliusByMint: { [MINT]: { confirmed: true, mintSafe: true, poolId: 'pool-a' } },
      bagsByMint: { [MINT]: { launchKnown: true, poolId: 'pool-a' } },
      marketByMint: { [MINT]: { fresh: true, poolId: 'pool-a', priceSol: 0.001, liquidityUsd: 3000 } },
    },
    rpcUsage: { helius: { requests: 1, successes: 1, errors: 0, averageLatencyMs: 23 } },
  });
  assert.equal(output.candidates[0].decision, 'paper_entry_candidate');
  assert.equal(output.marksByMint[MINT].priceSol, 0.001);
  assert.equal(output.pipeline.gmgn.status, 'fresh');
  assert.equal(output.rpcUsage.helius.requests, 1);
});
