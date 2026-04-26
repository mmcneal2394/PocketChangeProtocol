import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import dotenv from 'dotenv';
import {
  MIN_QUOTA_POSITIONS,
  TARGET_QUOTA_POSITIONS,
  resolveQuotaAssistLevel,
} from './quota_assist_logic';

dotenv.config();

const execFileAsync = promisify(execFile);

const ROOT = process.cwd();
const SIGNALS_DIR = path.join(ROOT, 'signals');
const IS_PAPER = process.env.PAPER_MODE === 'true';
const STRATEGY_PROFILE_FILE = path.resolve(ROOT, process.env.STRATEGY_PROFILE_PATH || 'config/strategy-profiles/active.strategy.json');
const JOURNAL_FILE = path.join(SIGNALS_DIR, IS_PAPER ? 'trade_journal_paper.jsonl' : 'trade_journal.jsonl');
const PROFILE_EVENTS_FILE = path.join(SIGNALS_DIR, IS_PAPER ? 'trade_profile_events_paper.jsonl' : 'trade_profile_events.jsonl');
const PROFILE_STATS_FILE = path.join(SIGNALS_DIR, IS_PAPER ? 'trade_profile_stats_paper.json' : 'trade_profile_stats.json');
const SNIPER_STATE_FILE = path.join(SIGNALS_DIR, IS_PAPER ? 'sniper_positions_paper.json' : 'sniper_positions.json');
const WALLET_SIGNALS_FILE = path.join(SIGNALS_DIR, 'wallet_signals.json');
const GEMMA_RECOMMENDATIONS_FILE = path.join(SIGNALS_DIR, 'gemma4_recommendations.json');
const SWARM_HEALTH_FILE = path.join(SIGNALS_DIR, 'swarm_health.json');
const LEGACY_GUARDIAN_STATUS_FILE = path.join(SIGNALS_DIR, 'slopfest_guardian_status.json');
const SWARM_INCIDENTS_FILE = path.join(SIGNALS_DIR, 'swarm_incidents.jsonl');
const GUARDIAN_STATE_FILE = path.join(SIGNALS_DIR, 'swarm_guardian_state.json');
const SNIPER_OUT_LOG = path.join(os.homedir(), '.pm2', 'logs', 'pcp-sniper-1-out.log');
const JOURNAL_STALE_MS = 30 * 60_000;
const WALLET_SIGNALS_STALE_MS = 10 * 60_000;
const PROFILE_STALE_MS = 20 * 60_000;
const SNIPER_ERR_LOG = path.join(os.homedir(), '.pm2', 'logs', 'pcp-sniper-1-error.log');
const POLL_MS = Math.max(30_000, Number(process.env.SLOPFEST_GUARDIAN_POLL_MS || 60_000));
const INCIDENT_DEDUP_MS = 10 * 60_000;
const REMEDIATION_COOLDOWN_MS = 10 * 60_000;

const PM2_FOCUS = new Set([
  'pcp-sniper-1',
  'pcp-wallet-monitor',
  'pcp-gmgn-bridge',
  'pcp-bags-swarm',
  'pcp-gemma4-refiner',
  'pcp-velocity-stream',
  'pcp-overview',
]);

type GuardianState = {
  restartHistory: Record<string, Array<{ ts: number; restarts: number; uptimeMs: number | null }>>;
  remediationCooldowns: Record<string, number>;
  underfilledSince: number | null;
  lastIncidentByKey: Record<string, number>;
};

function toFiniteNumber(value: any, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string, limit = 200): any[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function fileAgeMs(filePath: string, now = Date.now()) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return Math.max(0, now - fs.statSync(filePath).mtimeMs);
  } catch {
    return null;
  }
}

