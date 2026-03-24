/**
 * telemetry_report.ts  —  Momus/Librarian agent: weekly trade analysis
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads the SQLite trades table, computes per-route win rates, latency,
 * capital efficiency, and writes a Markdown report + telemetry_summary.json.
 *
 * Usage:
 *   npx ts-node scripts/maintain/telemetry_report.ts
 *   npx ts-node scripts/maintain/telemetry_report.ts --days 7
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs   from 'fs';
import path from 'path';
const Database = require('better-sqlite3');

const DAYS         = parseInt(process.argv.find(a => a.startsWith('--days=') || a === '--days')
                      ? (process.argv[process.argv.indexOf('--days') + 1] || '7') : '7');
const DB_PATH      = path.join(process.cwd(), process.env.LOG_DB_PATH || 'trades.db');
const REPORT_FILE  = path.join(process.cwd(), 'telemetry_report.md');
const SUMMARY_FILE = path.join(process.cwd(), 'telemetry_summary.json');

interface TradeRow {
  timestamp:            number;
  type:                 string;
  route:                string;
  expected_profit:      number;
  expected_profit_bps:  number;
  decision:             string;
  actual_profit:        number | null;
  jito_tip:             number;
  priority_fee:         number;
  latency_ms:           number;
  error:                string | null;
}

interface RouteStats {
  route:        string;
  scans:        number;
  executed:     number;
  winRate:      number;
  avgProfitBps: number;
  avgLatencyMs: number;
  totalProfitSol: number;
  avgTipSol:    number;
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.warn(`[TELEMETRY] DB not found at ${DB_PATH} — no trades recorded yet`);
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify({ error: 'no_db', timestamp: new Date().toISOString() }));
    process.exit(0);
  }

  const db = new Database(DB_PATH, { readonly: true });
  const cutoff = Date.now() - DAYS * 24 * 3600_000;

  const rows: TradeRow[] = db.prepare(
    `SELECT * FROM trades WHERE timestamp > ? ORDER BY timestamp DESC`
  ).all(cutoff);

  db.close();

  if (rows.length === 0) {
    console.warn(`[TELEMETRY] No trades in the last ${DAYS} days`);
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify({ trades: 0, days: DAYS, timestamp: new Date().toISOString() }));
    process.exit(0);
  }

  // ── Per-route aggregation ─────────────────────────────────────────────────────
  const byRoute = new Map<string, TradeRow[]>();
  for (const row of rows) {
    const r = row.route || row.type || 'unknown';
    if (!byRoute.has(r)) byRoute.set(r, []);
    byRoute.get(r)!.push(row);
  }

  const routeStats: RouteStats[] = [];
  for (const [route, trades] of byRoute) {
    const executed  = trades.filter(t => t.decision === 'executed');
    const wins      = executed.filter(t => (t.actual_profit || 0) > 0);
    const totalP    = executed.reduce((s, t) => s + (t.actual_profit || 0), 0) / 1e9;
    const avgBps    = trades.reduce((s, t) => s + (t.expected_profit_bps || 0), 0) / trades.length;
    const avgLat    = trades.reduce((s, t) => s + (t.latency_ms || 0), 0) / trades.length;
    const avgTip    = trades.reduce((s, t) => s + (t.jito_tip || 0), 0) / trades.length / 1e9;
    routeStats.push({
      route, scans: trades.length, executed: executed.length,
      winRate: executed.length > 0 ? wins.length / executed.length : 0,
      avgProfitBps: parseFloat(avgBps.toFixed(2)),
      avgLatencyMs: parseFloat(avgLat.toFixed(1)),
      totalProfitSol: parseFloat(totalP.toFixed(6)),
      avgTipSol: parseFloat(avgTip.toFixed(6)),
    });
  }
  routeStats.sort((a, b) => b.totalProfitSol - a.totalProfitSol);

  // ── Global summary ────────────────────────────────────────────────────────────
  const totalTrades   = rows.length;
  const executed      = rows.filter(r => r.decision === 'executed');
  const failed        = rows.filter(r => r.decision === 'failed');
  const totalProfitSol= executed.reduce((s, r) => s + (r.actual_profit || 0), 0) / 1e9;
  const avgProfit     = executed.length > 0 ? totalProfitSol / executed.length : 0;
  const avgLatency    = rows.reduce((s, r) => s + (r.latency_ms || 0), 0) / rows.length;
  const errorRate     = failed.length / rows.length;

  const summary = {
    timestamp: new Date().toISOString(), days: DAYS, totalTrades,
    executed: executed.length, failed: failed.length,
    errorRate: parseFloat(errorRate.toFixed(4)),
    totalProfitSol: parseFloat(totalProfitSol.toFixed(6)),
    avgProfitSolPerTrade: parseFloat(avgProfit.toFixed(8)),
    avgLatencyMs: parseFloat(avgLatency.toFixed(1)),
    topRoute: routeStats[0]?.route || 'n/a',
    routeStats,
  };
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));

  // ── Markdown report ───────────────────────────────────────────────────────────
  const now = new Date().toISOString();
  const rows_md = routeStats.slice(0, 15).map(r =>
    `| ${r.route.slice(0,20).padEnd(20)} | ${r.scans} | ${r.executed} | ${(r.winRate*100).toFixed(0)}% | ${r.avgProfitBps} | ${r.avgLatencyMs}ms | ${r.totalProfitSol > 0 ? '+' : ''}${r.totalProfitSol} SOL |`
  ).join('\n');

  const degraded = routeStats.filter(r => r.scans >= 3 && r.avgProfitBps <= 0 && r.executed === 0);

  const md = `# PCP Engine Telemetry Report
Generated: ${now} | Period: Last ${DAYS} days

## Summary
| Metric | Value |
|--------|-------|
| Total trades recorded | ${totalTrades} |
| Executed | ${executed.length} |
| Failed | ${failed.length} (${(errorRate*100).toFixed(1)}% error rate) |
| Total realised P&L | ${totalProfitSol > 0 ? '+' : ''}${totalProfitSol.toFixed(6)} SOL |
| Avg profit/trade | ${avgProfit.toFixed(8)} SOL |
| Avg execution latency | ${avgLatency.toFixed(1)}ms |

## Top Routes (by realised P&L)
| Route | Scans | Exec | Win% | Avg BPS | Avg Latency | P&L |
|-------|-------|------|------|---------|-------------|-----|
${rows_md}

## 🔴 Dead Routes (recommend pruning)
${degraded.length > 0
  ? degraded.map(r => `- **${r.route}**: ${r.scans} scans, 0 executed, avg ${r.avgProfitBps} BPS`).join('\n')
  : '_None — all routes showing positive signal_'}

## Recommendations
${routeStats[0] ? `- **Increase allocation**: \`${routeStats[0].route}\` is top performer (${routeStats[0].totalProfitSol} SOL)` : ''}
${degraded.length > 0 ? `- **Prune ${degraded.length} dead route(s)**: no executions after ${DAYS}d` : ''}
${errorRate > 0.10 ? '- **⚠️ Error rate elevated**: check RPC health and API keys' : ''}
`;

  fs.writeFileSync(REPORT_FILE, md);
  console.log(`[TELEMETRY] Report written → ${REPORT_FILE}`);
  console.log(`[TELEMETRY] ${totalTrades} trades | ${executed.length} executed | ${totalProfitSol.toFixed(6)} SOL P&L`);
}

main();
