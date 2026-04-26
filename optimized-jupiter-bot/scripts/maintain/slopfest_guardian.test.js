const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseGemmaBootLine,
  parseRuntimeBannerLine,
  detectGuardianAnomalies,
} = require('./slopfest_guardian.ts');

function baseState() {
  return {
    restartHistory: {
      'pcp-sniper-1': [
        { ts: 560_000, restarts: 4, uptimeMs: 40_000 },
        { ts: 780_000, restarts: 6, uptimeMs: 35_000 },
      ],
    },
    remediationCooldowns: {},
    underfilledSince: 1_000,
    lastIncidentByKey: {},
  };
}

function baseServices() {
  return [
    { name: 'pcp-sniper-1', status: 'online', restarts: 6, uptimeMs: 35_000, scriptPath: 'scripts/maintain/momentum_sniper.ts' },
    { name: 'pcp-wallet-monitor', status: 'online', restarts: 0, uptimeMs: 500_000, scriptPath: 'scripts/maintain/wallet_monitor.ts' },
    { name: 'pcp-velocity-stream', status: 'online', restarts: 0, uptimeMs: 500_000, scriptPath: 'scripts/maintain/velocity_stream.ts' },
    { name: 'pcp-gemma4-refiner', status: 'online', restarts: 0, uptimeMs: 500_000, scriptPath: 'scripts/maintain/gemma4_auto_refiner.py' },
  ];
}

test('parsers extract boot and runtime banner config values', () => {
  assert.deepEqual(
    parseGemmaBootLine('[SNIPER]  GEMMA4 BOOT: TP=25.0% SL=15.0% HOLD=2min HUNTER_MULT=0.5'),
    { tpPct: 25, slPct: 15, holdMinutes: 2 },
  );
  assert.deepEqual(
    parseRuntimeBannerLine('[SNIPER] Scout slots: 5/poll | Hold: 5min | SL/TP: 6%/10%'),
    { holdMinutes: 5, slPct: 6, tpPct: 10 },
  );
});

test('detectGuardianAnomalies flags restart flaps, stale feeds, profile drift, and entrypoint drift', () => {
  const anomalies = detectGuardianAnomalies({
    now: 800_000,
    services: baseServices(),
    state: baseState(),
    journalAgeMs: 60_000,
    latestJournalTs: 240_000,
    walletSignalsAgeMs: 6 * 60_000,
    profileEventsAgeMs: 25 * 60_000,
    profileStatsAgeMs: 22 * 60_000,
    openPositions: 8,
    bootConfig: { tpPct: 25, slPct: 15, holdMinutes: 2 },
    runtimeBanner: { tpPct: 10, slPct: 6, holdMinutes: 5 },
    gemmaConfig: { tpPct: 25, slPct: 15, holdMinutes: 2 },
    activeMode: 'normal',
    microRuntimeConfig: { tpPct: 10, slPct: 6, holdMinutes: 2 },
  });

  assert.ok(anomalies.some((item) => item.type === 'restart_flap'));
  assert.ok(anomalies.some((item) => item.type === 'feed_stale'));
  assert.ok(anomalies.some((item) => item.type === 'profile_stale'));
  assert.ok(anomalies.some((item) => item.type === 'quota_degraded'));
  assert.ok(anomalies.some((item) => item.type === 'config_drift'));
  assert.ok(anomalies.some((item) => item.type === 'refiner_entrypoint_drift'));
});

test('detectGuardianAnomalies does not flag config drift when micro-only runtime matches micro config', () => {
  const anomalies = detectGuardianAnomalies({
    now: 800_000,
    services: baseServices(),
    state: baseState(),
    journalAgeMs: 60_000,
    latestJournalTs: 240_000,
    walletSignalsAgeMs: 60_000,
    profileEventsAgeMs: 60_000,
    profileStatsAgeMs: 60_000,
    openPositions: 4,
    bootConfig: { tpPct: 25, slPct: 15, holdMinutes: 2 },
    runtimeBanner: { tpPct: 10, slPct: 6, holdMinutes: 2 },
    gemmaConfig: { tpPct: 25, slPct: 15, holdMinutes: 2 },
    activeMode: 'micro-only',
    microRuntimeConfig: { tpPct: 10, slPct: 6, holdMinutes: 2 },
  });

  assert.ok(!anomalies.some((item) => item.type === 'config_drift'));
  assert.ok(anomalies.some((item) => item.type === 'restart_flap'));
  assert.ok(anomalies.some((item) => item.type === 'refiner_entrypoint_drift'));
});

test('detectGuardianAnomalies marks stale journals when upstream feeds are online', () => {
  const anomalies = detectGuardianAnomalies({
    now: 400_000,
    services: baseServices(),
    state: { ...baseState(), underfilledSince: null },
    journalAgeMs: 11 * 60_000,
    latestJournalTs: 0,
    walletSignalsAgeMs: 60_000,
    profileEventsAgeMs: 60_000,
    profileStatsAgeMs: 60_000,
    openPositions: 15,
    bootConfig: null,
    runtimeBanner: null,
    gemmaConfig: null,
  });

  assert.ok(anomalies.some((item) => item.type === 'journal_stale'));
});