function tailLines(filePath: string, maxLines = 300): string[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

function normalizeRestartHistory(
  rows: Array<{ ts: number; restarts: number; uptimeMs: number | null }>,
  now: number,
) {
  const recent = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && (now - Number(row.ts || 0)) <= 5 * 60_000)
    .slice(-10);
  const normalized: Array<{ ts: number; restarts: number; uptimeMs: number | null }> = [];
  for (const row of recent) {
    if (
      normalized.length > 0 &&
      Number(row.restarts || 0) < Number(normalized[normalized.length - 1].restarts || 0)
    ) {
      normalized.length = 0;
    }
    normalized.push({
      ts: Number(row.ts || now),
      restarts: Number(row.restarts || 0),
      uptimeMs: row.uptimeMs ?? null,
    });
  }
  return normalized;
}

export function parseGemmaBootLine(line: string | null | undefined) {
  const match = String(line || '').match(/GEMMA4 BOOT: TP=([\d.]+)% SL=([\d.]+)% HOLD=([\d.]+)min/i);
  if (!match) return null;
  return {
    tpPct: Number(match[1]),
    slPct: Number(match[2]),
    holdMinutes: Number(match[3]),
  };
}

export function parseRuntimeBannerLine(line: string | null | undefined) {
  const match = String(line || '').match(/Hold:\s*([\d.]+)min\s*\|\s*SL\/TP:\s*([\d.]+)%\/([\d.]+)%/i);
  if (!match) return null;
  return {
    holdMinutes: Number(match[1]),
    slPct: Number(match[2]),
    tpPct: Number(match[3]),
  };
}

function loadGuardianState(): GuardianState {
  return readJson<GuardianState>(GUARDIAN_STATE_FILE, {
    restartHistory: {},
    remediationCooldowns: {},
    underfilledSince: null,
    lastIncidentByKey: {},
  });
}

