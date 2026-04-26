/**
 * metrics_server.js — PCP Swarm Metrics API
 * Runs on droplet port 3333 as pcp-metrics PM2 process
 * Serves live signal data to pcprotocol.dev dashboard
 */
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');
const Redis   = require('ioredis');

const app  = express();
const PORT = 3333;
const BASE = path.join(__dirname, 'signals');
const SWARM= path.join(BASE, 'swarm');
const UPSTASH_REDIS_URL = (process.env.PCP_SWARM_UPSTASH_REDIS_URL || process.env.UPSTASH_REDIS_URL || '').trim();
const UPSTASH_SWARM_KEY = (process.env.PCP_SWARM_UPSTASH_KEY || 'pcp:swarm:latest').trim();
const UPSTASH_SWARM_TTL_SEC = Math.max(30, Number(process.env.PCP_SWARM_UPSTASH_TTL_SEC || 120));
const UPSTASH_SYNC_INTERVAL_MS = Math.max(10000, Number(process.env.PCP_SWARM_UPSTASH_SYNC_MS || 15000));
const upstash = UPSTASH_REDIS_URL
  ? new Redis(UPSTASH_REDIS_URL, { tls: {}, lazyConnect: true, maxRetriesPerRequest: 1, enableReadyCheck: true })
  : null;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  next();
});

function readJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return fallback; }
}

function readJournal() {
  const jPath = path.join(BASE, 'trade_journal.jsonl');
  if (!fs.existsSync(jPath)) return [];
  return fs.readFileSync(jPath, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function getPm2Status() {
  try {
    const raw = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
    return JSON.parse(raw);
  } catch { return []; }
}

function buildMetricsSnapshot() {
  const journal   = readJournal();
  const positions = readJson(path.join(BASE, 'sniper_positions.json'));
  const trending  = readJson(path.join(BASE, 'trending.json'));
  const alloc     = readJson(path.join(BASE, 'allocation.json'));
  const findings  = readJson(path.join(SWARM, 'findings.json'));
  const proposals = readJson(path.join(SWARM, 'proposals.json'));
  const cycles    = (() => {
    try {
      const lines = fs.readFileSync(path.join(SWARM, 'cycle_log.jsonl'), 'utf8')
        .split('\n').filter(Boolean);
      return lines.slice(-1).map(l => JSON.parse(l))[0] || null;
    } catch { return null; }
  })();

  // Portfolio stats
  const sells = journal.filter(t => t.action === 'SELL' && t.agent === 'pcp-sniper');
  const wins  = sells.filter(t => (t.pnlSol || 0) > 0);
  const netPnl= sells.reduce((s, t) => s + (t.pnlSol || 0), 0);
  const pf    = (() => {
    const gross = wins.reduce((s, t) => s + (t.pnlSol || 0), 0);
    const loss  = Math.abs(sells.filter(t => (t.pnlSol || 0) < 0).reduce((s, t) => s + (t.pnlSol || 0), 0));
    return loss > 0 ? Number((gross / loss).toFixed(3)) : 'N/A';
  })();
  const exits = sells.reduce((acc, t) => {
    const cause = (t.reason || 'UNK').split(' ')[0].split(':')[0];
    acc[cause] = (acc[cause] || 0) + 1;
    return acc;
  }, {});

  // PM2 agent status
  const pm2 = getPm2Status();
  const agentNames = [
    'jupiter-ultra-bot', 'pcp-engine', 'pcp-sniper',
    'pcp-pumpfun', 'pcp-trending', 'pcp-health',
    'pcp-strategist', 'pcp-optimizer', 'pcp-social'
  ];
  const agents = agentNames.map(name => {
    const proc = pm2.find(p => p.name === name);
    return {
      name,
      status: proc ? proc.pm2_env.status : 'unknown',
      uptime: proc ? proc.pm2_env.pm_uptime : null,
      restarts: proc ? proc.pm2_env.restart_time : 0,
      mem_mb: proc ? Math.round(proc.monit?.memory / 1024 / 1024 || 0) : 0,
    };
  });

  return {
    ok: true,
    degraded: false,
    stale: false,
    status: 'swarm_private_live',
    message: 'Live private swarm snapshot from VPS.',
    ts: Date.now(),
    agents,
    portfolio: {
      trades: sells.length,
      wins: wins.length,
      losses: sells.length - wins.length,
      wr_pct: sells.length > 0 ? Number(((wins.length / sells.length) * 100).toFixed(1)) : 0,
      net_pnl: Number(netPnl.toFixed(6)),
      profit_factor: pf,
      exits,
    },
    open_positions: (positions.positions || []).map(p => ({
      mint: p.mint,
      ata: p.ata || null,
      symbol: p.symbol,
      buy_sol: p.buyPriceSol,
      token_amount: p.tokenAmount,
      opened_at: p.openedAt,
      tp_pct: p.tpPct,
      sl_pct: p.slPct,
      peak_pnl_pct: p.peakPnlPct,
    })),
    blacklist_count: (positions.blacklist || []).length,
    last_trades: sells.slice(-15).reverse().map(t => ({
      symbol: t.symbol,
      mint: t.mint,
      pnl: t.pnlSol,
      reason: t.reason,
      ts: t.ts,
    })),
    trending: (trending.mints || []).slice(0, 8).map(m => ({
      symbol: m.symbol,
      mint: m.mint,
      vol1h: m.volume1h,
      chg1h: m.priceChange1h,
      chg5m: m.priceChange5m,
      ratio: m.buyRatio,
      buys: m.buys1h,
      sells: m.sells1h,
      mcap: m.mcapUsd,
      source: m.source,
    })),
    trending_updated: trending.updatedAt || null,
    allocation: alloc,
    findings: findings.findings || [],
    proposals: proposals.proposals || [],
    last_optimizer_cycle: cycles,
  };
}

async function mirrorSnapshotToUpstash() {
  if (!upstash) return false;
  try {
    if (upstash.status !== 'ready') {
      try {
        await upstash.connect();
      } catch (error) {
        const message = String(error?.message || error || '');
        if (!message.toLowerCase().includes('already')) throw error;
      }
    }
    const snapshot = buildMetricsSnapshot();
    await upstash.set(UPSTASH_SWARM_KEY, JSON.stringify(snapshot), 'EX', UPSTASH_SWARM_TTL_SEC);
    return true;
  } catch (error) {
    console.error(`[pcp-metrics] Upstash mirror failed: ${error.message}`);
    return false;
  }
}

app.get('/metrics', async (req, res) => {
  const snapshot = buildMetricsSnapshot();
  if (upstash) {
    await mirrorSnapshotToUpstash().catch(() => {});
  }
  res.json(snapshot);
});

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[pcp-metrics] Listening on port ${PORT}`);
  if (upstash) {
    mirrorSnapshotToUpstash().catch(() => {});
    setInterval(() => {
      mirrorSnapshotToUpstash().catch(() => {});
    }, UPSTASH_SYNC_INTERVAL_MS).unref?.();
  }
});
