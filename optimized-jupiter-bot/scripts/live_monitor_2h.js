/**
 * 2-HOUR LIVE TEST MONITOR
 * Tails arb-jup-out.log for 2 hours and shows a summary at the end, saving to a file.
 */
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const LOG   = path.join(os.homedir(), '.pm2', 'logs', 'arb-jup-out.log');
const SNIP  = path.join(os.homedir(), '.pm2', 'logs', 'sniper-out.log');
const SECS  = 120 * 60; // 2 HOURS
const start = Date.now();
const end   = start + SECS * 1000;
const REPORT_FILE = path.join(__dirname, '..', '2h_live_test_report.txt');

let lastSize = 0;
let scans = 0, trades = 0, profits = 0, losses = 0;

try { lastSize = fs.statSync(LOG).size; } catch(_) {}

function logBoth(msg) {
  console.log(msg);
  fs.appendFileSync(REPORT_FILE, msg + '\n');
}

fs.writeFileSync(REPORT_FILE, ''); // Clear
const bar = '='.repeat(50);
logBoth(`\n${bar}`);
logBoth('  ARB-JUP 2-HOUR LIVE TEST REPORT');
logBoth(`  ${new Date().toISOString().slice(11,19)} → ${new Date(end).toISOString().slice(11,19)}`);
logBoth(bar + '\n');

const iv = setInterval(() => {
  const remaining = Math.ceil((end - Date.now()) / 1000);

  // Read new bytes since last check
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
        if (l.includes('Scan #')) scans++;
        if (l.includes('PROFIT')) { trades++; profits++; }
        if (l.includes('LOSS'))   { trades++; losses++; }
        // Print meaningful lines (only to console to avoid giant file, unless it's a trade)
        if (l.match(/gross|PROFIT|LOSS|Scan|Holding|opp|ERROR|LEG|fee|FATAL/i)) {
          console.log(`[${Math.floor(remaining/60)}m ${remaining%60}s] ${l.replace(/\r/g,'').slice(0,120)}`);
          if (l.includes('PROFIT') || l.includes('LOSS')) {
            fs.appendFileSync(REPORT_FILE, `[${new Date().toISOString().slice(11,19)}] TRADE: ${l}\n`);
          }
        }
      }
    }
  } catch(_) {}

  if (Date.now() >= end) {
    clearInterval(iv);
    logBoth(`\n${bar}`);
    logBoth('  === 2-HOUR TEST COMPLETE ===');
    logBoth(bar);
    logBoth(`  Scans:   ${scans}`);
    logBoth(`  Trades:  ${trades}  (${profits} profit / ${losses} loss)`);
    logBoth(`\n  --- Final State Summaries ---`);
    logBoth(`  End Time: ${new Date().toISOString()}`);
    process.exit(0);
  }
}, 2000);
