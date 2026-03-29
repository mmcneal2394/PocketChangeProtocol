/**
 * launchpad_scanner.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Discovers new token pools across every major Solana launchpad by:
 *   1. Polling each launchpad's public API for new/trending tokens
 *   2. (When Geyser filter supports it) listening for on-chain new pool events
 *
 * Emits discovered tokens to the RouteManager for scoring + arb scanning.
 * All tokens pass through contract_screener.ts before being added to routes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { logger } from '../utils/logger';
import { globalRouteManager } from './route_manager';
import { screenContract } from '../security/contract_screener';
import Redis from 'ioredis';

const redisScanPub = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const WSOL = 'So11111111111111111111111111111111111111112';

// ── Launchpad program IDs (for Geyser subscriptions) ─────────────────────────
export const LAUNCHPAD_PROGRAMS = {
  PUMP_FUN:      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  RAYDIUM_V4:    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CLMM:  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  METEORA_DLMM:  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  ORCA_WHIRL:    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  BONK_FUN:      'BonfidaBotPFWFaBTDGFoqhEWAAAAAAAAAAAAAAAAAAAA', // placeholder
};

// ── Fetch helpers (with 5s timeout + retry) ───────────────────────────────────
async function fetchJson(url: string, opts: RequestInit = {}, retries = 2): Promise<any> {
  for (let i = 0; i <= retries; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e: any) {
      clearTimeout(t);
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  }
}

// ── Queue: deduplicate mints already seen this session ────────────────────────
const seenMints = new Set<string>();

async function processNewMint(mint: string, source: string, liquidityUsd = 0) {
  if (seenMints.has(mint) || mint === WSOL) return;
  seenMints.add(mint);

  const screen = await screenContract(mint);
  if (!screen.safe) {
    logger.debug(`[SCANNER][${source}] ⛔ ${mint.slice(0, 8)}… blocked — ${screen.reasons.join(', ')}`);
    return;
  }

  globalRouteManager.addToken({
    mint,
    source,
    liquidityUsd,
    trustScore: screen.score,
    addedAt: Date.now(),
  });
  logger.info(`[SCANNER][${source}] ✅ ${mint.slice(0, 8)}… added (score: ${screen.score}/100, liq: $${liquidityUsd.toFixed(0)})`);
  
  if (source === 'PumpFun' || source === 'Raydium' || source === 'Geyser' || source === 'PumpFun-Geyser') {
      logger.info(`[SCANNER] ⚡ Firing Mock Velocity for immediate Snipe evaluation: ${mint}`);
      // Push mock velocity to trigger velocityOverride loop inside momentum_sniper
      redisScanPub.publish('stream:velocity', JSON.stringify({
          mint: mint,
          buys60s: 5,
          sells60s: 0,
          velocity: 25, // well over 15
          buyRatio60s: 1.0,
          solVolume60s: 10,
          isAccelerating: true
      }));
  }
}

// ══ 1. Jupiter verified + all token list ═════════════════════════════════════
async function pollJupiter() {
  try {
    // Use "all" not "strict" — gets every token Jupiter can route, ~50k+
    const tokens: any[] = await fetchJson('https://token.jup.ag/all');
    logger.info(`[SCANNER][Jupiter] ${tokens.length} tokens in universe`);

    // Prioritise by: has tags, is not SOL/USDC, shuffle for variety
    const candidates = tokens
      .filter(t => t.address !== WSOL && t.chainId === 101)
      .sort(() => Math.random() - 0.5)
      .slice(0, 200); // batch of 200 per poll

    for (const t of candidates) {
      await processNewMint(t.address, 'Jupiter');
    }
  } catch (e: any) {
    logger.warn(`[SCANNER][Jupiter] poll failed: ${e.message}`);
  }
}

// ══ 2. Pump.fun — trending / king of the hill tokens ═════════════════════════
async function pollPumpFun() {
  try {
    // Pump.fun public API — recently graduated + trending
    const [graduated, trending] = await Promise.allSettled([
      fetchJson('https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=market_cap&order=DESC&includeNsfw=false'),
      fetchJson('https://frontend-api.pump.fun/coins/king-of-the-hill?includeNsfw=false'),
    ]);

    const coins: any[] = [];
    if (graduated.status === 'fulfilled' && Array.isArray(graduated.value)) coins.push(...graduated.value);
    if (trending.status === 'fulfilled') coins.push(trending.value);

    for (const coin of coins.flat().filter(Boolean)) {
      const mint = coin.mint || coin.address;
      const liq = coin.usd_market_cap || coin.market_cap || 0;
      if (mint) await processNewMint(mint, 'PumpFun', liq);
    }
    logger.debug(`[SCANNER][PumpFun] processed ${coins.length} tokens`);
  } catch (e: any) {
    logger.warn(`[SCANNER][PumpFun] poll failed: ${e.message}`);
  }
}

// ══ 3. Bags.fm — PCP native launchpad ════════════════════════════════════════
async function pollBagsFm() {
  try {
    const apiKey = process.env.BAGS_API_KEY;
    const headers: any = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

    // Public token listing endpoint
    const data = await fetchJson('https://public-api-v2.bags.fm/api/v1/tokens?limit=50&sort=volume_24h', { headers });
    const tokens: any[] = data?.tokens || data?.data || (Array.isArray(data) ? data : []);

    for (const t of tokens) {
      const mint = t.mint_address || t.address || t.mint;
      const liq = t.liquidity_usd || t.volume_24h || 0;
      if (mint) await processNewMint(mint, 'BagsFm', liq);
    }
    logger.debug(`[SCANNER][BagsFm] processed ${tokens.length} tokens`);
  } catch (e: any) {
    logger.debug(`[SCANNER][BagsFm] poll failed: ${e.message}`);
  }
}

// ══ 4. Raydium — top pools by liquidity ══════════════════════════════════════
async function pollRaydium() {
  try {
    const data = await fetchJson('https://api.raydium.io/v2/main/pairs');
    const pairs: any[] = Array.isArray(data) ? data.slice(0, 100) : [];

    for (const p of pairs) {
      // Each pair has two mints — add non-SOL/USDC side
      const mints = [p.baseMint, p.quoteMint].filter(m =>
        m && m !== WSOL && m !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      );
      for (const mint of mints) {
        await processNewMint(mint, 'Raydium', p.liquidity || 0);
      }
    }
    logger.debug(`[SCANNER][Raydium] processed ${pairs.length} pairs`);
  } catch (e: any) {
    logger.warn(`[SCANNER][Raydium] poll failed: ${e.message}`);
  }
}

// ══ 5. Meteora — dynamic pools ════════════════════════════════════════════════
async function pollMeteora() {
  try {
    const data = await fetchJson('https://app.meteora.ag/amm/pools?page=0&size=50&sort_key=tvl&order_by=desc');
    const pairs: any[] = data?.data || data?.pairs || [];

    for (const p of pairs) {
      const mints = [p.pool_token_mints?.[0], p.pool_token_mints?.[1]].filter(m =>
        m && m !== WSOL && m !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      );
      for (const mint of mints) {
        await processNewMint(mint, 'Meteora', p.pool_tvl || 0);
      }
    }
    logger.debug(`[SCANNER][Meteora] processed ${pairs.length} pools`);
  } catch (e: any) {
    logger.debug(`[SCANNER][Meteora] poll failed: ${e.message}`);
  }
}

// ══ 6. Orca Whirlpools ════════════════════════════════════════════════════════
async function pollOrca() {
  try {
    const data = await fetchJson('https://api.mainnet.orca.so/v1/whirlpool/list');
    const pools: any[] = data?.whirlpools || [];

    for (const p of pools.slice(0, 80)) {
      const mints = [p.tokenA?.mint, p.tokenB?.mint].filter(m =>
        m && m !== WSOL && m !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      );
      for (const mint of mints) {
        await processNewMint(mint, 'Orca', p.tvl || 0);
      }
    }
    logger.debug(`[SCANNER][Orca] processed ${pools.length} whirlpools`);
  } catch (e: any) {
    logger.debug(`[SCANNER][Orca] poll failed: ${e.message}`);
  }
}

// ══ 7. DexScreener — catches everything else ══════════════════════════════════
async function pollDexScreener() {
  try {
    const data = await fetchJson('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
    const pairs: any[] = data?.pairs?.filter((p: any) => p.chainId === 'solana') || [];

    for (const p of pairs.slice(0, 60)) {
      const mint = p.baseToken?.address;
      const liq = p.liquidity?.usd || 0;
      if (mint) await processNewMint(mint, 'DexScreener', liq);
    }
    logger.debug(`[SCANNER][DexScreener] processed ${pairs.length} pairs`);
  } catch (e: any) {
    logger.debug(`[SCANNER][DexScreener] poll failed: ${e.message}`);
  }
}

// ── Geyser new-pool event handler ─────────────────────────────────────────────
// Call this from handlers.ts when a new pool creation is detected
export async function handleNewPoolEvent(programId: string, accountData: any) {
  // Extract mint from raw account data depending on which program emitted it
  let mint: string | null = null;
  let source = 'Geyser';

  if (programId === LAUNCHPAD_PROGRAMS.PUMP_FUN) {
    mint = accountData?.mint || accountData?.baseMint;
    source = 'PumpFun-Geyser';
  } else if (programId === LAUNCHPAD_PROGRAMS.RAYDIUM_V4 || programId === LAUNCHPAD_PROGRAMS.RAYDIUM_CLMM) {
    mint = accountData?.baseMint || accountData?.mintA;
    source = 'Raydium-Geyser';
  } else if (programId === LAUNCHPAD_PROGRAMS.METEORA_DLMM) {
    mint = accountData?.tokenXMint;
    source = 'Meteora-Geyser';
  } else if (programId === LAUNCHPAD_PROGRAMS.ORCA_WHIRL) {
    mint = accountData?.tokenMintA;
    source = 'Orca-Geyser';
  }

  if (mint) await processNewMint(mint, source);
}

// ── Boot: stagger polling so APIs aren't hammered simultaneously ──────────────
export function startLaunchpadScanner() {
  logger.info('[SCANNER] Starting multi-launchpad token discovery...');

  // Initial polls staggered by 2s
  const POLLERS = [pollJupiter, pollPumpFun, pollBagsFm, pollRaydium, pollMeteora, pollOrca, pollDexScreener];
  POLLERS.forEach((fn, i) => setTimeout(fn, i * 2000));

  // Recurring intervals (staggered to avoid rate limits)
  setInterval(pollJupiter,      5  * 60 * 1000); // every 5 min
  setInterval(pollPumpFun,      2  * 60 * 1000); // every 2 min (fast launchpad)
  setInterval(pollBagsFm,       3  * 60 * 1000); // every 3 min
  setInterval(pollRaydium,      10 * 60 * 1000); // every 10 min
  setInterval(pollMeteora,      10 * 60 * 1000); // every 10 min
  setInterval(pollOrca,         10 * 60 * 1000); // every 10 min
  setInterval(pollDexScreener,  4  * 60 * 1000); // every 4 min

  logger.info('[SCANNER] All launchpad pollers active: Jupiter, PumpFun, BagsFm, Raydium, Meteora, Orca, DexScreener');
}
