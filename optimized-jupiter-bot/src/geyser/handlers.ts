<<<<<<< HEAD
import { logger } from '../utils/logger';
import { fetchJupiterQuote, getParallelSwapInstructions } from '../jupiter/quotes';
import { buildVersionedTransaction } from '../execution/transaction';
import { submitTransactionWithRacing } from '../execution/racing';
import { config } from '../utils/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { cacheTradeMetrics } from '../utils/trade_logger';

const TOKENS = {
  WSOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYtM2wYSzRo",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbPwdrsxGBK",
  PYTH: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3AkTftx2K2aFCh",
  JTO: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
  POPCAT: "7GCihgDB8fe6KNjn2gN7ZDB2h2n2i2Z7pW2r2YjN1e8p",
  BOME: "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgM2W8qT"
};

const TRADE_ROUTES = [
  [TOKENS.WSOL, TOKENS.USDC],
  [TOKENS.WSOL, TOKENS.WIF],
  [TOKENS.WSOL, TOKENS.BONK],
  [TOKENS.WSOL, TOKENS.RAY],
  [TOKENS.WSOL, TOKENS.JUP],
  [TOKENS.WSOL, TOKENS.PYTH],
  [TOKENS.WSOL, TOKENS.JTO],
  [TOKENS.WSOL, TOKENS.POPCAT],
  [TOKENS.WSOL, TOKENS.BOME]
];

// Dynamic Routing Array (Updated via multi-DEX fetch)
let DYNAMIC_ROUTES = [...TRADE_ROUTES];

async function refreshDynamicTokens() {
  try {
    const jupRes = await fetch("https://token.jup.ag/strict");
    const jupData = await jupRes.json();
    
    if (jupData && jupData.length > 0) {
      const newRoutes: string[][] = [];
      const shuffled = jupData.sort(() => 0.5 - Math.random()).slice(0, 50);
      
      shuffled.forEach((token: any) => {
        if (token.address !== TOKENS.WSOL) {
            newRoutes.push([TOKENS.WSOL, token.address]);
        }
      });
      
      DYNAMIC_ROUTES = [...TRADE_ROUTES, ...newRoutes];
      logger.info(`✅ Multi-DEX Token Rotator pulled ${newRoutes.length} trending items! Current Hunting Scope: ${DYNAMIC_ROUTES.length} routes.`);
    }

    if (config.BAGS_API_KEY) {
      const bagsRes = await fetch("https://public-api-v2.bags.fm/api/v1/tokens", {
         headers: { 'Authorization': `Bearer ${config.BAGS_API_KEY}` }
      });
      if (bagsRes.ok) {
         logger.debug("Bags API authenticated securely.");
      }
    }
  } catch (err) {
    logger.warn("Failed to fetch dynamic tokens:", err);
  }
}

refreshDynamicTokens();
// Refresh every 60 seconds (1 minute) for absolute maximum trending pool tracking
setInterval(refreshDynamicTokens, 60 * 1000);

import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

// Connection for wallet balance checking
const connection = new Connection(config.RPC_ENDPOINT, { commitment: 'processed' });
const walletPubkey = new PublicKey(config.WALLET_PUBLIC_KEY);
let cachedLamportsBalance = 0.5 * 10 ** 9; // Fallback
let existingAtas = new Set<string>();

// Update balance and known ATAs every 30 seconds
setInterval(async () => {
  try {
    cachedLamportsBalance = await connection.getBalance(walletPubkey);
    
    // Fetch all token accounts to cache existing ATAs
    const accounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, {
      programId: TOKEN_PROGRAM_ID
    });
    
    const tokenMints = accounts.value.map(acc => acc.account.data.parsed.info.mint);
    existingAtas = new Set(tokenMints);
  } catch (err) {
    logger.warn("Failed to fetch wallet balance and ATAs:", err);
  }
}, 30000);

let hasForcedInitialTrade = false;

let lastTradeTime = 0;

