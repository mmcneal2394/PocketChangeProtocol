/**
 * 5-MINUTE LIVE TEST MONITOR
 * Tails arb-jup-out.log for 5 minutes and shows a summary.
 */
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const LOG   = path.join(os.homedir(), '.pm2', 'logs', 'arb-jup-out.log');
const SNIP  = path.join(os.homedir(), '.pm2', 'logs', 'sniper-out.log');
const SECS  = 5 * 60;
const start = Date.now();
const end   = start + SECS * 1000;

let lastSize = 0;
let scans = 0, trades = 0, profits = 0, losses = 0;

try { lastSize = fs.statSync(LOG).size; } catch(_) {}

const bar = '='.repeat(50);
console.log(`\n${bar}`);
console.log('  ARB-JUP 5-MINUTE LIVE TEST');
console.log(`  ${new Date().toISOString().slice(11,19)} → ${new Date(end).toISOString().slice(11,19)}`);
console.log(bar + '\n');

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
        // Print meaningful lines
        if (l.match(/gross|PROFIT|LOSS|Scan|Holding|opp|ERROR|LEG|fee|FATAL/i)) {
          const ts = new Date().toISOString().slice(11,19);
          console.log(`[${remaining}s] ${l.replace(/\r/g,'').slice(0,120)}`);
        }
      }
    }
  } catch(_) {}

  if (Date.now() >= end) {
    clearInterval(iv);
    console.log(`\n${bar}`);
    console.log('  === 5-MINUTE TEST COMPLETE ===');
    console.log(bar);
    console.log(`  Scans:   ${scans}`);
    console.log(`  Trades:  ${trades}  (${profits} profit / ${losses} loss)`);
    console.log(`\n  --- Last 30 lines of arb-jup log ---`);
    try {
      const all = fs.readFileSync(LOG, 'utf8').split('\n');
      all.slice(-30).forEach(l => console.log(l));
    } catch(_) {}
    console.log(`\n  --- Last 5 lines of sniper log ---`);
    try {
      const sn = fs.readFileSync(SNIP, 'utf8').split('\n');
      sn.slice(-5).forEach(l => console.log(l));
    } catch(_) {}
    process.exit(0);
  }
}, 2000);
