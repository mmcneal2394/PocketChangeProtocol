/**
 * 24-HOUR LIVE ENGINE TRACKER
 * Monitors arb-jup in real time, counts trades, saves hourly snapshots.
 * Ends and prints final report after 24 hours.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const LOG         = path.join(os.homedir(), '.pm2', 'logs', 'arb-jup-out.log');
const REPORT      = path.join(__dirname, '..', '24h_live_report.json');
const DURATION_MS = 24 * 60 * 60_000;
const start       = Date.now();
const end         = start + DURATION_MS;

let lastSize = 0;
try { lastSize = fs.statSync(LOG).size; } catch(_) {}

const report = {
  startTime: new Date().toISOString(),
  endTime: null,
  scans: 0, trades: 0, profits: 0, losses: 0,
  totalNetLam: 0,
  hourlySnapshots: [],
  tradeLog: [],
};

function save() { fs.writeFileSync(REPORT, JSON.stringify(report, null, 2)); }
function ts()   { return new Date().toISOString().slice(11,19); }
function log(m) { console.log(`[${ts()}] ${m}`); }

const bar = '═'.repeat(54);
log(bar);
log('  ARB-JUP 24-HOUR LIVE DEPLOYMENT TRACKER');
log(`  End: ${new Date(end).toISOString().slice(0,19).replace('T',' ')} UTC`);
log(bar);
save();

// Snapshot every hour
setInterval(() => {
  const hr = Math.floor((Date.now() - start) / 3_600_000);
  const snap = { hour: hr, scans: report.scans, trades: report.trades,
    profits: report.profits, losses: report.losses, netLam: report.totalNetLam };
  report.hourlySnapshots.push(snap);
  log(`📊 Hour ${hr}: ${report.scans} scans | ${report.trades} trades (${report.profits}✅/${report.losses}❌) | net:${(report.totalNetLam/1e9).toFixed(5)} SOL`);
  save();
}, 3_600_000);

// Poll log every 2s
const iv = setInterval(() => {
  try {
    const stat = fs.statSync(LOG);
    if (stat.size > lastSize) {
      const buf = Buffer.alloc(stat.size - lastSize);
      const fd  = fs.openSync(LOG, 'r');
      fs.readSync(fd, buf, 0, buf.length, lastSize);
      fs.closeSync(fd);
      lastSize = stat.size;
      const lines = buf.toString('utf8').split('\n').filter(l => l.trim());
      for (const l of lines) {
        if (l.includes('Scan #')) report.scans++;
        if (l.includes('net:')) {
          // Parse trailing net value: net:+0.00234
          const m = l.match(/net:([+-]?\d+\.\d+)/);
          if (m) report.totalNetLam = Math.round(parseFloat(m[1]) * 1e9);
        }
        if (l.includes('✅') && l.includes('confirmed')) {
          // Count confirmed trade legs
        }
        if (l.match(/PROFIT|executing|⚡/)) {
          report.trades++;
          report.profits++;
          const entry = { time: new Date().toISOString().slice(11,19), line: l.trim().slice(0,120) };
          report.tradeLog.push(entry);
          log(`💰 TRADE: ${l.trim().slice(0,100)}`);
          save();
        }
        if (l.includes('LEG1 err') || l.includes('LEG2 err')) {
          report.losses++;
          const entry = { time: new Date().toISOString().slice(11,19), line: l.trim().slice(0,120) };
          report.tradeLog.push(entry);
          log(`❌ ERR: ${l.trim().slice(0,100)}`);
          save();
        }
      }
    }
  } catch(_) {}

  if (Date.now() >= end) {
    clearInterval(iv);
    report.endTime = new Date().toISOString();
    report.summary = `${report.scans} scans | ${report.trades} trades | ${report.profits} profit | ${report.losses} errors | net: ${(report.totalNetLam/1e9).toFixed(5)} SOL`;
    log(bar);
    log('  24-HOUR TEST COMPLETE');
    log(`  ${report.summary}`);
    log(`  Report: ${REPORT}`);
    log(bar);
    save();
    process.exit(0);
  }
}, 2_000);