test('detectGuardianAnomalies does not flag profile drift when profile artifacts age in lockstep with the journal', () => {
  const anomalies = detectGuardianAnomalies({
    now: 2_000_000,
    services: baseServices(),
    state: { ...baseState(), underfilledSince: 1_000 },
    journalAgeMs: 27 * 60_000,
    latestJournalTs: 368_000,
    walletSignalsAgeMs: 30_000,
    executableBuySignalCount: 1,
    profileEventsAgeMs: 27 * 60_000,
    profileStatsAgeMs: 27 * 60_000,
    openPositions: 0,
    bootConfig: null,
    runtimeBanner: null,
    gemmaConfig: null,
  });

  assert.ok(!anomalies.some((item) => item.type === 'profile_stale'));
  assert.ok(!anomalies.some((item) => item.type === 'quota_degraded'));
  assert.ok(!anomalies.some((item) => item.type === 'journal_stale'));
});

test('detectGuardianAnomalies ignores restart flap when pm2 restart counters reset after a clean redeploy', () => {
  const state = {
    ...baseState(),
    restartHistory: {
      'pcp-sniper-1': [
        { ts: 560_000, restarts: 4950, uptimeMs: 25_000 },
        { ts: 780_000, restarts: 4957, uptimeMs: 20_000 },
      ],
    },
  };
  const services = [
    { name: 'pcp-sniper-1', status: 'online', restarts: 0, uptimeMs: 35_000, scriptPath: 'scripts/maintain/momentum_sniper.ts' },
    { name: 'pcp-wallet-monitor', status: 'online', restarts: 0, uptimeMs: 500_000, scriptPath: 'scripts/maintain/wallet_monitor.ts' },
    { name: 'pcp-velocity-stream', status: 'online', restarts: 0, uptimeMs: 500_000, scriptPath: 'scripts/maintain/velocity_stream.ts' },
    { name: 'pcp-gemma4-refiner', status: 'online', restarts: 0, uptimeMs: 500_000, scriptPath: 'scripts/maintain/gemma4_slopfest_refiner.py' },
  ];

  const anomalies = detectGuardianAnomalies({
    now: 800_000,
    services,
    state,
    journalAgeMs: 60_000,
    latestJournalTs: 240_000,
    walletSignalsAgeMs: 60_000,
    profileEventsAgeMs: 60_000,
    profileStatsAgeMs: 60_000,
    openPositions: 12,
    bootConfig: { tpPct: 25, slPct: 15, holdMinutes: 2 },
    runtimeBanner: { tpPct: 25, slPct: 15, holdMinutes: 2 },
    gemmaConfig: { tpPct: 25, slPct: 15, holdMinutes: 2 },
    activeMode: 'normal',
    microRuntimeConfig: null,
  });

  assert.ok(!anomalies.some((item) => item.type === 'restart_flap'));
  assert.ok(!anomalies.some((item) => item.type === 'refiner_entrypoint_drift'));
});

test('detectGuardianAnomalies accepts refiner entrypoint when pm2 uses python interpreter with script args', () => {
  const services = [
    { name: 'pcp-sniper-1', status: 'online', restarts: 6, uptimeMs: 150_000, scriptPath: 'scripts/maintain/momentum_sniper.ts' },
    { name: 'pcp-wallet-monitor', status: 'online', restarts: 0, uptimeMs: 500_000, scriptPath: 'scripts/maintain/wallet_monitor.ts' },
    { name: 'pcp-velocity-stream', status: 'online', restarts: 0, uptimeMs: 500_000, scriptPath: 'scripts/maintain/velocity_stream.ts' },
    {
      name: 'pcp-gemma4-refiner',
      status: 'online',
      restarts: 0,
      uptimeMs: 500_000,
      scriptPath: '/usr/bin/python3',
      scriptArgs: '/var/www/pcprotocol/scripts/maintain/gemma4_slopfest_refiner.py',
    },
  ];

  const anomalies = detectGuardianAnomalies({
    now: 800_000,
    services,
    state: baseState(),
    journalAgeMs: 60_000,
    latestJournalTs: 240_000,
    walletSignalsAgeMs: 60_000,
    profileEventsAgeMs: 60_000,
    profileStatsAgeMs: 60_000,
    openPositions: 12,
    bootConfig: { tpPct: 25, slPct: 15, holdMinutes: 2 },
    runtimeBanner: { tpPct: 25, slPct: 15, holdMinutes: 2 },
    gemmaConfig: { tpPct: 25, slPct: 15, holdMinutes: 2 },
    activeMode: 'normal',
    microRuntimeConfig: null,
  });

  assert.ok(!anomalies.some((item) => item.type === 'refiner_entrypoint_drift'));
});
