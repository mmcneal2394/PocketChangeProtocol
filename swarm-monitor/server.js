/**
 * PCP Swarm Monitor — Local Dashboard Server
 * Run:  node server.js
 * Open: http://localhost:3377
 */
const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3377;
const SSH_KEY = 'C:\\Users\\admin\\.ssh\\do_droplet_key';
const HOST = 'root@64.23.173.160';
const SSH = `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -i ${SSH_KEY} ${HOST}`;
const BOT_DIR = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot';

function ssh(cmd) {
  try {
    return execSync(`${SSH} "${cmd}"`, { timeout: 20000, encoding: 'utf-8' });
  } catch (e) {
    return `ERROR: ${e.stdout || e.message?.slice(0, 200)}`;
  }
}

function getData() {
  const cmds = [
    'echo ===PM2===',
    'pm2 jlist 2>/dev/null',
    'echo ===JOURNAL===',
    `tail -10 ${BOT_DIR}/trade_journal.jsonl 2>/dev/null`,
    'echo ===SIGNALS_JOURNAL===',
    `tail -10 ${BOT_DIR}/signals/trade_journal.jsonl 2>/dev/null`,
    'echo ===POSITIONS===',
    `cat ${BOT_DIR}/signals/sniper_positions.json 2>/dev/null`,
    'echo ===STRATEGY===',
    `cat ${BOT_DIR}/strategy_params.json 2>/dev/null`,
    'echo ===WALLET===',
    'solana balance DPx63B2v3fe6hQMUcXWCTfPy9HW6iZaZdH5FvjcztQ13 2>/dev/null || echo N/A',
    'echo ===QUALIFIER===',
    'pm2 logs pcp-target-qualifier --lines 8 --nostream 2>&1 | grep -E Evaluating.Missed.QUALIFIED | tail -6',
    'echo ===MOMENTUM===',
    'pm2 logs pcp-momentum-sniper --lines 15 --nostream 2>&1 | tail -12',
    'echo ===VELOCITY===',
    'pm2 logs pcp-velocity-stream --lines 6 --nostream 2>&1 | grep SPIKE | tail -4',
    'echo ===END==='
  ].join('; ');
  return ssh(cmds);
}

function parseData(raw) {
  const sections = {};
  const parts = raw.split(/===(\w+)===/);
  for (let i = 1; i < parts.length - 1; i += 2) {
    sections[parts[i]] = parts[i + 1].trim();
  }
  let pm2 = [];
  try { pm2 = JSON.parse(sections.PM2 || '[]'); } catch {}
  
  let positions = { positions: [], stats: { wins: 0, losses: 0, totalPnlSol: 0 }, blacklist: [] };
  try { positions = JSON.parse(sections.POSITIONS || '{}'); } catch {}

  let strategy = {};
  try { strategy = JSON.parse(sections.STRATEGY || '{}'); } catch {}

  const trades = [];
  const journalLines = (sections.JOURNAL || '').split('\n').concat((sections.SIGNALS_JOURNAL || '').split('\n'));
  for (const line of journalLines) {
    if (!line.trim()) continue;
    try { trades.push(JSON.parse(line)); } catch {}
  }
  trades.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  return {
    pm2,
    positions,
    strategy,
    trades: trades.slice(0, 15),
    wallet: (sections.WALLET || 'N/A').trim(),
    qualifier: sections.QUALIFIER || '',
    momentum: sections.MOMENTUM || '',
    velocity: sections.VELOCITY || '',
  };
}

const server = http.createServer((req, res) => {
  if (req.url === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const raw = getData();
      const data = parseData(raw);
      res.end(JSON.stringify(data));
    } catch (e) {
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Serve dashboard HTML
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf-8'));
});

server.listen(PORT, () => {
  console.log(`\n  🚀 PCP Swarm Monitor`);
  console.log(`  ────────────────────`);
  console.log(`  Dashboard: http://localhost:${PORT}`);
  console.log(`  API:       http://localhost:${PORT}/api/data`);
  console.log(`  Press Ctrl+C to stop\n`);
});
