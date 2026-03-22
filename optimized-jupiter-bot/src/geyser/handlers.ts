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

// [7] Minimum trade size for LST/defi routes (to clear gas+ATA floor)
const LST_MIN_TRADE_SOL = parseFloat(process.env.LST_MIN_TRADE_SOL || '1.0');
// [1] Parallel batch size per Geyser tick
const BATCH_SIZE = parseInt(process.env.SCAN_BATCH_SIZE || '5');


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

  // [1] Get top BATCH_SIZE (5) priority routes, scan all concurrently
  const routes = globalRouteManager.getNextBatch(BATCH_SIZE);
  if (routes.length === 0) return;

  await Promise.allSettled(routes.map(route =>
    scanRoute(route.outputMint, route.entry.category, params, startMs)
  ));
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

  // Record EMA outcome
  globalRouteManager.recordOutcome(outputMint, netProfitBps, netProfitSOL > params.MIN_PROFIT_SOL);

  const totalElapsed = Date.now() - startMs;

  if (netProfitBps > 0) {
    logger.info(`✅ [ARB] SOL→${outputMint.slice(0, 6)}… | ${tradeSOL}SOL | +${netProfitBps.toFixed(2)}bps (+${netProfitSOL.toFixed(5)}SOL) | quote:${quoteAgeMs}ms total:${totalElapsed}ms`);
  } else {
    logger.debug(`❌ [SCAN] SOL→${outputMint.slice(0, 6)}… | ${netProfitBps.toFixed(2)}bps | quote:${quoteAgeMs}ms`);
  }

  // ── Execute if profitable ────────────────────────────────────────────────
  if (netProfitSOL >= params.MIN_PROFIT_SOL) {
    logger.warn(`🔥 EXECUTING: ${tradeSOL}SOL→${outputMint.slice(0,8)}… | Est. net +${netProfitSOL.toFixed(5)}SOL | signal-age:${quoteAgeMs}ms`);

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
      expectedProfitSOL: netProfitSOL,
      expectedProfitBps: netProfitBps,
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
