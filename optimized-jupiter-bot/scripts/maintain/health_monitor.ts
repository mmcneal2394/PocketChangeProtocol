/**
 * health_monitor.ts  —  Oracle agent: continuous engine health polling
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads dry_run_results.json + live RL counters, writes health_status.json.
 * Run by the swarm Oracle agent on a cron/interval.
 *
 * Usage:
 *   npx ts-node scripts/maintain/health_monitor.ts
 *   npx ts-node scripts/maintain/health_monitor.ts --once   (single check, exit)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs   from 'fs';
import path from 'path';

const RESULTS_FILE    = path.join(process.cwd(), 'dry_run_results.json');
const HEALTH_FILE     = path.join(process.cwd(), 'health_status.json');
const BASELINE_FILE   = path.join(process.cwd(), 'health_baseline.json');
const POLL_INTERVAL   = parseInt(process.env.HEALTH_POLL_MS || '60000'); // 1 min default
const ONCE            = process.argv.includes('--once');

// ── Thresholds ─────────────────────────────────────────────────────────────────
const THRESHOLDS = {
  minRoutesPerMin:      5,     // below = stalled scanner
  maxParseErrorRate:    0.05,  // >5% = upstream API schema changed
  maxRlWarnRate:        0.10,  // >10% = rate-limit budget exceeded
  maxStalePriceMinutes: 5,     // price not updated in 5 min = feed dead
  minCapitalRetention:  0.98,  // capital should never drop below 98%
};

interface ResultsSnapshot {
  routesScanned:     number;
  tokensApproved:    number;
  tokensBlocked:     number;
  oppsFound:         number;
  simExecuted:       number;
  simPnlSol:         number;
  bestOppSol:        number | null;
  parseErrors:       number;
  rateLimitWarnings: number;
  capitalStart:      number;
  capitalRemaining:  number;
  durationMin:       number;
  completedAt:       string;
  apiHealth:         Record<string, { calls: number; x429: number }>;
}

interface HealthStatus {
  timestamp:      string;
  status:         'healthy' | 'degraded' | 'critical';
  alerts:         string[];
  metrics:        Record<string, number | string>;
  apiHealth:      Record<string, { calls: number; x429: number; ok: boolean }>;
  trend:          'improving' | 'stable' | 'degrading' | 'unknown';
}

function loadResults(): ResultsSnapshot | null {
  try {
    if (!fs.existsSync(RESULTS_FILE)) return null;
    return JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));
  } catch { return null; }
}

function loadBaseline(): Partial<ResultsSnapshot> {
  try {
    if (!fs.existsSync(BASELINE_FILE)) return {};
    return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8'));
  } catch { return {}; }
}

function saveBaseline(snap: ResultsSnapshot) {
  try { fs.writeFileSync(BASELINE_FILE, JSON.stringify(snap, null, 2)); } catch {}
}

function evaluate(snap: ResultsSnapshot, baseline: Partial<ResultsSnapshot>): HealthStatus {
  const alerts: string[] = [];
  const metrics: Record<string, number | string> = {};
  const apiHealth: Record<string, { calls: number; x429: number; ok: boolean }> = {};

  // Routes per minute
  const routesPerMin = snap.durationMin > 0 ? snap.routesScanned / snap.durationMin : 0;
  metrics['routes_per_min']    = parseFloat(routesPerMin.toFixed(2));
  metrics['parse_error_rate']  = snap.routesScanned > 0
    ? parseFloat((snap.parseErrors / snap.routesScanned).toFixed(4)) : 0;
  metrics['rl_warn_rate']      = snap.routesScanned > 0
    ? parseFloat((snap.rateLimitWarnings / snap.routesScanned).toFixed(4)) : 0;
  metrics['capital_retention'] = snap.capitalStart > 0
    ? parseFloat((snap.capitalRemaining / snap.capitalStart).toFixed(4)) : 1;
  metrics['opps_found']        = snap.oppsFound;
  metrics['tokens_blocked']    = snap.tokensBlocked;

  // API health analysis
  for (const [api, { calls, x429 }] of Object.entries(snap.apiHealth || {})) {
    const rate429 = calls > 0 ? x429 / calls : 0;
    const ok      = rate429 < 0.30; // >30% 429s = degraded
    apiHealth[api] = { calls, x429, ok };
    if (!ok) alerts.push(`API degraded: ${api} (${x429}/${calls} x429, ${(rate429*100).toFixed(0)}%)`);
  }

  // Threshold checks
  if (routesPerMin < THRESHOLDS.minRoutesPerMin)
    alerts.push(`Scanner stalled: ${routesPerMin.toFixed(1)} routes/min < threshold ${THRESHOLDS.minRoutesPerMin}`);
  if ((metrics['parse_error_rate'] as number) > THRESHOLDS.maxParseErrorRate)
    alerts.push(`High parse errors: ${((metrics['parse_error_rate'] as number)*100).toFixed(1)}%`);
  if ((metrics['rl_warn_rate'] as number) > THRESHOLDS.maxRlWarnRate)
    alerts.push(`Rate-limit budget exceeded: ${((metrics['rl_warn_rate'] as number)*100).toFixed(1)}%`);
  if ((metrics['capital_retention'] as number) < THRESHOLDS.minCapitalRetention)
    alerts.push(`Capital loss detected: retention=${((metrics['capital_retention'] as number)*100).toFixed(2)}%`);

  // Trend vs baseline
  let trend: HealthStatus['trend'] = 'unknown';
  if (baseline.routesScanned !== undefined) {
    const baseRpm = baseline.durationMin! > 0 ? baseline.routesScanned / baseline.durationMin! : 0;
    const delta   = routesPerMin - baseRpm;
    trend = delta > 2 ? 'improving' : delta < -2 ? 'degrading' : 'stable';
  }

  const status: HealthStatus['status'] =
    alerts.some(a => a.startsWith('Scanner stalled') || a.startsWith('Capital loss')) ? 'critical' :
    alerts.length > 0 ? 'degraded' : 'healthy';

  return { timestamp: new Date().toISOString(), status, alerts, metrics, apiHealth, trend };
}

function runCheck() {
  const snap = loadResults();
  if (!snap) {
    const status: HealthStatus = {
      timestamp: new Date().toISOString(), status: 'degraded',
      alerts: ['dry_run_results.json not found — engine may not have run yet'],
      metrics: {}, apiHealth: {}, trend: 'unknown',
    };
    fs.writeFileSync(HEALTH_FILE, JSON.stringify(status, null, 2));
    console.log(`[HEALTH] ${status.status.toUpperCase()} — ${status.alerts[0]}`);
    return;
  }

  const baseline = loadBaseline();
  const health   = evaluate(snap, baseline);

  fs.writeFileSync(HEALTH_FILE, JSON.stringify(health, null, 2));

  // Log summary
  const alertStr = health.alerts.length
    ? `\n  ⚠️  Alerts:\n${health.alerts.map(a => `    - ${a}`).join('\n')}`
    : '\n  ✅ No alerts';
  console.log(
    `[HEALTH @ ${health.timestamp}] Status: ${health.status.toUpperCase()} | ` +
    `Trend: ${health.trend} | Routes/min: ${health.metrics['routes_per_min']}` +
    alertStr
  );

  // Promote current snapshot to baseline on healthy check
  if (health.status === 'healthy') saveBaseline(snap);
}

// ── Entry ──────────────────────────────────────────────────────────────────────
runCheck();
if (!ONCE) {
  setInterval(runCheck, POLL_INTERVAL);
  console.log(`[HEALTH] Polling every ${POLL_INTERVAL / 1000}s. Ctrl+C to stop.`);
}