export async function handleAccountUpdate(data: any) {
  const startMs = Date.now();
  
  // Guard-rail removal cooldown: prevent >10ms Geyser stream from physically draining all Solana via gas inside 1 second
  if (startMs - lastTradeTime < 10000) return;

  if (process.env.DEBUG) {
    logger.debug(`[GEYSER] Stream triggered account update event.`);
  }

  const route = DYNAMIC_ROUTES[Math.floor(Math.random() * DYNAMIC_ROUTES.length)];
  const inputMint = route[0];
  const intermediateMint = route[1];
  
  // Phase 16a: Temporal Jitter (Anti-Trust / MEV Obfuscation)
  // Suspends execution for 5-25ms to spoof synthetic robotic tick-rates, destroying Validator Sandwich predictions
  const temporalJitterMs = Math.floor(Math.random() * 20) + 5;
  await new Promise(resolve => setTimeout(resolve, temporalJitterMs));
  
  // Phase 16b: Quantitative Parameter Jitter
  // Randomizes flat block sizing to generate organic, human-like byte lengths natively bypassing RPC WAF blocks
  const generateJitter = () => Number((Math.random() * 0.009).toFixed(4));
  const tradeSizes = [
    0.05 + generateJitter(), 
    0.10 + generateJitter(), 
    0.25 + generateJitter(), 
    0.50 + generateJitter()
  ];
  
  logger.info(`🔍 [JITTER: +${temporalJitterMs}ms] Hunting synthetic volumes for Route: WSOL -> ${intermediateMint.substring(0, 4)}...`);

  const sweepResults = await Promise.all(tradeSizes.map(async (size) => {
    const tradeSizeLamports = Math.floor(size * 10**9);
    // Ensure the wallet can actually afford this leg (plus gas padding)
    if (cachedLamportsBalance < tradeSizeLamports + 50000) return null; 

    const quote1 = await fetchJupiterQuote(inputMint, intermediateMint, tradeSizeLamports);
    if (!quote1) return null;

    const intermediateAmount = Number(quote1.otherAmountThreshold);
    const quote2 = await fetchJupiterQuote(intermediateMint, inputMint, intermediateAmount);
    if (!quote2) return null;

    const expectedOut = Number(quote2.outAmount);
    const grossProfitLamports = expectedOut - tradeSizeLamports;
    
    // Subtract standard physical network fees natively (Bypassing MEV Tips constraints)
    // Freed up ~200,000 lamports of margin previously wasted on Artificial buffers!
    const ESTIMATED_GAS_AND_TIP_LAMPORTS = 15000; 

    // CRITICAL FIX: Account for ~0.002 SOL Rent Exemption if this is a new dynamically routed token!
    // Without this, the bot bleeds 2,000,000 lamports per new token, far exceeding typical 5bps arbitrage profit!
    const ATA_RENT_LAMPORTS = existingAtas.has(intermediateMint) ? 0 : 2039280;

    const netProfitLamports = grossProfitLamports - ESTIMATED_GAS_AND_TIP_LAMPORTS - ATA_RENT_LAMPORTS;
    const netProfitBps = (netProfitLamports / tradeSizeLamports) * 10000;

    return { size, quote1, quote2, netProfitLamports, netProfitBps };
  }));

  // Filter valid completed sweeps
  const validResults = sweepResults.filter(r => r !== null);
  if (validResults.length === 0) return;

  // Select the trade size that yielded the highest absolute SOL profit
  const bestResult = validResults.sort((a, b) => b!.netProfitLamports - a!.netProfitLamports)[0]!;

  const processMs = Date.now() - startMs;

  if (bestResult.netProfitBps > 0) {
    logger.info(`✅ [ARBITRAGE FOUND] Size: ${bestResult.size} SOL | Net Profit: ${bestResult.netProfitBps.toFixed(2)} bps (${(bestResult.netProfitLamports / 10**9).toFixed(5)} SOL) [Sweep Ms: ${processMs}ms]`);
  } else {
    logger.info(`❌ [NO ARBITRAGE] Route: SOL -> ${intermediateMint.substring(0, 4)}... | Best Size: ${bestResult.size} SOL yielded Net Loss: ${bestResult.netProfitBps.toFixed(2)} bps. [Sweep Ms: ${processMs}ms]`);
  }

  // Final confirmation to execute
  if (bestResult.netProfitBps >= config.MIN_PROFIT_BPS) {
    lastTradeTime = Date.now(); // Instantly lock out the concurrent Geyser streams
    logger.warn(`🔥 PROFITABLE OPPORTUNITY DETECTED on Size ${bestResult.size} SOL! Proceeding to bundle extraction...`);
    
    let signatureStr: string | null = null;
    let success = false;
    
    const instructions = await getParallelSwapInstructions(bestResult.quote1, bestResult.quote2);
    if (instructions) {
      const transaction = await buildVersionedTransaction(instructions.ix1, instructions.ix2);
      if (transaction) {
        const rpcResult = await submitTransactionWithRacing(transaction);
        if (rpcResult && rpcResult.success) {
            signatureStr = (rpcResult as any).signature as string;
        }
      } else {
        logger.error('Failed to build versioned transaction.');
      }
    } else {
      logger.error('Failed to get routing instructions.');
    }

    // Persist evaluation metrics for analytics & refining rolling period strategies
    cacheTradeMetrics({
        timestamp: Date.now(),
        date: new Date().toISOString(),
        inputMint: bestResult.quote1.inputMint,
        outputMint: bestResult.quote1.outputMint,
        tradeSizeSOL: bestResult.size,
        expectedProfitSOL: bestResult.netProfitLamports / 10**9,
        expectedProfitBps: bestResult.netProfitBps,
        signature: signatureStr,
        success: success
=======
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
const SIGNAL_MAX_AGE = 2 * 60 * 1000; // ignore signals older than 2 min

interface EpochSignal  { active: boolean; boost: number; updatedAt: number; }
interface VolSignal    { mints: Array<{ mint: string; pct1h: number }>; updatedAt: number; }
interface LaunchSignal { mints: Array<{ mint: string; source: string }>; updatedAt: number; }

let epochSignal:  EpochSignal  = { active: false, boost: 0, updatedAt: 0 };
let volSignal:    VolSignal    = { mints: [], updatedAt: 0 };
let launchSignal: LaunchSignal = { mints: [], updatedAt: 0 };

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
  epochSignal  = readSignal<EpochSignal> (EPOCH_FILE,  { active: false, boost: 0, updatedAt: 0 });
  volSignal    = readSignal<VolSignal>   (VOL_FILE,    { mints: [], updatedAt: 0 });
  launchSignal = readSignal<LaunchSignal>(LAUNCH_FILE, { mints: [], updatedAt: 0 });
}, 60_000);
// Initial read
epochSignal  = readSignal<EpochSignal> (EPOCH_FILE,  { active: false, boost: 0, updatedAt: 0 });
volSignal    = readSignal<VolSignal>   (VOL_FILE,    { mints: [], updatedAt: 0 });
launchSignal = readSignal<LaunchSignal>(LAUNCH_FILE, { mints: [], updatedAt: 0 });

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
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f
    });
  }
}

<<<<<<< HEAD
export function startGeyserListeners(stream: any) {
  stream.on('data', (data: any) => {
    try {
      if (data.filters && data.filters.includes('jupiter')) {
        handleAccountUpdate(data);
=======
// ── Geyser stream bootstrap ───────────────────────────────────────────────────
export function startGeyserListeners(stream: any) {
  // Boot multi-launchpad scanner alongside the Geyser stream
  startLaunchpadScanner();

  stream.on('data', (data: any) => {
    try {
      // Accept ANY program update — route to handler which will classify it
      if (data.filters && data.filters.length > 0) {
        handleAccountUpdate(data).catch(e => logger.error('[GEYSER] handler error:', e));
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f
      }
    } catch (err) {
      logger.error('Error handling geyser message', err);
    }
  });

<<<<<<< HEAD
  stream.on('error', (err: any) => {
    logger.error('Geyser stream error', err);
  });

  stream.on('end', () => {
    logger.warn('Geyser stream ended. Consider reconnecting.');
  });
}

=======
  stream.on('error', (err: any) => logger.error('Geyser stream error', err));
  stream.on('end',   ()         => logger.warn('Geyser stream ended. Consider reconnecting.'));
}
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f
