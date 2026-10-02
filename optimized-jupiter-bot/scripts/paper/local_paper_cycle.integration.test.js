const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLocalPaperTraderInput } = require('./local_paper_cycle.ts');
const {
  createLocalPaperTraderState,
  runLocalPaperTrader,
  summarizeLocalPaperTrader,
} = require('./local_paper_trader.ts');

const MINT = '11111111111111111111111111111111';
const START = 1_700_000_000_000;

function cycleAt(generatedAt, priceSol) {
  return {
    schemaVersion: 'local-paper-cycle-input/v1',
    radarInput: {
      schemaVersion: 'staged-launch-radar-input/v1',
      generatedAt,
      gmgnCandidates: [{
        mint: MINT,
        symbol: 'TEST',
        detectedAt: generatedAt,
        poolId: 'pool-test',
        name: 'Pipeline Test Token',
      }],
      heliusByMint: { [MINT]: { confirmed: true, mintSafe: true, poolId: 'pool-test' } },
      bagsByMint: { [MINT]: { launchKnown: true, poolId: 'pool-test' } },
      marketByMint: { [MINT]: { fresh: true, poolId: 'pool-test', priceSol, liquidityUsd: 5_000, observedAt: generatedAt } },
    },
    rpcUsage: {
      gmgn: { requests: 1, successes: 1, errors: 0, averageLatencyMs: 120 },
      helius: { requests: 1, successes: 1, errors: 0, averageLatencyMs: 40 },
      bags: { requests: 1, successes: 1, errors: 0, averageLatencyMs: 75 },
    },
  };
}

test('paper cycle executes the full staged lifecycle without live execution', () => {
  const state = createLocalPaperTraderState({ startingCapitalSol: 1, initialPositionSol: 0.1, modeledFeeBps: 0 });

  const opened = runLocalPaperTrader(state, buildLocalPaperTraderInput(cycleAt(START, 0.01)));
  assert.equal(opened.positions.length, 1);
  assert.equal(opened.positions[0].symbol, 'TEST');
  assert.equal(opened.execution.broadcasting, 'disabled');
  assert.equal(opened.pipeline.gmgn.status, 'fresh');

  const rotated = runLocalPaperTrader(opened, buildLocalPaperTraderInput(cycleAt(START + 10 * 60_000, 0.02)));
  assert.equal(rotated.positions[0].rotationAt, START + 10 * 60_000);
  assert.equal(rotated.positions[0].remainingTokenAmount, rotated.positions[0].originalTokenAmount * 0.25);
  assert.equal(rotated.events[0].type, 'rotation_75');

  const closed = runLocalPaperTrader(rotated, buildLocalPaperTraderInput(cycleAt(START + 4 * 60 * 60_000, 0.03)));
  const summary = summarizeLocalPaperTrader(closed, closed.marksByMint);
  assert.equal(closed.positions[0].closedAt, START + 4 * 60 * 60_000);
  assert.equal(closed.events[0].type, 'force_close_4h');
  assert.equal(summary.closedPositions, 1);
  assert.equal(summary.largestWinSymbol, 'TEST');
  assert.equal(summary.totalRpcRequests, 3);
});
