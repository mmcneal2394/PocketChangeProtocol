const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  scheduleMarkout,
  loadMarkoutPending,
  processDueMarkouts,
  buildMarkoutSummaryFromRows,
  evaluateMarkoutProbeAssist,
} = require('./markout_tracker_logic.ts');

function tempPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcp-markout-'));
  return {
    dir,
    pendingFilePath: path.join(dir, 'markout_pending.json'),
    resultsFilePath: path.join(dir, 'markout_results.jsonl'),
    summaryFilePath: path.join(dir, 'markout_summary.json'),
  };
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('scheduleMarkout stores reject horizons and dedupes active pending items', () => {
  const paths = tempPaths();
  const now = 1_000_000;
  const first = scheduleMarkout({
    mint: 'mint-a',
    symbol: 'A',
    stage: 'velocity_first',
    reason: 'low_liq_route_preflight',
    entryMode: 'micro-scout',
    sourceLane: 'velocity-first',
    priceUsd: 0.01,
    liquidityUsd: 1_000,
  }, { ...paths, now, horizonsSec: [60, 180] });
  const second = scheduleMarkout({
    mint: 'mint-a',
    stage: 'velocity_first',
    reason: 'low_liq_route_preflight',
    entryMode: 'micro-scout',
  }, { ...paths, now: now + 1_000, horizonsSec: [60, 180] });

  assert.equal(first.scheduled, true);
  assert.equal(second.scheduled, false);
  assert.equal(second.reason, 'already_pending');
  const pending = loadMarkoutPending(paths);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].horizons.length, 2);
  assert.equal(pending[0].baseline.priceUsd, 0.01);
});

test('processDueMarkouts identifies missed winners from forward markout', async () => {
  const paths = tempPaths();
  const now = 2_000_000;
  scheduleMarkout({
    mint: 'mint-b',
    symbol: 'B',
    stage: 'alpha-entry',
    reason: 'expected_value_negative',
    entryMode: 'normal',
    sourceLane: 'alpha',
    priceUsd: 0.01,
    marketCapUsd: 100_000,
    liquidityUsd: 10_000,
  }, { ...paths, now, horizonsSec: [60] });

  const result = await processDueMarkouts({
    ...paths,
    now: now + 61_000,
    fetchPair: async () => ({
      priceUsd: 0.013,
      marketCap: 135_000,
      liquidity: 14_000,
      priceChange5m: 20,
      volume1h: 80_000,
    }),
  });

  assert.equal(result.processed, 1);
  assert.equal(result.missedWinners, 1);
  const rows = readJsonl(paths.resultsFilePath);
  assert.equal(rows[0].status, 'missed_winner');
  assert.equal(rows[0].missedWinner, true);
  assert.ok(rows[0].returnPct >= 30);
});

test('processDueMarkouts does not call rolling momentum a missed winner when forward price fell', async () => {
  const paths = tempPaths();
  const now = 2_500_000;
  scheduleMarkout({
    mint: 'mint-b2',
    symbol: 'B2',
    stage: 'velocity_first',
    reason: 'low_liq_route_preflight',
    entryMode: 'micro-scout',
    sourceLane: 'velocity-first-preflight',
    priceUsd: 0.01,
    marketCapUsd: 10_000,
    liquidityUsd: 0,
  }, { ...paths, now, horizonsSec: [60] });

  await processDueMarkouts({
    ...paths,
    now: now + 61_000,
    fetchPair: async () => ({
      priceUsd: 0.009,
      marketCap: 9_000,
      liquidity: 0,
      priceChange5m: 80,
      volume1h: 30_000,
    }),
  });

  const rows = readJsonl(paths.resultsFilePath);
  assert.equal(rows[0].status, 'correct_reject');
  assert.equal(rows[0].missedWinner, false);
  assert.ok(rows[0].returnPct < 0);
});

test('processDueMarkouts classifies missing pairs as correct rejects', async () => {
  const paths = tempPaths();
  const now = 3_000_000;
  scheduleMarkout({
    mint: 'mint-c',
    stage: 'normal-entry',
    reason: 'live_pair_zero_liquidity',
    entryMode: 'normal',
    marketCapUsd: 20_000,
    liquidityUsd: 0,
  }, { ...paths, now, horizonsSec: [60] });

  const result = await processDueMarkouts({
    ...paths,
    now: now + 61_000,
    fetchPair: async () => null,
  });

  assert.equal(result.processed, 1);
  assert.equal(result.correctRejects, 1);
  const rows = readJsonl(paths.resultsFilePath);
  assert.equal(rows[0].status, 'no_pair');
  assert.equal(rows[0].correctReject, true);
});

test('buildMarkoutSummaryFromRows aggregates missed-winner rate by lane and reason', () => {
  const summary = buildMarkoutSummaryFromRows([
    { sourceLane: 'alpha', stage: 'alpha-entry', reason: 'expected_value_negative', status: 'missed_winner', missedWinner: true, returnPct: 24, liquidityDeltaUsd: 1000, ts: 1 },
    { sourceLane: 'alpha', stage: 'alpha-entry', reason: 'expected_value_negative', status: 'correct_reject', correctReject: true, returnPct: -3, liquidityDeltaUsd: -500, ts: 2 },
  ]);

  assert.equal(summary.totals.samples, 2);
  assert.equal(summary.byLane.alpha.missedWinners, 1);
  assert.equal(summary.byReason.expected_value_negative.correctRejects, 1);
  assert.equal(summary.byLane.alpha.missedWinnerRate, 0.5);
});

test('evaluateMarkoutProbeAssist allows quote probes only after enough missed-winner evidence', () => {
  const rows = [];
  for (let i = 0; i < 8; i += 1) {
    rows.push({
      sourceLane: 'velocity-first-preflight',
      stage: 'velocity_first',
      reason: 'low_liq_route_preflight',
      status: 'missed_winner',
      missedWinner: true,
      returnPct: 32,
      ts: i + 1,
    });
  }
  for (let i = 0; i < 14; i += 1) {
    rows.push({
      sourceLane: 'velocity-first-preflight',
      stage: 'velocity_first',
      reason: 'low_liq_route_preflight',
      status: 'correct_reject',
      correctReject: true,
      returnPct: -2,
      ts: 100 + i,
    });
  }
  const summary = buildMarkoutSummaryFromRows(rows);
  const decision = evaluateMarkoutProbeAssist({
    sourceLane: 'velocity-first-preflight',
    reason: 'low_liq_route_preflight',
  }, { summary });

  assert.equal(decision.allowProbe, true);
  assert.equal(decision.code, 'markout_probe_assist_allow');
  assert.equal(decision.samples, 22);
});
