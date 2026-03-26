/**
 * handlers.ts  —  Geyser stream handler (v2)
 * ─────────────────────────────────────────────────────────────────────────────
 * Wired to:
 *   • globalRouteManager  — priority-scored token queue (route_manager.ts)
 *   • launchpad_scanner   — multi-source token discovery
 *   • strategy_tuner      — live calibrated params (MIN_PROFIT, trade size…)
 *
 * Key improvements over v1:
 *   ✅ Per-route cooldowns (not a single 10s global lock)
 *   ✅ Kelly-calibrated trade sizes from strategy_params.json
 *   ✅ Scans top-priority routes from route_manager (not random)
 *   ✅ Records outcome back to route_manager for EMA learning
 *   ✅ Security-screened routes only (screened on discovery, not here)
 *   ✅ Geyser new-pool events routed to launchpad_scanner
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { logger }                           from '../utils/logger';
import { fetchJupiterQuote,
         getParallelSwapInstructions }       from '../jupiter/quotes';
import { buildVersionedTransaction }         from '../execution/transaction';
import { submitTransactionWithRacing }       from '../execution/racing';
import { config }                            from '../utils/config';
import { Connection, PublicKey }             from '@solana/web3.js';
import { TOKEN_PROGRAM_ID }                  from '@solana/spl-token';
import { cacheTradeMetrics }                 from '../utils/trade_logger';
import { globalRouteManager,
         getGasCost, markAtaCreated }        from '../discovery/route_manager';
import { startLaunchpadScanner,
         handleNewPoolEvent,
         LAUNCHPAD_PROGRAMS }                from '../discovery/launchpad_scanner';
import { loadStrategyParams }                from '../strategy_tuner';
import fs   from 'fs';
import path from 'path';

// ── Swarm signal files (written by scripts/maintain/opportunity_signals.ts) ──────
const SIGNALS_DIR    = path.join(process.cwd(), 'signals');
const EPOCH_FILE     = path.join(SIGNALS_DIR, 'epoch_boost.json');
const VOL_FILE       = path.join(SIGNALS_DIR, 'volatility.json');
const LAUNCH_FILE    = path.join(SIGNALS_DIR, 'fresh_launches.json');
const TRENDING_FILE  = path.join(SIGNALS_DIR, 'trending.json');   // ← NEW: DexScreener top-volume
const SIGNAL_MAX_AGE = 2 * 60 * 1000; // ignore signals older than 2 min

interface EpochSignal    { active: boolean; boost: number; updatedAt: number; }
interface VolSignal      { mints: Array<{ mint: string; pct1h: number }>; updatedAt: number; }
interface LaunchSignal   { mints: Array<{ mint: string; source: string }>; updatedAt: number; }
interface TrendingSignal { mints: Array<{ mint: string; symbol: string; volume24h: number; dexCount: number }>; updatedAt: number; }

let epochSignal:    EpochSignal    = { active: false, boost: 0, updatedAt: 0 };
let volSignal:      VolSignal      = { mints: [], updatedAt: 0 };
let launchSignal:   LaunchSignal   = { mints: [], updatedAt: 0 };
let trendingSignal: TrendingSignal = { mints: [], updatedAt: 0 };  // ← NEW

function readSignal<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (Date.now() - (raw.updatedAt || 0) > SIGNAL_MAX_AGE) return fallback; // stale
    return raw as T;
  } catch { return fallback; }
}

// Refresh signals every 60s (non-blocking)
setInterval(() => {
  epochSignal    = readSignal<EpochSignal>   (EPOCH_FILE,    { active: false, boost: 0, updatedAt: 0 });
  volSignal      = readSignal<VolSignal>     (VOL_FILE,      { mints: [], updatedAt: 0 });
  launchSignal   = readSignal<LaunchSignal>  (LAUNCH_FILE,   { mints: [], updatedAt: 0 });
  trendingSignal = readSignal<TrendingSignal>(TRENDING_FILE, { mints: [], updatedAt: 0 });
}, 60_000);
// Initial read
epochSignal    = readSignal<EpochSignal>   (EPOCH_FILE,    { active: false, boost: 0, updatedAt: 0 });
volSignal      = readSignal<VolSignal>     (VOL_FILE,      { mints: [], updatedAt: 0 });
launchSignal   = readSignal<LaunchSignal>  (LAUNCH_FILE,   { mints: [], updatedAt: 0 });
trendingSignal = readSignal<TrendingSignal>(TRENDING_FILE, { mints: [], updatedAt: 0 });

// ── Min-mode: low-capital operation (~$5 / 0.05 SOL) ────────────────────────────
// Activated by: MIN_MODE=true in env, or --min-mode CLI flag via dry_run_sim.ts
// Overrides: trade size 0.005 SOL, LST floor 0.005 SOL, batch size 1.
const MIN_MODE      = process.env.MIN_MODE === 'true';

// [7] Minimum trade size for LST/defi routes (to clear gas+ATA floor)
//     Min-mode lowers this to 0.005 SOL (disables the 1 SOL LST requirement)
const LST_MIN_TRADE_SOL = MIN_MODE
  ? parseFloat(process.env.LST_MIN_TRADE_SOL || '0.005')
  : parseFloat(process.env.LST_MIN_TRADE_SOL || '1.0');

// [1] Parallel batch size per Geyser tick
//     Min-mode forces 1 to avoid 5 concurrent 0.005 SOL holds
const BATCH_SIZE = MIN_MODE
  ? 1
  : parseInt(process.env.SCAN_BATCH_SIZE || '5');

if (MIN_MODE) {
  logger.info(`[MIN-MODE] 🌱 Low-capital mode active — trade: ${LST_MIN_TRADE_SOL} SOL | batch: ${BATCH_SIZE} | LST floor: ${LST_MIN_TRADE_SOL} SOL`);
}


// ── Wallet state (cached, refreshed every 30s) ────────────────────────────────
const connection  = new Connection(config.RPC_ENDPOINT, { commitment: 'processed' });
const walletPubkey = new PublicKey(config.WALLET_PUBLIC_KEY);
let cachedLamports = 0.05 * 1e9; // safe fallback
let existingAtas   = new Set<string>();

setInterval(async () => {
  try {
    cachedLamports = await connection.getBalance(walletPubkey);
    const accounts  = await connection.getParsedTokenAccountsByOwner(walletPubkey, { programId: TOKEN_PROGRAM_ID });
    existingAtas    = new Set(accounts.value.map(a => a.account.data.parsed.info.mint));
  } catch (e: any) {
    logger.warn(`[WALLET] Balance refresh failed: ${e.message}`);
  }
}, 30_000);

// ── Identify launchpad program from Geyser filter ─────────────────────────────
function detectProgram(filters: string[]): string | null {
  for (const prog of Object.values(LAUNCHPAD_PROGRAMS)) {
    if (filters.some(f => f.includes(prog))) return prog;
  }
  return null;
}

// ── Main account update handler ───────────────────────────────────────────────
export async function handleAccountUpdate(data: any) {
  const startMs = Date.now();
  const params   = loadStrategyParams();

  // ── New pool event? Route to launchpad scanner ───────────────────────────
  const program = detectProgram(data.filters || []);
  if (program && data.account) {
    handleNewPoolEvent(program, data.account).catch(() => {});
  }

  // ── MEV temporal jitter (5–25ms anti-sandwich) ───────────────────────────
  const jitterMs = Math.floor(Math.random() * 20) + 5;
  await new Promise(r => setTimeout(r, jitterMs));

  // [1] Get top BATCH_SIZE routes — apply swarm signal boosts
  let routes = globalRouteManager.getNextBatch(BATCH_SIZE);
  if (routes.length === 0) return;

  // ── Boost 1: Fresh launches → prepend to batch (one-scan priority) ─────────
  if (launchSignal.mints.length > 0) {
    const freshMints = new Set(launchSignal.mints.map(m => m.mint));
    const freshRoutes = routes.filter(r => freshMints.has(r.outputMint));
    const rest        = routes.filter(r => !freshMints.has(r.outputMint));
    routes = [...freshRoutes, ...rest].slice(0, BATCH_SIZE);
    if (freshRoutes.length > 0) logger.debug(`[SIGNAL] 🚀 ${freshRoutes.length} fresh launch(es) elevated to batch head`);
  }

  // ── Boost 2: Volatility spikes → elevate spiking mints ──────────────────
  if (volSignal.mints.length > 0) {
    const volMints    = new Set(volSignal.mints.map(m => m.mint));
    const volRoutes   = routes.filter(r => volMints.has(r.outputMint));
    const otherRoutes = routes.filter(r => !volMints.has(r.outputMint));
    routes = [...volRoutes, ...otherRoutes].slice(0, BATCH_SIZE);
    if (volRoutes.length > 0) logger.debug(`[SIGNAL] ⚡ ${volRoutes.length} volatile route(s) elevated`);
  }

  // ── Boost 3: Trending / high-volume cross-DEX tokens → front of queue ──────
  if (trendingSignal.mints.length > 0) {
    const trendMints   = new Set(trendingSignal.mints.map(m => m.mint));
    const trendRoutes  = routes.filter(r => trendMints.has(r.outputMint));
    const otherRoutes  = routes.filter(r => !trendMints.has(r.outputMint));

    // Also register any trending mints not yet in route_manager
    for (const tm of trendingSignal.mints) {
      if (!routes.find(r => r.outputMint === tm.mint)) {
        globalRouteManager.addToken({
          mint:         tm.mint,
          source:       'DexScreener-Trending',
          category:     tm.dexCount >= 3 ? 'bluechip' : 'meme',
          liquidityUsd: tm.volume24h / 24,  // hourly volume as liquidity proxy
          trustScore:   Math.min(100, 40 + tm.dexCount * 10),
          addedAt:      Date.now(),
        });
      }
    }

    routes = [...trendRoutes, ...otherRoutes].slice(0, BATCH_SIZE);
    if (trendRoutes.length > 0) logger.debug(`[SIGNAL] 📈 ${trendRoutes.length} trending route(s) elevated to batch head`);
  }

  await Promise.allSettled(routes.map(route =>
    scanRoute(route.outputMint, route.entry.category, params, startMs)
  ));
}

// ── Dynamic Jito tip calculator ──────────────────────────────────────────────
// When DYNAMIC_TIP_ENABLED=true, pay TIP_CEIL_PCT × netProfitLam as tip,
// floored at TIP_FLOOR_LAMPORTS. Falls back to fixed JITO_TIP_AMOUNT if disabled.
function calcJitoTip(netProfitLam: number): number {
  if (!config.DYNAMIC_TIP_ENABLED) return config.JITO_TIP_AMOUNT;
  const dynamic = Math.floor(netProfitLam * config.TIP_CEIL_PCT);
  return Math.max(config.TIP_FLOOR_LAMPORTS, dynamic);
}

// ── Scan a single route ───────────────────────────────────────────────────────
async function scanRoute(outputMint: string, category: string, params: ReturnType<typeof loadStrategyParams>, startMs: number) {
  const WSOL = 'So11111111111111111111111111111111111111112';

  // [7] LST/defi routes always trade at least LST_MIN_TRADE_SOL (1 SOL)
  // to clear the gas floor. Meme/launch use Kelly calibrated size.
  const isLst      = category === 'defi';
  const tradeSOL   = isLst
    ? Math.max(params.MAX_TRADE_SIZE_SOL, LST_MIN_TRADE_SOL)
    : params.MAX_TRADE_SIZE_SOL;
  const tradeLamports = Math.floor(tradeSOL * 1e9);

  // [5] ATA gas cost — reads ata_cache.json, returns 5000 if pre-created
  const gasLamports = getGasCost(outputMint);

  // Balance guard
  if (cachedLamports < tradeLamports + gasLamports + 50_000) {
    logger.debug(`[SCAN] Skipping ${outputMint.slice(0, 8)}… insufficient balance`);
    return;
  }

  // ── EMA fast-fail: skip quote API if route is consistently net-negative ──
  // Only applies after ≥10 scans — avoids false rejects on new routes.
  // Saves ~1 Helius RPC call + 1 Jupiter quote call per skipped route.
  const emaEst = globalRouteManager.getEmaEstimate(outputMint);
  if (emaEst !== null) {
    // Convert bps threshold to lamports for apples-to-apples comparison
    const minProfitBps = (params.MIN_PROFIT_SOL / tradeSOL) * 10_000;
    if (emaEst < -minProfitBps) {
      logger.debug(`[FAST-FAIL] ${outputMint.slice(0,8)}… EMA ${emaEst.toFixed(2)}bps below threshold — skipped quote fetch`);
      return;
    }
  }

  // [8] Quote with timestamp for telemetry
  const quoteStartMs = Date.now();
  const quote1 = await fetchJupiterQuote(WSOL, outputMint, tradeLamports);
  if (!quote1) return;

  const intermediateAmt = Number(quote1.otherAmountThreshold);
  const quote2          = await fetchJupiterQuote(outputMint, WSOL, intermediateAmt);
  if (!quote2) return;
  const quoteAgeMs = Date.now() - quoteStartMs;

  const expectedOut         = Number(quote2.outAmount);
  const grossProfitLamports = expectedOut - tradeLamports;
  const netProfitLam        = grossProfitLamports - gasLamports;
  const netProfitBps        = (netProfitLam / tradeLamports) * 10_000;
  const netProfitSOL        = netProfitLam / 1e9;

  // ── Dynamic Jito tip — only charged on execution (see below) ────────────────
  // Pre-calculate here for accurate profit check & logging.
  const jitoTipLam          = calcJitoTip(Math.max(0, netProfitLam));
  const netAfterTipLam      = netProfitLam - jitoTipLam;
  const netAfterTipSOL      = netAfterTipLam / 1e9;
  const netAfterTipBps      = (netAfterTipLam / tradeLamports) * 10_000;

  // Record EMA outcome (using post-tip profit — most accurate signal)
  globalRouteManager.recordOutcome(outputMint, netAfterTipBps, netAfterTipSOL > params.MIN_PROFIT_SOL);

  const totalElapsed = Date.now() - startMs;

  if (netAfterTipBps > 0) {
    logger.info(`✅ [ARB] SOL→${outputMint.slice(0, 6)}… | ${tradeSOL}SOL | +${netAfterTipBps.toFixed(2)}bps (+${netAfterTipSOL.toFixed(5)}SOL) | tip:${jitoTipLam}L | quote:${quoteAgeMs}ms total:${totalElapsed}ms`);
  } else {
    logger.debug(`❌ [SCAN] SOL→${outputMint.slice(0, 6)}… | gross:${netProfitBps.toFixed(2)}bps tip:${jitoTipLam}L net:${netAfterTipBps.toFixed(2)}bps | quote:${quoteAgeMs}ms`);
  }

  // ── Execute if profitable (post-tip) ────────────────────────────────────
  if (netAfterTipSOL >= params.MIN_PROFIT_SOL) {
    logger.warn(`🔥 EXECUTING: ${tradeSOL}SOL→${outputMint.slice(0,8)}… | Est. net +${netAfterTipSOL.toFixed(5)}SOL post-tip | tip:${jitoTipLam}L (${config.DYNAMIC_TIP_ENABLED ? 'dynamic' : 'fixed'}) | signal-age:${quoteAgeMs}ms`);

    let signatureStr: string | null = null;
    let success = false;
    const execStartMs = Date.now();

    try {
      const instructions = await getParallelSwapInstructions(quote1, quote2);
      if (instructions) {
        const transaction = await buildVersionedTransaction(instructions.ix1, instructions.ix2);
        if (transaction) {
          const rpcResult = await submitTransactionWithRacing(transaction);
          if (rpcResult?.success) {
            signatureStr = (rpcResult as any).signature as string;
            success      = true;
            // [5] Mark ATA as created so future trades don't pay rent again
            markAtaCreated(outputMint);
            // [8] Execution telemetry
            const execMs  = Date.now() - execStartMs;
            const signalAge = Date.now() - quoteStartMs;
            logger.info(`✅ EXECUTED | sig:${signatureStr?.slice(0,12)}… | exec:${execMs}ms | signal-age:${signalAge}ms`);
          }
        }
      }
    } catch (e: any) {
      logger.error(`[EXEC] Failed: ${e.message}`);
    }

    cacheTradeMetrics({
      timestamp:         Date.now(),
      date:              new Date().toISOString(),
      inputMint:         WSOL,
      outputMint,
      tradeSizeSOL:      tradeSOL,
      expectedProfitSOL: netAfterTipSOL,
      expectedProfitBps: netAfterTipBps,
      jitoTipLamports:   jitoTipLam,
      signature:         signatureStr,
      success,
      // [8] Telemetry fields
      quoteAgeMs,
      signalToExecMs: success ? Date.now() - quoteStartMs : undefined,
    });
  }
}

// ── Geyser stream bootstrap ───────────────────────────────────────────────────
export function startGeyserListeners(stream: any) {
  // Boot multi-launchpad scanner alongside the Geyser stream
  startLaunchpadScanner();

  stream.on('data', (data: any) => {
    try {
      // Accept ANY program update — route to handler which will classify it
      if (data.filters && data.filters.length > 0) {
        handleAccountUpdate(data).catch(e => logger.error('[GEYSER] handler error:', e));
      }
    } catch (err) {
      logger.error('Error handling geyser message', err);
    }
  });

  stream.on('error', (err: any) => logger.error('Geyser stream error', err));
  stream.on('end',   ()         => logger.warn('Geyser stream ended. Consider reconnecting.'));
}