function saveGuardianState(state: GuardianState) {
  if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });
  fs.writeFileSync(GUARDIAN_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

async function getPm2Summary(now = Date.now()) {
  try {
    const { stdout } = await execFileAsync('pm2', ['jlist'], { maxBuffer: 8 * 1024 * 1024 });
    const apps = JSON.parse(stdout || '[]');
    return apps
      .filter((app: any) => PM2_FOCUS.has(app.name))
      .map((app: any) => ({
        name: app.name,
        status: app.pm2_env?.status || 'unknown',
        restarts: Number(app.pm2_env?.restart_time || 0),
        unstable: Number(app.pm2_env?.unstable_restarts || 0),
        uptimeMs: app.pm2_env?.pm_uptime ? Math.max(0, now - Number(app.pm2_env.pm_uptime)) : null,
        memoryMb: app.monit?.memory ? Number((app.monit.memory / 1024 / 1024).toFixed(1)) : null,
        cpu: typeof app.monit?.cpu === 'number' ? app.monit.cpu : null,
        scriptPath: String(app.pm2_env?.pm_exec_path || app.pm2_env?.script || ''),
        scriptArgs: Array.isArray(app.pm2_env?.args)
          ? app.pm2_env.args.join(' ')
          : String(app.pm2_env?.args || ''),
      }));
  } catch {
    return [];
  }
}

function findService(services: any[], name: string) {
  return services.find((service) => service.name === name) || null;
}

function isServiceOnline(services: any[], name: string) {
  return findService(services, name)?.status === 'online';
}

function latestJournalTs(journalRows: any[]) {
  return journalRows.reduce((max, row) => Math.max(max, toFiniteNumber(row?.ts || row?.timestamp, 0)), 0);
}

function latestExecutableWalletCount(walletSignals: any) {
  return (Array.isArray(walletSignals?.buy_signals) ? walletSignals.buy_signals : []).filter(
    (signal: any) => signal?.executable === true && signal?.expired !== true,
  ).length;
}

function configsApproximatelyMatch(
  left: { tpPct: number; slPct: number; holdMinutes: number } | null | undefined,
  right: { tpPct: number; slPct: number; holdMinutes: number } | null | undefined,
) {
  if (!left || !right) return false;
  return (
    Math.abs(Number(left.tpPct || 0) - Number(right.tpPct || 0)) <= 0.05 &&
    Math.abs(Number(left.slPct || 0) - Number(right.slPct || 0)) <= 0.05 &&
    Math.abs(Number(left.holdMinutes || 0) - Number(right.holdMinutes || 0)) <= 0.05
  );
}

function deriveMicroScoutRuntimeConfig(profile: any) {
  const raw = profile?.microScout || {};
  if (raw.enabled !== true) return null;
  return {
    tpPct: Number(raw.maxTPpct ?? 12),
    slPct: Number(raw.stopLossPct ?? 8),
    holdMinutes: Number(raw.maxHoldMinutes ?? 3),
  };
}

export function detectGuardianAnomalies(input: {
  now: number;
  services: any[];
  state: GuardianState;
  journalAgeMs: number | null;
  latestJournalTs: number | null;
  walletSignalsAgeMs: number | null;
  executableBuySignalCount: number;
  profileEventsAgeMs: number | null;
  profileStatsAgeMs: number | null;
  openPositions: number;
  bootConfig: { tpPct: number; slPct: number; holdMinutes: number } | null;
  runtimeBanner: { tpPct: number; slPct: number; holdMinutes: number } | null;
  gemmaConfig: { tpPct?: number; slPct?: number; holdMinutes?: number } | null;
  activeMode?: 'micro-only' | 'normal' | null;
  microRuntimeConfig?: { tpPct: number; slPct: number; holdMinutes: number } | null;
}) {
  const anomalies: any[] = [];
  const { now, services, state } = input;
  const sniper = findService(services, 'pcp-sniper-1');
  if (sniper) {
    const history = normalizeRestartHistory([...(state.restartHistory[sniper.name] || []), {
      ts: now,
      restarts: Number(sniper.restarts || 0),
      uptimeMs: sniper.uptimeMs,
    }], now);
    const restartDelta = history.length >= 2 ? history[history.length - 1].restarts - history[0].restarts : 0;
    const consecutiveShortUptime =
      history.length >= 2 &&
      history.slice(-2).every((row) => Number(row.uptimeMs || 0) > 0 && Number(row.uptimeMs || 0) < 90_000);
    if (restartDelta >= 2 || consecutiveShortUptime) {
      anomalies.push({
        type: 'restart_flap',
        severity: 'high',
        evidence: {
          service: sniper.name,
          restartDelta,
          currentRestarts: sniper.restarts,
          uptimeMs: sniper.uptimeMs,
        },
      });
    }
  }

  const upstreamOnline =
    isServiceOnline(services, 'pcp-wallet-monitor') &&
    (isServiceOnline(services, 'pcp-velocity-stream') || isServiceOnline(services, 'pcp-gmgn-bridge'));

  const walletSignalsStale =
    input.walletSignalsAgeMs !== null && input.walletSignalsAgeMs > WALLET_SIGNALS_STALE_MS;
  const profileStale =
    (input.profileEventsAgeMs !== null && input.profileEventsAgeMs > PROFILE_STALE_MS) ||
    (input.profileStatsAgeMs !== null && input.profileStatsAgeMs > PROFILE_STALE_MS);
  const activeFlowLikely =
    input.openPositions > 0 || input.executableBuySignalCount > 0;

  if (
    input.journalAgeMs !== null &&
    input.journalAgeMs > JOURNAL_STALE_MS &&
    upstreamOnline &&
    activeFlowLikely &&
    (walletSignalsStale || profileStale)
  ) {
    anomalies.push({
      type: 'journal_stale',
      severity: 'high',
      evidence: {
        journalAgeMs: input.journalAgeMs,
        latestJournalTs: input.latestJournalTs,
      },
    });
  }

  if (walletSignalsStale) {
    anomalies.push({
      type: 'feed_stale',
      severity: 'medium',
      evidence: {
        feed: 'wallet_signals',
        ageMs: input.walletSignalsAgeMs,
      },
    });
  }

  const profileLikelyStaleDuringActiveFlow =
    activeFlowLikely &&
    input.journalAgeMs !== null &&
    input.journalAgeMs <= JOURNAL_STALE_MS &&
    profileStale;
  if (profileLikelyStaleDuringActiveFlow) {
    anomalies.push({
      type: 'profile_stale',
      severity: 'high',
      evidence: {
        journalAgeMs: input.journalAgeMs,
        profileEventsAgeMs: input.profileEventsAgeMs,
        profileStatsAgeMs: input.profileStatsAgeMs,
      },
    });
  }

  const underfilled = input.openPositions < TARGET_QUOTA_POSITIONS;
  if (underfilled) {
    const underfillSince = state.underfilledSince || now;
    const sustainedMs = now - underfillSince;
    const quotaRelatedStale =
      walletSignalsStale ||
      profileLikelyStaleDuringActiveFlow;
    if (quotaRelatedStale && sustainedMs >= 10 * 60_000) {
      anomalies.push({
        type: 'quota_degraded',
        severity: input.openPositions < MIN_QUOTA_POSITIONS ? 'high' : 'medium',
        evidence: {
          openPositions: input.openPositions,
          targetPositions: TARGET_QUOTA_POSITIONS,
          shortfall: Math.max(0, TARGET_QUOTA_POSITIONS - input.openPositions),
          walletSignalsAgeMs: input.walletSignalsAgeMs,
          profileEventsAgeMs: input.profileEventsAgeMs,
          profileStatsAgeMs: input.profileStatsAgeMs,
          journalAgeMs: input.journalAgeMs,
        },
      });
    }
  }

  if (input.bootConfig && input.runtimeBanner) {
    const expectedRuntimeConfig =
      input.activeMode === 'micro-only' && input.microRuntimeConfig
        ? input.microRuntimeConfig
        : (input.gemmaConfig as any) || input.bootConfig;
    const drift = !configsApproximatelyMatch(expectedRuntimeConfig, input.runtimeBanner);
    if (drift) {
      anomalies.push({
        type: 'config_drift',
        severity: 'medium',
        evidence: {
          activeMode: input.activeMode || 'normal',
          expectedRuntimeConfig,
          microRuntimeConfig: input.microRuntimeConfig,
          bootConfig: input.bootConfig,
          runtimeBanner: input.runtimeBanner,
          gemmaConfig: input.gemmaConfig,
        },
      });
    }
  }

  const refiner = findService(services, 'pcp-gemma4-refiner');
  const refinerEntrypoint = `${String(refiner?.scriptPath || '')} ${String(refiner?.scriptArgs || '')}`.trim();
  if (refiner && !refinerEntrypoint.includes('gemma4_slopfest_refiner.py')) {
    anomalies.push({
      type: 'refiner_entrypoint_drift',
      severity: 'medium',
      evidence: {
        scriptPath: refiner.scriptPath,
        scriptArgs: refiner.scriptArgs || null,
        expected: 'scripts/maintain/gemma4_slopfest_refiner.py',
      },
    });
  }

  return anomalies;
}

async function restartService(serviceName: string) {
  await execFileAsync('pm2', ['restart', serviceName], { maxBuffer: 2 * 1024 * 1024 });
}

async function remediateAnomalies(input: {
  anomalies: any[];
  state: GuardianState;
  now: number;
}) {
  const restartableByAnomaly: Record<string, string | null> = {
    feed_stale: 'pcp-wallet-monitor',
    journal_stale: 'pcp-velocity-stream',
    quota_degraded: 'pcp-wallet-monitor',
  };

  for (const anomaly of input.anomalies) {
    if (anomaly.type === 'restart_flap' || anomaly.type === 'config_drift' || anomaly.type === 'refiner_entrypoint_drift' || anomaly.type === 'profile_stale') {
      continue;
    }

    const serviceName = restartableByAnomaly[anomaly.type] || null;
    if (!serviceName) continue;
    const cooldownUntil = Number(input.state.remediationCooldowns[serviceName] || 0);
    if (cooldownUntil > input.now) {
      return {
        action: `cooldown:${serviceName}`,
        success: false,
        service: serviceName,
        cooldownUntil,
      };
    }

    try {
      await restartService(serviceName);
      input.state.remediationCooldowns[serviceName] = input.now + REMEDIATION_COOLDOWN_MS;
      return {
        action: `restart:${serviceName}`,
        success: true,
        service: serviceName,
        cooldownUntil: input.state.remediationCooldowns[serviceName],
      };
    } catch (error: any) {
      return {
        action: `restart:${serviceName}`,
        success: false,
        service: serviceName,
        error: String(error?.message || error),
      };
    }
  }

  return null;
}

function appendIncident(state: GuardianState, incident: any, now: number) {
  if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });
  const key = `${incident.type}:${incident.evidence?.service || incident.evidence?.feed || incident.evidence?.scriptPath || 'global'}`;
  const lastTs = Number(state.lastIncidentByKey[key] || 0);
  if ((now - lastTs) < INCIDENT_DEDUP_MS) return false;
  fs.appendFileSync(SWARM_INCIDENTS_FILE, `${JSON.stringify(incident)}\n`, 'utf-8');
  state.lastIncidentByKey[key] = now;
  return true;
}

