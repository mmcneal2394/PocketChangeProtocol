/**
 * route_manager.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Replaces the random DYNAMIC_ROUTES array in handlers.ts with a scored,
 * persistent priority queue.
 *
 * Every token discovered by launchpad_scanner.ts is registered here.
 * Routes are scored by:
 *   - Trust score from contract_screener (0–100)
 *   - Liquidity (higher = higher priority)
 *   - EMA of recent profit BPS on this route
 *   - Time since last scan (stale routes get a bump)
 *   - Source priority (Geyser real-time > API poll)
 *
 * getNextBatch(n) returns the top N routes to scan this tick.
 * recordOutcome() feeds results back so EMA updates.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { logger } from '../utils/logger';
import { Connection } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Source priority weights
const SOURCE_WEIGHT: Record<string, number> = {
  'PumpFun-Geyser':   100,
  'Raydium-Geyser':   100,
  'Meteora-Geyser':   100,
  'Orca-Geyser':      100,
  'PumpFun':           80,
  'BagsFm':            75,
  'Raydium':           70,
  'Orca':              65,
  'Meteora':           65,
  'DexScreener':       60,
  'Jupiter':           50,
};

// [2] Per-category cooldown (ms)
const CATEGORY_COOLDOWN_MS: Record<string, number> = {
  defi:     parseInt(process.env.COOLDOWN_DEFI    || '5000'),   // LST arb windows are short
  bluechip: parseInt(process.env.COOLDOWN_BLUE    || '10000'),
  meme:     parseInt(process.env.COOLDOWN_MEME    || '15000'),
  launch:   parseInt(process.env.COOLDOWN_LAUNCH  || '30000'),
  native:   parseInt(process.env.COOLDOWN_NATIVE  || '20000'),
  default:  parseInt(process.env.ROUTE_COOLDOWN_MS || '15000'),
};

// [3] LST epoch boost state
let epochBoost = 0;          // 0-25 extra priority points, set by fetchEpochBoost()
let lastEpochFetch = 0;

async function fetchEpochBoost(): Promise<void> {
  if (Date.now() - lastEpochFetch < 60_000) return; // refresh every 60s
  lastEpochFetch = Date.now();
  try {
    const rpc  = process.env.RPC_ENDPOINT || '';
    const conn = new Connection(rpc, 'confirmed');
    const ei   = await conn.getEpochInfo();
    const pct  = ei.slotIndex / ei.slotsInEpoch; // 0.0 → 1.0
    // Boost in the last 10% of epoch (yield accrual window)
    epochBoost = pct >= 0.90 ? Math.round((pct - 0.90) / 0.10 * 25) : 0;
    if (epochBoost > 0) logger.info(`[ROUTE-MGR] Epoch ${ei.epoch} at ${(pct*100).toFixed(1)}% — LST boost: +${epochBoost}`);
  } catch { epochBoost = 0; }
}

// [5] ATA existence cache — loaded from disk
const ATA_CACHE_FILE = path.join(__dirname, '..', '..', 'ata_cache.json');
function loadAtaCache(): Set<string> {
  try {
    if (fs.existsSync(ATA_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ATA_CACHE_FILE, 'utf-8'));
      return new Set(Object.keys(raw).filter(k => raw[k] === true));
    }
  } catch {}
  return new Set();
}
const ataCacheSet: Set<string> = loadAtaCache();
export function markAtaCreated(mint: string) { ataCacheSet.add(mint); }
export const ATA_RENT_LAMPORTS   = 2_039_280;
export const GAS_FLOOR_LAMPORTS  = 5_000; // priority fee only when ATA exists
export function getGasCost(mint: string): number {
  return ataCacheSet.has(mint) ? GAS_FLOOR_LAMPORTS : ATA_RENT_LAMPORTS + GAS_FLOOR_LAMPORTS;
}

// [4] Profitable tier threshold (bps)
const PROFITABLE_TIER_BPS = parseFloat(process.env.PROFITABLE_TIER_BPS || '3');


export interface TokenEntry {
  mint:         string;
  source:       string;
  category:     string;  // bluechip | defi | meme | launch | native
  liquidityUsd: number;
  trustScore:   number;
  addedAt:      number;
  // runtime stats
  emaProfitBps: number;
  scanCount:    number;
  lastScannedAt: number;
  lastProfitBps: number;
  wins:         number;
  losses:       number;
}

export interface Route {
  inputMint:      string;
  outputMint:     string;
  entry:          TokenEntry;
  priority:       number;    // computed score
  lastScannedAt:  number;
}

class RouteManager {
  private tokens = new Map<string, TokenEntry>();
  private routeCooldowns = new Map<string, number>(); // routeKey → lastScanTs

  // ── Add a new token (from any launchpad scanner) ────────────────────────────
  addToken(opts: { mint: string; source: string; category?: string; liquidityUsd: number; trustScore: number; addedAt: number }) {
    if (this.tokens.has(opts.mint)) {
      const existing = this.tokens.get(opts.mint)!;
      existing.liquidityUsd = Math.max(existing.liquidityUsd, opts.liquidityUsd);
      existing.trustScore   = Math.max(existing.trustScore, opts.trustScore);
      if (opts.category) existing.category = opts.category;
      return;
    }
    this.tokens.set(opts.mint, {
      ...opts,
      category:      opts.category || 'meme',
      emaProfitBps:  0,
      scanCount:     0,
      lastScannedAt: 0,
      lastProfitBps: 0,
      wins:          0,
      losses:        0,
    });
  }

  // ── Record outcome for EMA update ──────────────────────────────────────────
  recordOutcome(mint: string, profitBps: number, success: boolean) {
    const e = this.tokens.get(mint);
    if (!e) return;
    const alpha = 2 / (20 + 1); // EMA period = 20
    e.emaProfitBps  = alpha * profitBps + (1 - alpha) * e.emaProfitBps;
    e.lastProfitBps = profitBps;
    e.scanCount++;
    if (success) e.wins++; else e.losses++;
    e.lastScannedAt = Date.now();
  }

  // ── [4] Compute priority score for a token ───────────────────────────────
  private score(e: TokenEntry): number {
    const sourceW    = SOURCE_WEIGHT[e.source] ?? 50;
    const trustW     = e.trustScore;
    const liquidityW = Math.min(40, Math.log10(Math.max(1, e.liquidityUsd)) * 5);
    const profitW    = Math.min(30, Math.max(-10, e.emaProfitBps / 10));

    // [4] Confirmed-profitable tier: bypass staleness penalty, score floors at 200
    if (e.emaProfitBps >= PROFITABLE_TIER_BPS) {
      const lstBoost = (e.category === 'defi') ? epochBoost : 0; // [3] epoch boost
      return 200 + profitW + lstBoost;
    }

    // [3] Epoch boost for LST category even if not yet confirmed profitable
    const lstBoost = (e.category === 'defi') ? epochBoost * 0.5 : 0;

    const stalenessW = e.lastScannedAt === 0 ? 20
      : Math.min(20, (Date.now() - e.lastScannedAt) / 60_000);

    return sourceW + trustW + liquidityW + profitW + stalenessW + lstBoost;
  }

  // ── [2] Get top N routes — per-category cooldowns ────────────────────────
  getNextBatch(n: number): Route[] {
    // Async epoch refresh (fire-and-forget — result used next tick)
    fetchEpochBoost().catch(() => {});

    const now = Date.now();
    const routes: Route[] = [];

    for (const [mint, entry] of this.tokens) {
      const routeKey = `WSOL-${mint}`;
      const lastScan = this.routeCooldowns.get(routeKey) || 0;
      // [2] Per-category cooldown
      const cooldown = CATEGORY_COOLDOWN_MS[entry.category] ?? CATEGORY_COOLDOWN_MS.default;
      if (now - lastScan < cooldown) continue;

      routes.push({
        inputMint:     WSOL,
        outputMint:    mint,
        entry,
        priority:      this.score(entry),
        lastScannedAt: lastScan,
      });
    }

    routes.sort((a, b) => b.priority - a.priority);
    const batch = routes.slice(0, n);

    for (const r of batch) {
      this.routeCooldowns.set(`WSOL-${r.outputMint}`, now);
    }
    return batch;
  }

  // ── Bootstrap with expanded token list (scored 2026-03-22) ─────────────────
  seedDefaults() {
    const DEFAULTS: Array<{ mint: string; source: string; liq: number; trust: number; cat: string }> = [
      // ── Stablecoins (anchor routes) ──────────────────────────────────────────
      { mint: USDC,                                                  source: 'default', liq: 75_000_000, trust: 100, cat: 'bluechip' },
      { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',       source: 'default', liq: 871_000_000,trust: 100, cat: 'bluechip' }, // USDT

      // ── DeFi LSTs — showed +5-7bps spread in live scoring ────────────────────
      { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',       source: 'default', liq: 1_619_000,  trust: 90,  cat: 'defi'     }, // MSOL +6.94bps
      { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',       source: 'default', liq: 4_497_000,  trust: 90,  cat: 'defi'     }, // jitoSOL +6.15bps
      { mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',        source: 'default', liq: 618_000,    trust: 88,  cat: 'defi'     }, // bSOL +0.92bps
      { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',        source: 'default', liq: 715_000,    trust: 88,  cat: 'defi'     }, // ORCA +5.94bps
      { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',       source: 'default', liq: 3_492_000,  trust: 75,  cat: 'bluechip' }, // RAY +6.63bps (high rug flag — deweighted)

      // ── High-vol memes — within arb range with 100bps slippage ───────────────
      { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',       source: 'default', liq: 821_000,    trust: 85,  cat: 'meme'     }, // BONK  -9bps (marginal)
      { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYtM2wYSzRo',       source: 'DexScreener', liq: 4_200_000, trust: 85, cat: 'meme'  }, // WIF   top scored pair
      { mint: '7GCihgDB8fe6KNjn2gN7ZDB2h2n2i2Z7pW2r2YjN1e8p',       source: 'default', liq: 900_000,    trust: 83,  cat: 'meme'     }, // POPCAT
      { mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgM2W8qT',        source: 'default', liq: 600_000,    trust: 80,  cat: 'meme'     }, // BOME
      { mint: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',        source: 'DexScreener', liq: 3_000_000, trust: 80, cat: 'meme'  }, // TRUMP  -2bps (marginal)
      { mint: 'FUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P',       source: 'DexScreener', liq: 1_000_000, trust: 75, cat: 'meme'  }, // MELANIA
      { mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump',        source: 'DexScreener', liq: 2_000_000, trust: 78, cat: 'meme'  }, // FARTCOIN -1bps (near-arb)
      { mint: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC',       source: 'DexScreener', liq: 800_000,   trust: 72, cat: 'meme'  }, // AI16Z
      { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbPwdrsxGBK',         source: 'default', liq: 12_000_000,  trust: 88,  cat: 'bluechip' }, // JUP
      { mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',        source: 'default', liq: 739_000,    trust: 85,  cat: 'bluechip' }, // JTO

      // ── DexScreener top-boost pairs (discovered 2026-03-22) ──────────────────
      // (MEW, JELL scored in top 10 by DexScreener volume — watch for arb windows)
      { mint: '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4',       source: 'DexScreener', liq: 9_383_000, trust: 70, cat: 'meme'  }, // MEW
      { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3AkTftx2K2aFCh',       source: 'default', liq: 200_000,    trust: 85,  cat: 'bluechip' }, // PYTH

      // ── PCP native token ─────────────────────────────────────────────────────
      { mint: '4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS',       source: 'BagsFm', liq: 50_000,    trust: 75,  cat: 'native'   }, // PCP
    ];

    for (const d of DEFAULTS) {
      this.addToken({ mint: d.mint, source: d.source, liquidityUsd: d.liq, trustScore: d.trust, addedAt: Date.now() });
    }
    logger.info(`[ROUTE-MGR] Seeded ${this.tokens.size} default routes (bluechip + meme + defi + native)`);
  }


  stats() {
    return {
      totalTokens:  this.tokens.size,
      cooldowns:    this.routeCooldowns.size,
      topRoutes:    this.getNextBatch(5).map(r => ({
        mint:     r.outputMint.slice(0, 8) + '…',
        source:   r.entry.source,
        priority: r.priority.toFixed(1),
        ema:      r.entry.emaProfitBps.toFixed(2) + ' bps',
      })),
    };
  }
}

export const globalRouteManager = new RouteManager();

// Seed defaults at import time
globalRouteManager.seedDefaults();

// Log stats every 5 min
setInterval(() => {
  const s = globalRouteManager.stats();
  logger.info(`[ROUTE-MGR] Tracking ${s.totalTokens} tokens | Active cooldowns: ${s.cooldowns} | Top: ${JSON.stringify(s.topRoutes)}`);
}, 5 * 60 * 1000);
