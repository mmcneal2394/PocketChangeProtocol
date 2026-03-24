/**
 * opportunity_signals.ts  —  Oracle×3: epoch + volatility + launch detection
 * ─────────────────────────────────────────────────────────────────────────────
 * Writes signal files to ./signals/ that handlers.ts can read to dynamically
 * boost route priority. Three parallel signal monitors:
 *
 *   1. EPOCH BOUNDARY   — boosts LST routes when slot index > 90%
 *   2. VOLATILITY SPIKE — boosts meme routes on >5% move in 5 min
 *   3. LAUNCHPAD LAUNCH — flags tokens passing screen within 60s of mint
 *
 * Signal files:
 *   signals/epoch_boost.json     { active: bool, boost: 0-25, epoch, pct }
 *   signals/volatility.json      { mints: [{mint, sym, pct1h, direction}] }
 *   signals/fresh_launches.json  { mints: [{mint, source, detectedAt}] }
 *
 * Usage:
 *   npx ts-node scripts/maintain/opportunity_signals.ts
 *   --epoch-only | --vol-only | --launch-only
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs   from 'fs';
import path from 'path';
import { Connection } from '@solana/web3.js';

const SIGNALS_DIR  = path.join(process.cwd(), 'signals');
const EPOCH_FILE   = path.join(SIGNALS_DIR, 'epoch_boost.json');
const VOL_FILE     = path.join(SIGNALS_DIR, 'volatility.json');
const LAUNCH_FILE  = path.join(SIGNALS_DIR, 'fresh_launches.json');

const EPOCH_ONLY   = process.argv.includes('--epoch-only');
const VOL_ONLY     = process.argv.includes('--vol-only');
const LAUNCH_ONLY  = process.argv.includes('--launch-only');
const RUN_ALL      = !EPOCH_ONLY && !VOL_ONLY && !LAUNCH_ONLY;

const RPC = process.env.RPC_ENDPOINT || '';

// ── Ensure signals dir ────────────────────────────────────────────────────────
if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });

// ── Symbol map for logging ────────────────────────────────────────────────────
const SYMBOLS: Record<string, string> = {
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So':  'MSOL',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn':  'jitoSOL',
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1':   'bSOL',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263':  'BONK',
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYtM2wYSzRo':  'WIF',
  '7GCihgDB8fe6KNjn2gN7ZDB2h2n2i2Z7pW2r2YjN1e8p':  'POPCAT',
};

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL 1: Epoch boundary boost (LST yield accrual window)
// ═══════════════════════════════════════════════════════════════════════════════
async function checkEpoch() {
  try {
    if (!RPC) throw new Error('RPC_ENDPOINT not set');
    const conn = new Connection(RPC, 'confirmed');
    const ei   = await conn.getEpochInfo();
    const pct  = ei.slotIndex / ei.slotsInEpoch;
    const boost = pct >= 0.90 ? Math.round((pct - 0.90) / 0.10 * 25) : 0;
    const active = boost > 0;

    const signal = { active, boost, epoch: ei.epoch, pct: parseFloat(pct.toFixed(4)), updatedAt: Date.now() };
    fs.writeFileSync(EPOCH_FILE, JSON.stringify(signal, null, 2));

    if (active) console.log(`[SIGNAL/EPOCH] ✅ Epoch ${ei.epoch} at ${(pct*100).toFixed(1)}% — LST boost: +${boost}`);
    else        console.log(`[SIGNAL/EPOCH] Epoch ${ei.epoch} at ${(pct*100).toFixed(1)}% — no boost yet`);
  } catch (e: any) {
    console.warn(`[SIGNAL/EPOCH] Failed: ${e.message}`);
    fs.writeFileSync(EPOCH_FILE, JSON.stringify({ active: false, boost: 0, error: e.message, updatedAt: Date.now() }));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL 2: Volatility spike detection (>5% move in 1h via DexScreener)
// ═══════════════════════════════════════════════════════════════════════════════
const VOL_THRESHOLD_PCT = parseFloat(process.env.VOL_SPIKE_PCT || '5');

const MONITORED_MINTS = [
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYtM2wYSzRo',
  '7GCihgDB8fe6KNjn2gN7ZDB2h2n2i2Z7pW2r2YjN1e8p',
  '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',
];

async function checkVolatility() {
  try {
    const mints = MONITORED_MINTS.join(',');
    const r = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mints}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) throw new Error(`DexScreener ${r.status}`);
    const data  = await r.json();
    const pairs = (data?.pairs || []).filter((p: any) => p.chainId === 'solana');

    // Best pair per mint (highest liquidity)
    const byMint = new Map<string, any>();
    for (const p of pairs) {
      const m = p.baseToken?.address;
      if (!m) continue;
      if (!byMint.has(m) || (p.liquidity?.usd || 0) > (byMint.get(m).liquidity?.usd || 0)) byMint.set(m, p);
    }

    const spikes: Array<{ mint: string; sym: string; pct1h: number; direction: string }> = [];
    for (const [mint, pair] of byMint) {
      const pct1h = parseFloat(pair.priceChange?.h1 || '0');
      if (Math.abs(pct1h) >= VOL_THRESHOLD_PCT) {
        spikes.push({ mint, sym: SYMBOLS[mint] || mint.slice(0,8), pct1h, direction: pct1h > 0 ? 'up' : 'down' });
      }
    }
    spikes.sort((a, b) => Math.abs(b.pct1h) - Math.abs(a.pct1h));

    const signal = { mints: spikes, count: spikes.length, threshold: VOL_THRESHOLD_PCT, updatedAt: Date.now() };
    fs.writeFileSync(VOL_FILE, JSON.stringify(signal, null, 2));

    if (spikes.length > 0) {
      console.log(`[SIGNAL/VOL] ⚡ ${spikes.length} spike(s) ≥${VOL_THRESHOLD_PCT}%:`);
      for (const s of spikes) console.log(`  ${s.direction === 'up' ? '▲' : '▼'} ${s.sym}: ${s.pct1h > 0 ? '+' : ''}${s.pct1h}% 1h`);
    } else {
      console.log(`[SIGNAL/VOL] Market calm — no spikes ≥${VOL_THRESHOLD_PCT}% 1h`);
    }
  } catch (e: any) {
    console.warn(`[SIGNAL/VOL] Failed: ${e.message}`);
    fs.writeFileSync(VOL_FILE, JSON.stringify({ mints: [], count: 0, error: e.message, updatedAt: Date.now() }));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL 3: Fresh launch detection (PumpFun + Raydium new pools <60s old)
// ═══════════════════════════════════════════════════════════════════════════════
let knownLaunches = new Set<string>(); // in-memory dedup

async function checkFreshLaunches() {
  const fresh: Array<{ mint: string; source: string; detectedAt: number; liqUsd: number }> = [];
  try {
    // PumpFun: query the latest pairs on DexScreener filtered by dex=pumpfun
    const r = await fetch(
      'https://api.dexscreener.com/latest/dex/search?q=SOL&chainIds=solana',
      { signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) throw new Error(`DexScreener ${r.status}`);
    const data    = await r.json();
    const pairs   = (data?.pairs || []).filter((p: any) => p.chainId === 'solana');
    const nowSec  = Date.now() / 1000;

    for (const pair of pairs) {
      const mint     = pair.baseToken?.address;
      const ageS     = pair.pairCreatedAt ? (nowSec - pair.pairCreatedAt / 1000) : Infinity;
      const liqUsd   = pair.liquidity?.usd || 0;
      const dex      = pair.dexId || 'unknown';

      if (!mint || knownLaunches.has(mint)) continue;
      // Fresh = created within last 5 minutes, has some liquidity
      if (ageS <= 300 && liqUsd >= 500) {
        fresh.push({ mint, source: dex, detectedAt: Date.now(), liqUsd });
        knownLaunches.add(mint);
      }
    }

    // Keep knownLaunches bounded (only last 500)
    if (knownLaunches.size > 500) knownLaunches = new Set([...knownLaunches].slice(-500));

    const signal = { mints: fresh, count: fresh.length, updatedAt: Date.now() };
    fs.writeFileSync(LAUNCH_FILE, JSON.stringify(signal, null, 2));

    if (fresh.length > 0) {
      console.log(`[SIGNAL/LAUNCH] 🚀 ${fresh.length} fresh token(s) detected:`);
      for (const t of fresh) console.log(`  ${t.mint.slice(0,8)}… [${t.source}] $${t.liqUsd.toFixed(0)} liq`);
    } else {
      console.log(`[SIGNAL/LAUNCH] No fresh launches in last 5 min`);
    }
  } catch (e: any) {
    console.warn(`[SIGNAL/LAUNCH] Failed: ${e.message}`);
    fs.writeFileSync(LAUNCH_FILE, JSON.stringify({ mints: [], count: 0, error: e.message, updatedAt: Date.now() }));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Entry — run once then loop every 60s
// ═══════════════════════════════════════════════════════════════════════════════
async function runAll() {
  const tasks: Promise<void>[] = [];
  if (RUN_ALL || EPOCH_ONLY)  tasks.push(checkEpoch());
  if (RUN_ALL || VOL_ONLY)    tasks.push(checkVolatility());
  if (RUN_ALL || LAUNCH_ONLY) tasks.push(checkFreshLaunches());
  await Promise.allSettled(tasks);
}

const POLL_MS = parseInt(process.env.SIGNAL_POLL_MS || '60000');
runAll();
setInterval(runAll, POLL_MS);
console.log(`[SIGNALS] Polling every ${POLL_MS / 1000}s. Signal files → ${SIGNALS_DIR}`);