export async function runGuardianCycle() {
  const now = Date.now();
  const state = loadGuardianState();
  const services = await getPm2Summary(now);
  const journalRows = readJsonl(JOURNAL_FILE, 200);
  const recentTrades = journalRows
    .filter((row) => row?.action === 'BUY' || row?.action === 'SELL')
    .slice(-8)
    .map((row) => ({
      ts: toFiniteNumber(row?.ts || row?.timestamp, 0),
      action: row?.action || 'UNKNOWN',
      symbol: row?.symbol || row?.mint || 'unknown',
      reason: row?.reason || null,
      pnlSol: row?.pnlSol !== undefined ? Number(row.pnlSol) : null,
    }));
  const latestTradeTs = latestJournalTs(journalRows) || null;
  const journalAgeMs = latestTradeTs ? Math.max(0, now - latestTradeTs) : fileAgeMs(JOURNAL_FILE, now);
  const profileEventsAgeMs = fileAgeMs(PROFILE_EVENTS_FILE, now);
  const profileStatsAgeMs = fileAgeMs(PROFILE_STATS_FILE, now);
  const walletSignals = readJson<any>(WALLET_SIGNALS_FILE, {});
  const walletSignalsUpdatedAt = Number(walletSignals?.updated_at || 0) || null;
  const walletSignalsAgeMs = walletSignalsUpdatedAt ? Math.max(0, now - walletSignalsUpdatedAt) : fileAgeMs(WALLET_SIGNALS_FILE, now);
  const executableBuySignalCount = latestExecutableWalletCount(walletSignals);
  const sniperState = readJson<any>(SNIPER_STATE_FILE, {});
  const openPositions = Array.isArray(sniperState?.positions) ? sniperState.positions.length : 0;
  const quotaAssistLevel = resolveQuotaAssistLevel(openPositions);

  if (openPositions < TARGET_QUOTA_POSITIONS) {
    state.underfilledSince = state.underfilledSince || now;
  } else {
    state.underfilledSince = null;
  }

  const bootConfig = parseGemmaBootLine(tailLines(SNIPER_OUT_LOG, 400).reverse().find((line) => line.includes('GEMMA4 BOOT')) || null);
  const runtimeBanner = parseRuntimeBannerLine(tailLines(SNIPER_OUT_LOG, 400).reverse().find((line) => line.includes('Scout slots:')) || null);
  const gemmaRecommendations = readJson<any>(GEMMA_RECOMMENDATIONS_FILE, {});
  const strategyProfile = readJson<any>(STRATEGY_PROFILE_FILE, {});
  const activeMode = strategyProfile?.liveTest?.microOnly === true ? 'micro-only' : 'normal';
  const microRuntimeConfig = deriveMicroScoutRuntimeConfig(strategyProfile);
  const gemmaConfig = gemmaRecommendations?.recommended_filters
    ? {
        tpPct: Number(gemmaRecommendations.recommended_filters.tp1_pct || 0),
        slPct: Number(gemmaRecommendations.recommended_filters.stop_loss_pct || 0),
        holdMinutes: Number(gemmaRecommendations.recommended_filters.max_hold_minutes || 0),
      }
    : null;

  const anomalies = detectGuardianAnomalies({
    now,
    services,
    state,
    journalAgeMs,
    latestJournalTs: latestTradeTs,
    walletSignalsAgeMs,
    executableBuySignalCount,
    profileEventsAgeMs,
    profileStatsAgeMs,
    openPositions,
    bootConfig,
    runtimeBanner,
    gemmaConfig,
    activeMode,
    microRuntimeConfig,
  });

  const remediation = await remediateAnomalies({
    anomalies,
    state,
    now,
  });

  for (const service of services) {
    const history = normalizeRestartHistory([...(state.restartHistory[service.name] || []), {
      ts: now,
      restarts: Number(service.restarts || 0),
      uptimeMs: service.uptimeMs,
    }], now);
    state.restartHistory[service.name] = history;
  }

  const health = {
    timestamp: now,
    services,
    journal: {
      latestTs: latestTradeTs,
      ageMs: journalAgeMs,
      recentTrades,
    },
    walletSignals: {
      updatedAt: walletSignalsUpdatedAt,
      ageMs: walletSignalsAgeMs,
      trackedWalletCount: Number(walletSignals?.tracked_wallet_count || 0),
      buySignalCount: Array.isArray(walletSignals?.buy_signals) ? walletSignals.buy_signals.length : 0,
      executableBuySignalCount,
    },
    quota: {
      openPositions,
      minPositions: MIN_QUOTA_POSITIONS,
      targetPositions: TARGET_QUOTA_POSITIONS,
      shortfall: Math.max(0, TARGET_QUOTA_POSITIONS - openPositions),
      quotaAssistLevel,
      underfilledSince: state.underfilledSince,
    },
    learning: {
      profileEventsAgeMs,
      profileStatsAgeMs,
      latestGemmaGeneratedAt: gemmaRecommendations?.generatedAt || null,
    },
    anomalies,
    lastRemediation: remediation,
  };

  if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });
  fs.writeFileSync(SWARM_HEALTH_FILE, JSON.stringify(health, null, 2), 'utf-8');
  const sniperService = findService(services, 'pcp-sniper-1');
  const guardianHealthy = anomalies.length === 0;
  const sniperHealthy = sniperService?.status === 'online';
  fs.writeFileSync(
    LEGACY_GUARDIAN_STATUS_FILE,
    JSON.stringify({
      updatedAt: new Date(now).toISOString(),
      activeAnomalies: anomalies.length,
      guardianHealthy,
      sniperHealthy,
      quota: health.quota,
      journal: {
        latestTs: latestTradeTs,
        ageMs: journalAgeMs,
        recentTrades,
      },
      walletSignals: health.walletSignals,
      anomalies,
      lastRemediation: remediation,
    }, null, 2),
    'utf-8',
  );

  for (const anomaly of anomalies) {
    appendIncident(state, {
      timestamp: now,
      type: anomaly.type,
      severity: anomaly.severity,
      evidence: anomaly.evidence,
      action: remediation?.action || 'observe',
      success: remediation?.success ?? true,
      cooldownUntil: remediation?.cooldownUntil || null,
    }, now);
  }

  saveGuardianState(state);
  return health;
}

async function main() {
  const once = process.argv.includes('--once');
  do {
    try {
      const health = await runGuardianCycle();
      console.log(
        `[GUARDIAN] ${new Date(health.timestamp).toISOString()} anomalies=${health.anomalies.length} ` +
        `quota=${health.quota.openPositions}/${health.quota.targetPositions}`,
      );
    } catch (error: any) {
      console.error(`[GUARDIAN] cycle failed: ${String(error?.message || error)}`);
    }
    if (once) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  } while (true);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseGemmaBootLine,
  parseRuntimeBannerLine,
  detectGuardianAnomalies,
  runGuardianCycle,
};
