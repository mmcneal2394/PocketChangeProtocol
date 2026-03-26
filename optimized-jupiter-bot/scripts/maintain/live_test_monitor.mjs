#!/usr/bin/env node
/**
 * live_test_monitor.mjs
 * Logs an hourly snapshot of agent health, P&L, and positions
 * to signals/live_test_YYYYMMDD.log for the 10-hour test window.
 */

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const SIGNALS   = join(process.cwd(), 'signals');
const TEST_HOURS = 10;
const LOG_FILE  = join(SIGNALS, `live_test_${new Date().toISOString().slice(0,10)}.log`);

if (!existsSync(SIGNALS)) mkdirSync(SIGNALS, { recursive: true });

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

function snapshot(hour) {
  const now = new Date().toISOString();

  // Read stats from position files
  const sniper = readJson(join(SIGNALS, 'sniper_positions.json'));
  const pf     = readJson(join(SIGNALS, 'pumpfun_positions.json'));

  // Count journal entries
  let journalBuys = 0, journalSells = 0, journalPnl = 0;
  try {
    const lines = readFileSync(join(SIGNALS, 'trade_journal.jsonl'), 'utf-8').trim().split('\n').filter(Boolean);
    for (const l of lines) {
      try {
        const t = JSON.parse(l);
        if (t.action === 'BUY') journalBuys++;
        if (t.action === 'SELL') { journalSells++; journalPnl += t.pnlSol || 0; }
      } catch {}
    }
  } catch {}

  // Get pm2 status
  let pm2Status = '';
  try {
    pm2Status = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf-8' });
    const procs = JSON.parse(pm2Status);
    pm2Status = procs.map(p => `${p.name}:${p.pm2_env.status}(↺${p.pm2_env.restart_time})`).join(' | ');
  } catch { pm2Status = 'unavailable'; }

  const line = [
    `\n${'='.repeat(60)}`,
    `HOUR ${hour}/${TEST_HOURS}  [${now}]`,
    `${'='.repeat(60)}`,
    `AGENTS: ${pm2Status}`,
    ``,
    `SNIPER:   W:${sniper?.stats?.wins||0} L:${sniper?.stats?.losses||0} PnL:${(sniper?.stats?.totalPnlSol||0).toFixed(5)} SOL | Positions:${sniper?.positions?.length||0} | Blacklist:${sniper?.blacklist?.length||0}`,
    `PUMPFUN:  W:${pf?.stats?.wins||0} L:${pf?.stats?.losses||0} PnL:${(pf?.stats?.pnlSol||0).toFixed(5)} SOL | Positions:${pf?.positions?.length||0} | Blacklist:${pf?.blacklist?.length||0}`,
    ``,
    `JOURNAL:  Buys:${journalBuys} Sells:${journalSells} Net PnL:${journalPnl>=0?'+':''}${journalPnl.toFixed(5)} SOL`,
    `COMBINED: Total PnL: ${((sniper?.stats?.totalPnlSol||0)+(pf?.stats?.pnlSol||0)).toFixed(5)} SOL`,
  ].join('\n');

  appendFileSync(LOG_FILE, line + '\n');
  console.log(line);
}

// Header
const header = [
  '='.repeat(60),
  `PCP 10-HOUR LIVE TEST — Started: ${new Date().toISOString()}`,
  `Wallet: DPx63B2v3fe6hQMUcXWCTfPy9HW6iZaZdH5FvjcztQ13`,
  `Agents: pcp-sniper | pcp-pumpfun | pcp-strategist | pcp-trending | pcp-health | pcp-engine`,
  '='.repeat(60),
].join('\n');

appendFileSync(LOG_FILE, header + '\n');
console.log(header);

// Immediate snapshot at start
snapshot(0);

// Hourly snapshots
let hour = 1;
const interval = setInterval(() => {
  snapshot(hour);
  hour++;
  if (hour > TEST_HOURS) {
    console.log('\n✅ 10-hour live test complete. Log:', LOG_FILE);
    clearInterval(interval);
    process.exit(0);
  }
}, 60 * 60 * 1000); // every 1 hour

process.on('SIGTERM', () => {
  appendFileSync(LOG_FILE, `\n[TERMINATED at ${new Date().toISOString()}]\n`);
  process.exit(0);
});

console.log(`\n📊 Monitor running — hourly snapshots to ${LOG_FILE}`);
console.log('Next snapshot in 1 hour. Press Ctrl+C to stop (test continues in agents).\n');
