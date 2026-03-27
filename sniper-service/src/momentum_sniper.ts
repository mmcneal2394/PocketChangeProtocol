/**
 * momentum_sniper.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Dedicated momentum sniper agent for pcprotocol arb engine.
 *
 * STRATEGY:
 *   What profitable bots do: detect new token launches with rapidly increasing
 *   transaction velocity (100+ txs in first 5 minutes), buy a micro position
 *   BEFORE price discovery completes, exit into the FOMO wave.
 *
 *   Target: Low-marketcap tokens ($10k-$500k) with:
 *     - >50 unique buyers in first 5 min
 *     - >3x average tx/min vs baseline
 *     - Listed on at least 2 DEXs (cross-DEX spread possible)
 *     - Not yet on major aggregators (alpha window open)
 *
 * EXECUTION:
 *   Buy: 0.01 SOL per snipe (max 2 concurrent open positions)
 *   Exit targets:
 *     - Take profit at +60% (realistic for early momentum plays)
 *     - Stop loss at -25% (protects against rugs)
 *     - Force exit after 10 min (prevents bag holding)
 *
 * SAFETY:
 *   - Max 2 open positions at once (capital protection)
 *   - Blacklists tokens that rug (price drops >50% in <2 min)
 *   - Skips tokens where top-10 wallets hold >70% supply
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs   from 'fs';
import path from 'path';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';
import { getWsolBalance, autoRefillWsol, ensureWsolAta } from './wsol_manager';
import { scoreCandidate, recordTradeOutcome, getModelSummary, EntryMetrics, recordShadowCandidate, checkShadowCandidates } from './adaptive_scorer';
import { VelocityTracker, VelocityData } from './velocity_tracker';
import {
  logDetection, logScoring, logEntry, logPriceCheck, logTrailActivation,
  logVelocitySnapshot, logOrderFlowReversal, logExit, getAnalyticsSummary, getOpenTrade,
} from './trade_logger';
import { PoolStateSubscriber } from './pool_state_subscriber';
import { getBondingCurveState, paperBuyOnCurve, getCurrentValueSol as getCurveValueSol, isOnBondingCurve, quoteTokensForSol, quoteSolForTokens } from './pump_trader';
import { liveBuyOnCurve, liveSellOnCurve } from './pump_executor';

let poolState: PoolStateSubscriber | null = null;

// In-process velocity tracker (replaces file-based IPC)
let velocityTracker: VelocityTracker | null = null;

dotenv.config({ path: path.join(process.cwd(), '.env') });

// ── Paper Mode ───────────────────────────────────────────────────────────────
const PAPER_MODE = (process.env.PAPER_MODE || 'true').toLowerCase() === 'true';
const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT    = process.env.TELEGRAM_CHAT_ID || '';
const PAPER_BALANCE = parseFloat(process.env.PAPER_BALANCE || '1.0'); // simulated SOL balance

async function sendTelegram(msg: string) {
  if (!TG_TOKEN || !TG_CHAT || TG_CHAT === 'disabled') {
    console.log('[TG] Skipped — no token/chat configured');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[TG] HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
  } catch (e: any) {
    console.error(`[TG] Send failed: ${e.message}`);
  }
}
// ─────────────────────────────────────────────────────────────────────────────

const RPC         = process.env.RPC_ENDPOINT!;
const JUP_KEY     = process.env.JUPITER_API_KEY!;
const JUP_BASE    = process.env.JUPITER_ENDPOINT || 'https://public.jupiterapi.com';
const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH || '';
const WSOL        = 'So11111111111111111111111111111111111111112';

const connection  = new Connection(RPC, { commitment: 'confirmed' });

// Wallet is optional in paper mode
let wallet: Keypair;
if (PAPER_MODE) {
  wallet = Keypair.generate(); // throwaway — never signs real txs
} else {
  const walletJson = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
  wallet = Keypair.fromSecretKey(new Uint8Array(walletJson));
}

// ── Config ───────────────────────────────────────────────────────────────────
const BASE_BUY_PCT     = parseFloat(process.env.SNIPER_BUY_PCT  || '0.10'); // 10% of balance — reduced after SL streak
const MIN_BUY_SOL      = parseFloat(process.env.SNIPER_MIN_BUY  || (PAPER_MODE ? '0.1' : '0.005'));
const MAX_BUY_SOL      = parseFloat(process.env.SNIPER_MAX_BUY  || (PAPER_MODE ? '0.1' : '0.03'));
const MAX_POSITIONS    = parseInt(process.env.SNIPER_MAX_POS   || '1');    // 1 position — quality over quantity
const MAX_HOLD_MS      = parseInt(process.env.SNIPER_MAX_HOLD  || '1800000'); // 30min hard cap (trailing stop exits first)
const RETRACE_SHIELD_MS = 30_000;  // SL doubled for first 30s only — exit bad trades faster
const MIN_VOLUME_1H    = parseFloat(process.env.SNIPER_MIN_VOL || '1000');  // $1k min — new pairs have low vol
const MIN_PRICE_CHG_1H = parseFloat(process.env.SNIPER_MIN_CHG || '-100'); // disabled — 1h irrelevant for new pairs
const MIN_BUY_RATIO    = parseFloat(process.env.SNIPER_MIN_BR  || '1.2');  // 1.2x buys vs sells — slight directional bias
const MIN_BUYS_1H      = parseInt(process.env.SNIPER_MIN_BUYS  || '10');   // 10 buys minimum — confirms real activity
const MAX_TOKEN_AGE_MIN= parseFloat(process.env.SNIPER_MAX_AGE  || '9999'); // no age limit — watch all tokens
const MIN_MOMENTUM_5M  = parseFloat(process.env.SNIPER_MIN_5M   || '-5');  // allow small dips, block active dumps (>-5%)
const POLL_MS          = parseInt(process.env.SNIPER_POLL_MS || '5000'); // 5s poll for DexScreener path
const EXIT_CHECK_MS    = 1000; // 1s exit checks — memecoins move fast
const SIGNALS_DIR      = path.join(process.cwd(), 'signals');
const TRENDING_FILE    = path.join(SIGNALS_DIR, 'trending.json');
const SNIPER_LOG       = path.join(SIGNALS_DIR, 'sniper_positions.json');
const STRATEGY_FILE    = path.join(SIGNALS_DIR, 'chart_strategy.json');
const JOURNAL_FILE     = path.join(SIGNALS_DIR, 'trade_journal.jsonl');
const ALLOCATION_FILE  = path.join(SIGNALS_DIR, 'allocation.json');  // HarmonyAgent capital weight
const VELOCITY_FILE    = path.join(SIGNALS_DIR, 'velocity.json');     // pcp-velocity real-time swap feed

// Load velocity for a single mint — uses in-process tracker (no file I/O)
function loadVelocity(mint: string): {
  buys60s: number; sells60s: number; buyRatio60s: number;
  velocity: number; isAccelerating: boolean; solVolume60s: number;
} | null {
  if (velocityTracker) {
    return velocityTracker.getMintData(mint);
  }
  // Fallback to file if tracker not initialized
  try {
    if (!fs.existsSync(VELOCITY_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(VELOCITY_FILE, 'utf-8'));
    const age = Date.now() - (raw.updatedAt || 0);
    if (age > 10_000) return null;
    return raw.mints?.[mint] || null;
  } catch { return null; }
}

// Load ALL velocity-tracked mints — uses in-process tracker
function loadAllVelocityMints(): Array<{
  mint: string; buys60s: number; sells60s: number; buyRatio60s: number;
  velocity: number; isAccelerating: boolean; solVolume60s: number;
}> {
  if (velocityTracker) {
    const hot = velocityTracker.getAllHot();
    return Array.from(hot.entries()).map(([mint, data]) => ({ mint, ...data }));
  }
  // Fallback to file
  try {
    if (!fs.existsSync(VELOCITY_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(VELOCITY_FILE, 'utf-8'));
    const age = Date.now() - (raw.updatedAt || 0);
    if (age > 10_000) return [];
    const mints = raw.mints || {};
    return Object.entries(mints).map(([mint, data]: [string, any]) => ({ mint, ...data }));
  } catch { return []; }
}

function loadSniperWeight(): number {
  try {
    if (!fs.existsSync(ALLOCATION_FILE)) return 1.0;
    const a = JSON.parse(fs.readFileSync(ALLOCATION_FILE, 'utf-8'));
    const w = a.sniper_weight ?? 1.0;
    return Math.min(1.0, Math.max(0.1, w)); // clamp 10%–100%
  } catch { return 1.0; }
}


// Append one trade record (JSONL — one line per trade)
function appendTrade(record: {
  agent: string; action: 'BUY' | 'SELL';
  mint: string; symbol: string;
  amountSol: number; pnlSol?: number;
  sig: string; reason?: string;
  taSig?: string; taConf?: number;
  holdMs?: number;
  rsi?: number; macdHist?: number;
  // Freshness fields (populated on BUY)
  tokenAgeSec?: number;     // age of token at entry time
  momentum5m?: number;      // 5-min price change at entry
  momentum1m?: number;      // 1-min price change at entry
  pairCreatedAt?: number;   // unix ms when pair was created
}) {
  try {
    if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });
    const line = JSON.stringify({ ...record, ts: Date.now() }) + '\n';
    fs.appendFileSync(JOURNAL_FILE, line, 'utf-8');
  } catch { /* never crash on journal write */ }
}

// Load TA signal for a mint (soft gate — doesn't block if no data)
function loadSignal(mint: string): { signal: string; confidence: number; reasons: string[] } | null {
  try {
    if (!fs.existsSync(STRATEGY_FILE)) return null;
    const s = JSON.parse(fs.readFileSync(STRATEGY_FILE, 'utf-8'));
    const age = Date.now() - (s.updatedAt || 0);
    if (age > 3 * 60_000) return null; // stale after 3min
    return s.signals?.[mint] || null;
  } catch { return null; }
}

// ── Types ────────────────────────────────────────────────────────────────────
interface Position {
  mint:           string;
  ata:            string;   // Associated Token Account
  symbol:         string;
  buyPriceSol:    number;
  tokenAmount:    number;
  openedAt:       number;
  entryPriceSol:  number;
  signature:      string;
  tpPct:          number;
  slPct:          number;
  peakPnlPct:     number;   // trailing stop: tracks highest PnL seen
  entryBuyRatio?: number;   // buy/sell ratio at entry — used for order flow reversal detection
  entryMetrics?:  EntryMetrics; // for adaptive scorer
}

interface PositionStore {
  positions: Position[];
  blacklist: string[];       // mints to never snipe again
  recentExits: Record<string, number>; // mint → exit timestamp (persisted cooldown)
  stats: {
    wins: number;
    losses: number;
    totalPnlSol: number;
  };
}

// ── State ────────────────────────────────────────────────────────────────────
let store: PositionStore = { positions: [], blacklist: [], recentExits: {}, stats: { wins: 0, losses: 0, totalPnlSol: 0 } };
const REENTRY_COOLDOWN_MS = 10 * 60_000; // 10 min cooldown after exit (survives restart)
let exitCheckRunning = false; // prevent concurrent checkExits calls
const otherBotPositions = new Set<string>(); // mints held by other bots (Artemis)
loadStore();

// Cross-bot position deconfliction via Redis
async function initPositionSharing() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;
  try {
    const Redis = (await import('ioredis')).default;
    const sub = new Redis(redisUrl, { retryStrategy: (t: number) => Math.min(t * 1000, 10000) });
    sub.subscribe('velocity:positions', (err: any) => {
      if (err) console.error('[POSITIONS] Redis subscribe error:', err.message);
      else console.log('[POSITIONS] Subscribed to velocity:positions — cross-bot deconfliction active');
    });
    sub.on('message', (_ch: string, msg: string) => {
      try {
        const data = JSON.parse(msg);
        if (data.bot === 'pcp') return; // ignore our own
        if (data.action === 'enter') {
          otherBotPositions.add(data.mint);
          console.log(`[POSITIONS] ${data.bot} entered ${data.mint.slice(0,8)} — blocking`);
        } else if (data.action === 'exit') {
          otherBotPositions.delete(data.mint);
          console.log(`[POSITIONS] ${data.bot} exited ${data.mint.slice(0,8)} — unblocking`);
        }
      } catch { /* ignore */ }
    });
  } catch { /* non-fatal */ }
}

async function publishPosition(mint: string, action: 'enter' | 'exit') {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;
  try {
    const Redis = (await import('ioredis')).default;
    const redis = new Redis(redisUrl, { lazyConnect: true });
    await redis.connect();
    await redis.publish('velocity:positions', JSON.stringify({
      bot: 'pcp', mint, action, timestamp: Date.now(),
    }));
    await redis.disconnect();
  } catch { /* non-fatal */ }
}

async function loadStoreFromRedis() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;
  try {
    const Redis = (await import('ioredis')).default;
    const redis = new Redis(redisUrl, { lazyConnect: true });
    await redis.connect();
    const data = await redis.get('sniper:store');
    await redis.disconnect();
    if (data) {
      const raw = JSON.parse(data);
      store = {
        positions: [], // don't restore positions across deploys
        blacklist: raw.blacklist || [],
        recentExits: raw.recentExits || {},
        stats: raw.stats || { wins: 0, losses: 0, totalPnlSol: 0 },
      };
      console.log(`[STORE] Loaded from Redis: W${store.stats.wins}/L${store.stats.losses} PnL:${store.stats.totalPnlSol.toFixed(4)} SOL`);
    }
  } catch { /* fallback to file */ }
}

function loadStore() {
  try {
    if (fs.existsSync(SNIPER_LOG)) {
      const raw = JSON.parse(fs.readFileSync(SNIPER_LOG, 'utf-8'));
      store = {
        positions: raw.positions || [],
        blacklist: raw.blacklist || [],
        recentExits: raw.recentExits || {},
        stats: raw.stats || { wins: 0, losses: 0, totalPnlSol: 0 },
      };
    }
  } catch { /* start fresh */ }

  // Redis overrides file (has the latest lifetime stats)
  loadStoreFromRedis().then(() => {
    if (process.env.RESET_STATS === 'true') {
      store.stats = { wins: 0, losses: 0, totalPnlSol: 0 };
      store.blacklist = [];
      store.recentExits = {};
      console.log('[STORE] Stats reset via RESET_STATS=true');
    }
    console.log(`[STORE] Lifetime: W${store.stats.wins}/L${store.stats.losses} PnL:${store.stats.totalPnlSol.toFixed(4)} SOL`);
    saveStore();
  }).catch(() => {});
}

function saveStore() {
  try {
    fs.writeFileSync(SNIPER_LOG, JSON.stringify(store, null, 2));
  } catch { /* non-fatal */ }
  // Persist to Redis for lifetime stats across deploys
  saveStoreToRedis().catch(() => {});
}

async function saveStoreToRedis() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return;
  try {
    const Redis = (await import('ioredis')).default;
    const redis = new Redis(redisUrl, { lazyConnect: true });
    await redis.connect();
    await redis.set('sniper:store', JSON.stringify(store));
    await redis.disconnect();
  } catch { /* non-fatal */ }
}

// ── Jupiter helpers ───────────────────────────────────────────────────────────
async function jupFetch(path: string, opts: RequestInit = {}): Promise<any> {
  const url = `${JUP_BASE}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-api-key': JUP_KEY, ...opts.headers },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[JUP] HTTP ${res.status}: ${body.slice(0, 200)} | URL: ${url.slice(0, 120)}`);
    return { error: `HTTP ${res.status}` };
  }
  return res.json();
}

async function getQuote(inputMint: string, outputMint: string, amountLamports: number): Promise<any | null> {
  try {
    const url = `/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=1000`;
    const q = await jupFetch(url);
    if (q.error) {
      console.error(`[QUOTE] Jupiter error: ${JSON.stringify(q.error).slice(0, 200)} | ${inputMint.slice(0,8)}→${outputMint.slice(0,8)} amt=${amountLamports}`);
      return null;
    }
    if (!q.outAmount) {
      console.error(`[QUOTE] No outAmount in response: ${JSON.stringify(q).slice(0, 300)}`);
      return null;
    }
    return q;
  } catch (e: any) {
    console.error(`[QUOTE] Fetch failed: ${e.message} | ${inputMint.slice(0,8)}→${outputMint.slice(0,8)}`);
    return null;
  }
}

async function executeSwap(quote: any, tipLamports = 25000): Promise<string | null> {
  if (PAPER_MODE) {
    const fakeSig = `PAPER_${Date.now().toString(36)}`;
    console.log(`[PAPER] Simulated swap: ${fakeSig}`);
    return fakeSig;
  }
  try {
    const swapData = await jupFetch('/swap', {
      method: 'POST',
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: false,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: tipLamports,
      }),
    });
    if (!swapData.swapTransaction) return null;

    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx    = VersionedTransaction.deserialize(txBuf);
    tx.sign([wallet]);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true, maxRetries: 3,
    });
    console.log(`[SNIPER] TX submitted: ${sig}`);
    return sig;
  } catch (e: any) {
    console.error('[SNIPER] Swap failed:', e.message);
    return null;
  }
}

async function getCurrentPriceSol(mint: string, tokenLamports: number): Promise<number | null> {
  // 1. Bonding curve price (for pump.fun tokens still on curve)
  // Try bonding curve price first (works for any pump.fun token, not just ones ending in "pump")
  {
    const curveVal = await getCurveValueSol(mint, BigInt(tokenLamports));
    if (curveVal !== null) return curveVal;
  }
  // 2. Redis pool state — instant, no API call
  if (poolState?.isConnected()) {
    const est = poolState.estimateSellSol(mint, BigInt(tokenLamports));
    if (est !== null) return est;
  }
  // 3. Jupiter quote — slowest fallback
  const q = await getQuote(mint, WSOL, tokenLamports);
  if (!q) return null;
  return Number(q.outAmount) / 1e9;
}

// ── Dynamic TP/SL — small-win compounding mode ───────────────────────────────
// Take quick gains, recycle capital. Pennies compound into dollars.
// Entry already moved a lot? Take even less — just clip the tail.
function calcExitTargets(_priceChg1h: number): { tp: number; sl: number } {
  // Fixed scalping targets:
  // -10% hard SL, +30% full TP
  // Dynamic SL + trail handled in checkExits
  return { tp: 30, sl: 10 };
}

// ── Dynamic buy size: WSOL balance % × harmony allocation weight ──────────────
// Reads from persistent WSOL ATA — no wrap/unwrap needed on trade execution.
async function calcBuySize(): Promise<number> {
  if (PAPER_MODE) {
    const bal = PAPER_BALANCE;
    const size = Math.min(MAX_BUY_SOL, Math.max(MIN_BUY_SOL, bal * BASE_BUY_PCT));
    return size;
  }
  try {
    const wsolBal = await getWsolBalance(connection, wallet.publicKey);
    const bal = wsolBal > 0 ? wsolBal : (await connection.getBalance(wallet.publicKey)) / 1e9;
    const raw      = bal * BASE_BUY_PCT;
    const weight   = loadSniperWeight();
    const weighted = raw * weight;
    const size     = Math.min(MAX_BUY_SOL, Math.max(MIN_BUY_SOL, parseFloat(weighted.toFixed(4))));
    if (weight < 1.0) console.log(`[SNIPER] Harmony weight: ${(weight*100).toFixed(0)}% -> buy: ${size} SOL`);
    if (wsolBal > 0) console.log(`[SNIPER] WSOL balance: ${wsolBal.toFixed(4)} | sizing: ${size} SOL`);
    return size;
  } catch { return MIN_BUY_SOL; }
}

async function trySnipe(mint: string, symbol: string, volume1h: number, priceChg1h: number,
                        buys1h: number, sells1h: number, buyRatio: number,
                        taSig?: string, taConf?: number,
                        tokenAgeSec?: number, momentum5m?: number, momentum1m?: number,
                        pairCreatedAt?: number) {
  if (store.blacklist.includes(mint)) return;
  if (store.positions.find(p => p.mint === mint)) return;
  if (store.positions.length >= MAX_POSITIONS) return;

  // Cross-bot deconfliction — don't enter mints another bot is holding
  if (otherBotPositions.has(mint)) return;

  // Cooldown — don't re-enter a mint we just exited (persists across restarts)
  const lastExit = store.recentExits[mint];
  if (lastExit && Date.now() - lastExit < REENTRY_COOLDOWN_MS) {
    return;
  }

  // Edge filter: buy pressure must dominate
  if (buyRatio < MIN_BUY_RATIO) {
    console.log(`[SNIPER] ⏭️  ${symbol} skipped — buy ratio ${buyRatio.toFixed(1)}x < ${MIN_BUY_RATIO}x (${buys1h}B/${sells1h}S)`);
    return;
  }
  if (buys1h < MIN_BUYS_1H) {
    console.log(`[SNIPER] ⏭️  ${symbol} skipped — only ${buys1h} buys in 1h (min ${MIN_BUYS_1H})`);
    return;
  }

  // ── Real-time velocity gate (pcp-velocity gRPC stream) ───────────────────
  // Supersedes DexScreener 5m lag with live 60s rolling swap counts.
  // If pcp-velocity is running, require minimum live buy pressure.
  const vel = loadVelocity(mint);
  if (vel) {
    const MIN_VEL_BUYS   = 3;    // at least 3 buys in last 60s
    const MIN_VEL_RATIO  = 0.55; // buys must be >55% of swaps
    if (vel.buys60s < MIN_VEL_BUYS) {
      console.log(`[SNIPER] ⚡ ${symbol} VELOCITY SKIP — only ${vel.buys60s} buys/60s (min ${MIN_VEL_BUYS}) | vel:${vel.velocity.toFixed(0)}txpm`);
      return;
    }
    if (vel.buyRatio60s < MIN_VEL_RATIO) {
      console.log(`[SNIPER] ⚡ ${symbol} VELOCITY SKIP — buy ratio ${(vel.buyRatio60s*100).toFixed(0)}% <${MIN_VEL_RATIO*100}% | ${vel.buys60s}B/${vel.sells60s}S`);
      return;
    }
    const accTag = vel.isAccelerating ? ' 🚀 ACCELERATING' : '';
    console.log(`[SNIPER] ⚡ VELOCITY ${symbol}: ${vel.buys60s}B/${vel.sells60s}S (${(vel.buyRatio60s*100).toFixed(0)}%) | ${vel.velocity.toFixed(0)}tx/min | ${vel.solVolume60s.toFixed(3)} SOL/60s${accTag}`);
  } else {
    console.log(`[SNIPER] ℹ️  ${symbol} — velocity.json not available, using DexScreener 5m data`);
  }

  // ── Adaptive scoring gate ─────────────────────────────────────────────────
  const entryMetrics: EntryMetrics = {
    volume1h,
    priceChange1h: priceChg1h,
    momentum5m: momentum5m ?? 0,
    buyRatio,
    buys1h,
    liquidity: 0,
    mcap: 0,
    tokenAgeSec: tokenAgeSec ?? 9999,
    velocityScore: vel ? vel.buys60s * vel.buyRatio60s : 0,
    detectionSource: vel?.isAccelerating ? 2 : vel ? 1 : 0, // 0=dexscreener, 1=velocity, 2=accel
    source: vel?.isAccelerating ? 'velocity-first' : 'dexscreener',
  };

  // Log detection with full context
  const tradeId = logDetection({
    mint, symbol,
    source: vel?.isAccelerating ? 'velocity-first' : 'dexscreener',
    velocity: vel ? { buys60s: vel.buys60s, sells60s: vel.sells60s, buyRatio60s: vel.buyRatio60s, velocity: vel.velocity, isAccelerating: vel.isAccelerating, solVolume60s: vel.solVolume60s } : null,
    dexscreener: { volume1h, priceChange1h: priceChg1h, priceChange5m: momentum5m ?? null, priceChange1m: momentum1m ?? null, buys1h, sells1h, buyRatio, liquidity: 0, mcap: 0, tokenAgeSec: tokenAgeSec ?? null, dexCount: 1 },
  });

  const scoring = scoreCandidate(entryMetrics);
  logScoring(tradeId, { adaptiveScore: scoring.score, confidence: scoring.confidence, reasons: scoring.reasons, shouldEnter: scoring.shouldEnter, threshold: 0, featureBreakdown: {} });
  console.log(`[SCORER] ${symbol}: score=${(scoring.score * 100).toFixed(0)}% [${scoring.confidence}] ${scoring.reasons.join(' | ')}`);
  if (!scoring.shouldEnter) {
    console.log(`[SNIPER] ⏭️  ${symbol} — adaptive scorer rejected (${(scoring.score * 100).toFixed(0)}% < ${scoring.reasons.find(r => r.includes('threshold')) || 'threshold'})`);
    // Shadow track — check this token's price in 5min to learn from missed opportunities
    recordShadowCandidate(mint, symbol, entryMetrics, scoring.score);
    return;
  }

  const buySol     = await calcBuySize();
  const buyLamports = Math.floor(buySol * 1e9);
  const ageTag = tokenAgeSec ? ` | age:${(tokenAgeSec/60).toFixed(0)}min` : '';

  // Try bonding curve first (for fresh pump.fun tokens), fallback to Jupiter
  let tokenAmount = 0;
  let sig = '';
  let ata = '';
  let curveProgress = 0;

  const onCurve = await isOnBondingCurve(mint);

  if (onCurve) {
    // BONDING CURVE BUY
    const curveState = await getBondingCurveState(mint);
    const curveQuote = curveState ? quoteTokensForSol(curveState, BigInt(buyLamports)) : null;
    if (!curveQuote || curveQuote.tokensOut === 0n) {
      console.log(`[SNIPER] ❌ Bonding curve quote failed for ${symbol}`);
      return;
    }
    tokenAmount = Number(curveQuote.tokensOut);
    curveProgress = curveQuote.curveProgress;

    if (PAPER_MODE) {
      sig = `PAPER_PUMP_${Date.now().toString(36)}`;
    } else {
      const maxSol = BigInt(Math.floor(buyLamports * 1.10));
      const liveSig = await liveBuyOnCurve(connection, wallet, mint, curveQuote.tokensOut, maxSol);
      if (!liveSig) { console.log(`[SNIPER] ❌ Live curve buy failed for ${symbol}`); return; }
      sig = liveSig;
    }
    console.log(`[SNIPER] 🎯 CURVE BUY ${symbol} | curve:${curveProgress.toFixed(0)}% | ${buySol} SOL → ${(tokenAmount/1e6).toFixed(0)}M tokens${ageTag} | score:${(scoring.score * 100).toFixed(0)}%`);
  } else {
    // JUPITER BUY — graduated token
    console.log(`[SNIPER] 🎯 Sniping ${symbol} | +${priceChg1h.toFixed(0)}%/1h | $${(volume1h/1000).toFixed(1)}k vol | ${buys1h}B/${sells1h}S (${buyRatio.toFixed(1)}x) | size: ${buySol} SOL${ageTag} | score:${(scoring.score * 100).toFixed(0)}%`);
    const quote = await getQuote(WSOL, mint, buyLamports);
    if (!quote) {
      console.log(`[SNIPER] ❌ No Jupiter quote for ${symbol} — skipping`);
      return;
    }
    tokenAmount = Number(quote.outAmount);
    sig = await executeSwap(quote, 30000) || '';
    if (!sig) return;
  }

  const entryPriceSol = buySol / tokenAmount;

  try {
    const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
    ata = getAssociatedTokenAddressSync(new PublicKey(mint), wallet.publicKey).toBase58();
  } catch { ata = 'unknown'; }

  appendTrade({ agent: 'pcp-sniper', action: 'BUY', mint, symbol, amountSol: buySol, sig,
    reason: `${onCurve ? 'curve:'+curveProgress.toFixed(0)+'%' : priceChg1h.toFixed(0)+'%/1h'} ${buys1h}B/${sells1h}S`, taSig, taConf,
    tokenAgeSec, momentum5m, momentum1m, pairCreatedAt, ata } as any);

  const { tp: tpPct, sl: slPct } = calcExitTargets(priceChg1h);
  const pos: Position = {
    mint, ata, symbol, buyPriceSol: buySol, tokenAmount,
    openedAt: Date.now(), entryPriceSol, signature: sig,
    tpPct, slPct, peakPnlPct: 0,
    entryBuyRatio: buyRatio,
    entryMetrics,
  };
  store.positions.push(pos);
  saveStore();
  publishPosition(mint, 'enter');

  logEntry(tradeId, {
    executedAt: Date.now(), buySizeSol: buySol, tokenAmount, entryPriceSol,
    tpPct, slPct,
  });

  console.log(`[SNIPER] Entered ${symbol}: ${buySol} SOL -> ${tokenAmount} tokens`);
  console.log(`[SNIPER] TP: +${tpPct}% | SL: -${slPct}% | hold<=${MAX_HOLD_MS/60000}min | entry was +${priceChg1h.toFixed(0)}%/1h | orderflow: ${buys1h}B/${sells1h}S (${buyRatio.toFixed(1)}x)`);

  // Telegram alert
  const tag = PAPER_MODE ? '[PAPER]' : '[LIVE]';
  await sendTelegram(
    `${tag} <b>BUY ${symbol}</b>\n` +
    `Size: ${buySol} SOL\n` +
    `1h: +${priceChg1h.toFixed(0)}% | Vol: $${(volume1h||0).toLocaleString()}\n` +
    `Buys/Sells: ${buys1h}/${sells1h} (${buyRatio.toFixed(1)}x)\n` +
    `TP: +${tpPct}% | SL: -${slPct}%\n` +
    `<a href="https://dexscreener.com/solana/${mint}">DexScreener</a>`
  );
}

// ── Exit logic ────────────────────────────────────────────────────────────────
async function checkExits() {
  const now   = Date.now();
  const exits: Position[] = [];

  for (const pos of store.positions) {
    const heldMs    = now - pos.openedAt;
    const forceExit = heldMs > MAX_HOLD_MS; // 30min hard cap
    const inRetrace = heldMs < RETRACE_SHIELD_MS;

    const curValueSol = await getCurrentPriceSol(pos.mint, pos.tokenAmount);
    if (!curValueSol && !forceExit) continue;

    const pnlPct = curValueSol
      ? ((curValueSol - pos.buyPriceSol) / pos.buyPriceSol) * 100
      : -100;

    // Log price check + velocity snapshot for analytics
    logPriceCheck(pos.mint, pnlPct);
    const velSnap = loadVelocity(pos.mint);
    if (velSnap) logVelocitySnapshot(pos.mint, { buys60s: velSnap.buys60s, sells60s: velSnap.sells60s, buyRatio60s: velSnap.buyRatio60s });

    // Stale exit: no price movement = dead token or illiquid
    // In profit + stale for 30s → take it NOW (bonding curve = no activity = about to dump)
    // In loss + stale for 60s → cut and move on
    const staleExit = pnlPct > 1
      ? (heldMs > 30_000 && Math.abs(pnlPct - (pos.peakPnlPct || 0)) < 0.5)
      : (heldMs > 60_000 && Math.abs(pnlPct) < 2);

    // Update peak profit for trailing stop
    if (pnlPct > (pos.peakPnlPct || 0)) pos.peakPnlPct = pnlPct;
    const peak = pos.peakPnlPct || 0;

    // ═══════════════════════════════════════════════════════════════════════
    // THREE-PHASE EXIT SYSTEM
    //
    // Phase 1 (0% to +5%):  Hard SL at -10%. No trail. Cut fast if wrong.
    // Phase 2 (+5% to +15%): SL moves to 0% (breakeven). Lock in no-loss.
    // Phase 3 (+15%+):       Trail activates — 10% below peak. TP at +30%.
    // ═══════════════════════════════════════════════════════════════════════

    const HARD_SL = 10;        // Phase 1: -10% stop loss
    const BREAKEVEN_TRIGGER = 5;  // Phase 2: at +5%, SL moves to 0%
    const TRAIL_TRIGGER = 15;     // Phase 3: at +15%, trailing stop activates
    const TRAIL_DISTANCE = 10;    // Phase 3: trail 10% below peak
    const FULL_TP = 30;           // +30% full take profit

    let activeSl: number;
    let trail = false;
    let trailFloor = 0;

    if (peak >= TRAIL_TRIGGER) {
      // Phase 3: trailing stop — 10% below peak
      activeSl = HARD_SL; // fallback
      trailFloor = peak - TRAIL_DISTANCE;
      trail = pnlPct <= trailFloor;
      if (!trail) logTrailActivation(pos.mint);
    } else if (peak >= BREAKEVEN_TRIGGER) {
      // Phase 2: SL at breakeven (0%)
      activeSl = 0;
    } else {
      // Phase 1: hard SL
      activeSl = HARD_SL;
    }

    const tp = pnlPct >= FULL_TP;
    const sl = pnlPct <= -activeSl;

    // Order flow reversal — early exit if sellers take over
    let orderFlowReversal = false;
    if (heldMs < 180_000 && pnlPct < 0 && !forceExit) {
      const vel = loadVelocity(pos.mint);
      if (vel && vel.buys60s + vel.sells60s >= 3) {
        const curRatio = vel.buyRatio60s;
        const entryRatio = (pos.entryBuyRatio || 0.6) / (1 + (pos.entryBuyRatio || 0.6));
        if (curRatio < 0.40 && curRatio < entryRatio * 0.65) {
          orderFlowReversal = true;
          logOrderFlowReversal(pos.mint);
          console.log(`[SNIPER] 🚨 ${pos.symbol} ORDER FLOW REVERSED — buy ratio ${(curRatio*100).toFixed(0)}% | PnL:${pnlPct.toFixed(1)}%`);
        }
      }
    }

    if (tp || sl || trail || orderFlowReversal || forceExit || staleExit) {
      const phaseStr = peak >= TRAIL_TRIGGER ? 'P3-TRAIL' : peak >= BREAKEVEN_TRIGGER ? 'P2-BE' : 'P1-SL';
      const reason = tp                ? `TP +${pnlPct.toFixed(1)}% (full sell)`
                   : trail             ? `TRAIL peak:+${peak.toFixed(1)}% → floor:+${trailFloor.toFixed(1)}% → now:${pnlPct.toFixed(1)}%`
                   : orderFlowReversal ? `ORDERFLOW-REVERSAL ${pnlPct.toFixed(1)}%`
                   : sl                ? `${phaseStr} SL ${pnlPct.toFixed(1)}%`
                   : staleExit         ? `STALE ${pnlPct.toFixed(1)}% (dead token)`
                   :                    `TIME ${(heldMs/60000).toFixed(1)}min`;
      console.log(`[SNIPER] 🔄 Exiting ${pos.symbol} — ${reason}`);

      // Try bonding curve sell first, then Jupiter
      let realizedSol = 0;
      let sellSig = '';
      const onCurve = await isOnBondingCurve(pos.mint);

      if (onCurve) {
        // Get sell quote from curve math
        const curveState = await getBondingCurveState(pos.mint);
        const solOut = curveState ? quoteSolForTokens(curveState, BigInt(pos.tokenAmount)) : null;
        if (solOut && solOut > 0n) {
          if (PAPER_MODE) {
            realizedSol = Number(solOut) / 1e9;
            sellSig = `PAPER_SELL_${Date.now().toString(36)}`;
          } else {
            // LIVE: submit sell transaction
            const minSolWithSlippage = solOut * 95n / 100n; // 5% slippage tolerance
            const liveSig = await liveSellOnCurve(connection, wallet, pos.mint, BigInt(pos.tokenAmount), minSolWithSlippage);
            if (liveSig) {
              realizedSol = Number(solOut) / 1e9;
              sellSig = liveSig;
            }
          }
          if (sellSig) console.log(`[SNIPER] CURVE SELL ${pos.symbol} → ${realizedSol.toFixed(4)} SOL`);
        }
      }

      if (!sellSig) {
        // Jupiter fallback for graduated tokens
        const sellQuote = await getQuote(pos.mint, WSOL, pos.tokenAmount);
        if (sellQuote) {
          const jupSig = await executeSwap(sellQuote, tp ? 5000 : sl ? 25000 : 10000);
          if (jupSig) {
            realizedSol = Number(sellQuote.outAmount) / 1e9;
            sellSig = jupSig;
          }
        }
      }

      if (sellSig) {
          const pnlSol = realizedSol - pos.buyPriceSol;
          const actualPnlPct = ((realizedSol - pos.buyPriceSol) / pos.buyPriceSol) * 100;
          const pnlPctFinal = actualPnlPct;
          const winLoss = pnlPctFinal >= 0 ? 'WIN' : 'LOSS';
          console.log(`[SNIPER] ${winLoss} ${pos.symbol} | PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPctFinal.toFixed(1)}%)`);
          appendTrade({ agent: 'pcp-sniper', action: 'SELL', mint: pos.mint, symbol: pos.symbol,
            amountSol: realizedSol, pnlSol, sig: sellSig, reason, holdMs: heldMs });
          store.stats.totalPnlSol += pnlSol;
          if (pnlPctFinal >= 0) store.stats.wins++; else store.stats.losses++;
          if (sl) store.blacklist.push(pos.mint);
          store.recentExits[pos.mint] = Date.now();

          // Record outcome for adaptive scorer + trade analytics
          if (pos.entryMetrics) {
            recordTradeOutcome(pos.mint, pos.symbol, pos.entryMetrics, pnlPctFinal, pnlSol, heldMs, reason);
          }
          const exitVel = loadVelocity(pos.mint);
          logExit(pos.mint, {
            reason, pnlPct: pnlPctFinal, pnlSol, holdMs: heldMs,
            exitPriceSol: curValueSol || 0,
            velocityAtExit: exitVel ? { buys60s: exitVel.buys60s, sells60s: exitVel.sells60s, buyRatio60s: exitVel.buyRatio60s } : null,
          });

          // Telegram exit alert
          const tag = PAPER_MODE ? '[PAPER]' : '[LIVE]';
          const icon = pnlPctFinal >= 0 ? '+++' : '---';
          const modelInfo = getModelSummary();
          const analyticsInfo = getAnalyticsSummary();
          const openTrade = getOpenTrade(pos.mint);
          const latencyStr = openTrade ? `Latency: ${openTrade.entry.signalToEntryMs}ms` : '';
          await sendTelegram(
            `${tag} <b>SELL ${pos.symbol}</b> ${icon}\n` +
            `PnL: ${pnlPctFinal >= 0 ? '+' : ''}${pnlPctFinal.toFixed(1)}% (${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL)\n` +
            `Peak: +${pos.peakPnlPct.toFixed(1)}% | Reason: ${reason}\n` +
            `Held: ${(heldMs/60000).toFixed(1)}min | ${latencyStr}\n` +
            `Session: W${store.stats.wins}/L${store.stats.losses} | ${store.stats.totalPnlSol >= 0 ? '+' : ''}${store.stats.totalPnlSol.toFixed(4)} SOL\n` +
            `\n<b>Analytics:</b> ${analyticsInfo}`
          );
      } else {
        console.warn(`[SNIPER] ⚠️  No sell quote for ${pos.symbol} (curve:${onCurve}) — holding`);
        continue;
      }
      exits.push(pos);
      publishPosition(pos.mint, 'exit');
    } else {
      const phase = peak >= TRAIL_TRIGGER ? `P3 trail:+${trailFloor.toFixed(0)}%`
                  : peak >= BREAKEVEN_TRIGGER ? 'P2 SL:0%'
                  : `P1 SL:-${HARD_SL}%`;
      console.log(`[SNIPER] 📊 ${pos.symbol} | PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% | peak:+${peak.toFixed(1)}% | ${phase} | ${(heldMs/60000).toFixed(1)}min`);
    }
  }

  store.positions = store.positions.filter(p => !exits.find(e => e.mint === p.mint));
  if (exits.length > 0) {
    saveStore();
    console.log(`[SNIPER] 📈 Session stats | Wins: ${store.stats.wins} | Losses: ${store.stats.losses} | PnL: ${store.stats.totalPnlSol >= 0 ? '+' : ''}${store.stats.totalPnlSol.toFixed(4)} SOL`);
  }
}

// ── Orphan recovery — sell wallet tokens not tracked in positions[] ────────────
// Uses 'finalized' commitment + both token programs to catch ALL holdings
const TOKEN_PROG    = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_PROG_22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const STABLE_MINTS  = new Set([
  'So11111111111111111111111111111111111111112',   // WSOL — our trading capital, never sell!
  'So11111111111111111111111111111111111111111',   // native SOL variant
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);


async function recoverOrphans() {
  try {
    const seen = new Map<string, {amount: string; uiAmount: number}>();

    // Scan both token programs with finalized commitment
    for (const prog of [TOKEN_PROG, TOKEN_PROG_22]) {
      try {
        const accts = await connection.getParsedTokenAccountsByOwner(
          wallet.publicKey, { programId: prog }, 'finalized'
        );
        for (const a of accts.value) {
          const info = a.account.data.parsed.info;
          if (info.tokenAmount.uiAmount > 0) seen.set(info.mint, info.tokenAmount);
        }
      } catch {}
    }

    // Also try backup RPC if PRIMARY missed any
    const backupRpc = process.env.RPC_ENDPOINT_2;
    if (backupRpc && seen.size === 0) {
      const { Connection: C } = await import('@solana/web3.js') as any;
      const backup = new C(backupRpc, 'finalized');
      for (const prog of [TOKEN_PROG, TOKEN_PROG_22]) {
        try {
          const accts = await backup.getParsedTokenAccountsByOwner(wallet.publicKey, { programId: prog });
          for (const a of accts.value) {
            const info = a.account.data.parsed.info;
            if (info.tokenAmount.uiAmount > 0) seen.set(info.mint, info.tokenAmount);
          }
        } catch {}
      }
    }

    for (const [mint, tokenAmount] of seen) {
      if (STABLE_MINTS.has(mint)) continue;
      if (store.positions.find(p => p.mint === mint)) continue; // already tracked

      console.log(`[SNIPER] 🔍 Orphan: ${mint.slice(0,12)}... (${tokenAmount.uiAmount}) — selling`);
      const q = await getQuote(mint, WSOL, Number(tokenAmount.amount));
      if (!q) { console.warn(`[SNIPER] ⚠️ No route for orphan ${mint.slice(0,12)}`); continue; }
      const sig = await executeSwap(q, 30000);
      if (sig) {
        const solOut = Number(q.outAmount) / 1e9;
        console.log(`[SNIPER] ♻️ Orphan sold → +${solOut.toFixed(5)} SOL`);
        appendTrade({ agent:'pcp-sniper', action:'SELL', mint, symbol:'ORPHAN',
          amountSol:solOut, sig, reason:'orphan-recovery' });
      }
    }
    if (seen.size > 0) console.log(`[SNIPER] Orphan scan complete (${seen.size} non-zero tokens found)`);
  } catch (e: any) { console.error('[SNIPER] Orphan recovery error:', e.message); }
}

async function poll() {
  // Check exits first (manage risk)
  // Exit check handled by the 1s interval — don't duplicate here

  try {
    // ══════════════════════════════════════════════════════════════════════
    // PATH 1: VELOCITY-FIRST DISCOVERY (pcp-velocity WebSocket stream)
    // ── Catch pumps BEFORE DexScreener shows them ─────────────────────────
    // Scans velocity.json for isAccelerating mints, cross-checks trending.json
    // for directional confirmation. This is the sub-2s early-entry path.
    // ══════════════════════════════════════════════════════════════════════
    const velMints = loadAllVelocityMints();
    const accelerating = velMints.filter(v =>
      v.isAccelerating &&
      v.buys60s >= 5 &&               // at least 5 buys in last 60s
      v.buyRatio60s >= 0.60 &&        // ≥60% of swaps are buys
      v.solVolume60s >= 0.001 &&      // at least 0.001 SOL traded — confirms real liquidity
      !store.blacklist.includes(v.mint) &&
      !store.positions.find(p => p.mint === v.mint)
    ).sort((a, b) => b.solVolume60s - a.solVolume60s);


    if (accelerating.length > 0 && store.positions.length < MAX_POSITIONS) {
      console.log(`[SNIPER] ⚡ VELOCITY-FIRST: ${accelerating.length} accelerating mint(s) detected`);

      // Load trending for cross-reference (1h direction confirmation)
      let trendingMap: Map<string, any> = new Map();
      if (fs.existsSync(TRENDING_FILE)) {
        try {
          const tRaw = JSON.parse(fs.readFileSync(TRENDING_FILE, 'utf-8'));
          (tRaw.mints as any[]).forEach(m => trendingMap.set(m.mint, m));
        } catch {}
      }

      for (const v of accelerating.slice(0, 5)) {
        if (store.positions.length >= MAX_POSITIONS) break;
        const trending = trendingMap.get(v.mint);

        // Cross-check: if in trending, confirm 1h direction is positive
        if (trending && trending.priceChange1h < 0) {
          console.log(`[SNIPER] ⚡ ${trending.symbol || v.mint.slice(0,8)} — velocity accelerating but 1h negative (${trending.priceChange1h.toFixed(0)}%) — skip`);
          continue;
        }

        const symbol   = trending?.symbol   || v.mint.slice(0, 8) + '...';
        const vol1h    = trending?.volume1h  || v.solVolume60s * 60; // estimate from 60s SOL vol
        const pc1h     = trending?.priceChange1h ?? 0;
        const buys1h   = trending?.buys1h    || v.buys60s * 60;
        const sells1h  = trending?.sells1h   || v.sells60s * 60;
        const buyRatio = trending?.buyRatio   || v.buyRatio60s / (1 - v.buyRatio60s + 0.001);

        console.log(`[SNIPER] ⚡🚀 VELOCITY ENTRY: ${symbol} | ${v.buys60s}B/${v.sells60s}S (${(v.buyRatio60s*100).toFixed(0)}%) | ${v.velocity.toFixed(0)}tx/min | ${v.solVolume60s.toFixed(3)} SOL/60s | 1h:${pc1h >= 0 ? '+' : ''}${pc1h.toFixed(0)}%`);

        // TA soft gate
        const ta = loadSignal(v.mint);
        if (ta?.signal === 'SELL' && ta.confidence > 0.65) {
          console.log(`[SNIPER] ⛔ TA says SELL on ${symbol} — skip`);
          continue;
        }

        const createdAt   = trending?.pairCreatedAt ?? trending?.createdAt ?? undefined;
        const tokenAgeSec = createdAt ? Math.floor((Date.now() - createdAt) / 1000) : undefined;
        const mom5m       = trending?.priceChange5m ?? undefined;
        const mom1m       = trending?.priceChange1m ?? undefined;

        await trySnipe(v.mint, symbol, vol1h, pc1h,
                       buys1h, sells1h, buyRatio,
                       ta?.signal, ta?.confidence,
                       tokenAgeSec, mom5m, mom1m, createdAt);
      }

      // If we entered via velocity, skip DexScreener path this cycle
      if (store.positions.length >= MAX_POSITIONS) return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // PATH 2: DEXSCREENER TRENDING FALLBACK
    // ── Use when velocity has no accelerating candidates ──────────────────
    // ══════════════════════════════════════════════════════════════════════
    if (!fs.existsSync(TRENDING_FILE)) {
      console.log('[SNIPER] No trending.json yet — waiting for trending_injector...');
      return;
    }
    const raw = JSON.parse(fs.readFileSync(TRENDING_FILE, 'utf-8'));
    const tAge = Date.now() - (raw.updatedAt || 0);
    if (tAge > 5 * 60_000) {
      console.log('[SNIPER] Trending signal stale (>5min)');
      return;
    }

    const candidates = (raw.mints as any[]).filter(m => {
      const vol1h = m.volume1h || m.volume24h / 24;
      if (vol1h < MIN_VOLUME_1H) { return false; }
      if (store.blacklist.includes(m.mint)) { return false; }
      if ((m.buyRatio || 0) < MIN_BUY_RATIO) { return false; }
      if (store.positions.find(p => p.mint === m.mint)) { return false; }
      // Cooldown check
      const lastExit = store.recentExits[m.mint];
      if (lastExit && Date.now() - lastExit < REENTRY_COOLDOWN_MS) { return false; }

      // Momentum check — use 1m if available (freshest), fallback to 5m
      const mom1m = m.priceChange1m ?? m.priceChange1Min ?? null;
      const mom5m = m.priceChange5m ?? m.priceChange5Min ?? null;

      // 1m override: if 1m is strongly positive, allow even if 5m is negative (fresh bounce)
      if (mom1m !== null && mom1m >= 3) {
        // Fresh momentum — let it through regardless of 5m
      } else if (mom5m !== null && mom5m < MIN_MOMENTUM_5M) {
        // Check velocity as a second override — real-time buy pressure trumps stale 5m
        const vel = loadVelocity(m.mint);
        if (vel && vel.isAccelerating && vel.buys60s >= 5 && vel.buyRatio60s >= 0.65) {
          console.log(`[SNIPER] ⚡ ${m.symbol} — 5m stale (${mom5m.toFixed(1)}%) but velocity HOT: ${vel.buys60s}B/${vel.sells60s}S ${vel.velocity.toFixed(0)}tx/min — allowing`);
        } else {
          const tag1m = mom1m !== null ? ` | 1m:${mom1m.toFixed(1)}%` : '';
          console.log(`[SNIPER] ⏭️  ${m.symbol} — 5m momentum ${mom5m.toFixed(1)}% < ${MIN_MOMENTUM_5M}%${tag1m} (move peaked)`);
          return false;
        }
      }

      // DexScreener path: allow up to 60min (DexScreener lags, tokens are already older)
      // Velocity-first path has the strict 10min gate in velocitySnipe()
      const MAX_AGE_DEXSCREENER = parseInt(process.env.SNIPER_MAX_AGE_DEX_SECS || '3600'); // 60 min
      const createdAt = m.pairCreatedAt ?? m.createdAt ?? null;
      if (createdAt) {
        m._ageMin = (Date.now() - createdAt) / 60_000;
        const ageSec = m._ageMin * 60;
        if (ageSec > MAX_AGE_DEXSCREENER) {
          return false;
        }
      }

      return true;
    });

    if (candidates.length === 0) {
      const accCount = accelerating.length;
      const velMsg   = accCount > 0 ? ` (${accCount} vel mints not qualifying)` : '';
      console.log(`[SNIPER] No qualifying candidates (vol>$${MIN_VOLUME_1H/1000}k + chg>+${MIN_PRICE_CHG_1H}% + 5m>+${MIN_MOMENTUM_5M}%)${velMsg}`);
      return;
    }

    // Sort: 1m momentum first if available (freshest signal), then 5m, then 1h
    candidates.sort((a: any, b: any) => {
      const a1m = a.priceChange1m ?? a.priceChange5m ?? a.priceChange1h ?? 0;
      const b1m = b.priceChange1m ?? b.priceChange5m ?? b.priceChange1h ?? 0;
      return b1m - a1m; // highest recent momentum first
    });

    console.log(`[SNIPER] ${candidates.length} DexScreener candidate(s) | Positions: ${store.positions.length}/${MAX_POSITIONS}`);
    candidates.slice(0, 3).forEach((m: any) => {
      const vol1h = m.volume1h || m.volume24h / 24;
      const tag1m = m.priceChange1m != null ? ` 1m:${m.priceChange1m > 0 ? '+' : ''}${m.priceChange1m.toFixed(1)}%` : '';
      console.log(`  → ${m.symbol}: +${m.priceChange1h?.toFixed(0)}%/1h${tag1m} | ${m.buys1h || '?'}B/${m.sells1h || '?'}S (${(m.buyRatio || 0).toFixed(1)}x) | $${(vol1h/1000).toFixed(1)}k`);
    });

    const top   = candidates[0];
    const vol1h = top.volume1h || top.volume24h / 24;
    const ta    = loadSignal(top.mint);
    if (ta) {
      const icon = ta.signal === 'BUY' ? '📈' : ta.signal === 'SELL' ? '📉' : '➡️';
      console.log(`[SNIPER] ${icon} TA on ${top.symbol}: ${ta.signal} (${(ta.confidence*100).toFixed(0)}%) — ${ta.reasons.slice(0, 2).join(', ')}`);
      if (ta.signal === 'SELL' && ta.confidence > 0.65) {
        console.log('[SNIPER] ⛔ TA says SELL — skipping entry');
        return;
      }
    }

    const createdAt   = top.pairCreatedAt ?? top.createdAt ?? undefined;
    const tokenAgeSec = createdAt ? Math.floor((Date.now() - createdAt) / 1000) : undefined;
    const mom5m       = top.priceChange5m ?? top.priceChange5Min ?? undefined;
    const mom1m       = top.priceChange1m ?? top.priceChange1Min ?? undefined;

    await trySnipe(top.mint, top.symbol, vol1h, top.priceChange1h,
                   top.buys1h || 0, top.sells1h || 0, top.buyRatio || 1,
                   ta?.signal, ta?.confidence,
                   tokenAgeSec, mom5m, mom1m, createdAt);

  } catch (e: any) {
    console.error('[SNIPER] Poll error:', e.message);
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main() {
  const mode = PAPER_MODE ? 'PAPER' : 'LIVE';
  console.log(`=== PCP MOMENTUM SNIPER v1.1 [${mode}] ===`);
  console.log(`Buy: ${MIN_BUY_SOL}-${MAX_BUY_SOL} SOL | TP/SL: tiered`);
  console.log(`Max positions: ${MAX_POSITIONS} | Hold: ${MAX_HOLD_MS/60000}min max`);
  console.log(`TG: token=${TG_TOKEN ? 'set' : 'MISSING'} chat=${TG_CHAT || 'MISSING'}`);
  if (PAPER_MODE) {
    console.log(`Paper balance: ${PAPER_BALANCE} SOL (simulated)`);
  }

  if (!PAPER_MODE) {
    // WSOL ATA initialization — only in live mode
    try {
      await ensureWsolAta(connection, wallet);
      const wsolBal = await getWsolBalance(connection, wallet.publicKey);
      if (wsolBal > 0) {
        console.log(`[SNIPER] WSOL trading balance: ${wsolBal.toFixed(4)} SOL`);
      } else {
        console.log('[SNIPER] WSOL ATA empty — auto-refill from native SOL on next poll');
        await autoRefillWsol(connection, wallet, MIN_BUY_SOL);
      }
    } catch (e: any) {
      console.warn('[SNIPER] WSOL init warning:', e.message, '— falling back to native SOL');
    }

    await recoverOrphans();
  }

  // ── Start in-process velocity tracker (eliminates file I/O latency) ──────
  // ── Start Redis pool state subscriber (Geyser → Redis → instant price checks)
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    poolState = new PoolStateSubscriber(redisUrl);
    await poolState.start();
  } else {
    console.log('[SNIPER] REDIS_URL not set — using Jupiter for all price checks');
  }

  // Mcap gates
  const MAX_MCAP = parseFloat(process.env.SNIPER_MAX_MCAP || '200000'); // $200k max — tighter to avoid established tokens
  const MIN_MCAP = parseFloat(process.env.SNIPER_MIN_MCAP || '1000');
  const MAX_AGE_SECS = parseInt(process.env.SNIPER_MAX_AGE_SECS || '600'); // 10 min max token age

  // Shared velocity→snipe handler (used by both newMint and accelerating callbacks)
  async function velocitySnipe(mint: string, velData: any, source: string) {
    if (store.positions.length >= MAX_POSITIONS) return;
    if (store.blacklist.includes(mint)) return;
    if (store.positions.find(p => p.mint === mint)) return;

    let symbol = mint.slice(0, 8) + '...';
    let mcap = 0;
    let tokenAgeSec = 9999;
    let buys1h = velData.buys60s * 60;
    let sells1h = velData.sells60s * 60;
    let buyRatio = velData.buyRatio60s / (1 - velData.buyRatio60s + 0.001);
    let vol1h = velData.solVolume60s * 60;

    // Fetch pump.fun metadata (instant — no DexScreener lag)
    try {
      const pumpRes = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(3000),
      });
      if (pumpRes.ok) {
        const d: any = await pumpRes.json();
        symbol = d.symbol || symbol;
        mcap = d.usd_market_cap || 0;
        if (d.created_timestamp) {
          tokenAgeSec = Math.floor((Date.now() - d.created_timestamp) / 1000);
        }
      }
    } catch { /* pump.fun API down */ }

    console.log(`[${source}] ${symbol} (${mint.slice(0,8)}) | mcap:$${(mcap/1000).toFixed(1)}k | age:${tokenAgeSec}s | ${velData.buys60s}B/${velData.sells60s}S (${(velData.buyRatio60s*100).toFixed(0)}%)`);

    // HARD GATES
    if (symbol.includes('...') || symbol.trim().length === 0) {
      console.log(`[${source}] ⏭️ ${mint.slice(0,8)} — no symbol resolved, skipping`);
      return;
    }
    if (mcap === 0) {
      console.log(`[${source}] ⏭️ ${symbol} — mcap $0, pump.fun API didn't return data`);
      return;
    }
    if (mcap > MAX_MCAP) {
      console.log(`[${source}] ⏭️ ${symbol} — mcap $${(mcap/1000).toFixed(0)}k too large`);
      return;
    }
    if (mcap > 0 && mcap < MIN_MCAP) {
      console.log(`[${source}] ⏭️ ${symbol} — mcap $${mcap.toFixed(0)} too small`);
      return;
    }
    // Age gate: use time since WE first saw activity, not pump.fun creation time
    // A token created 1hr ago but just now getting its first buys = fresh momentum signal
    const trackingAgeSec = velData.ageSec; // how long we've been tracking this mint
    const creationAgeSec = tokenAgeSec;
    // Block if BOTH are old (created long ago AND we've been tracking it long)
    // Allow if tracking age is fresh (just started getting buys) regardless of creation age
    if (trackingAgeSec > MAX_AGE_SECS && creationAgeSec > MAX_AGE_SECS * 6) {
      console.log(`[${source}] ⏭️ ${symbol} — tracked ${(trackingAgeSec/60).toFixed(0)}min + created ${(creationAgeSec/60).toFixed(0)}min ago — stale`);
      return;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // ENTRY QUALITY GATES — every gate addresses a specific loss pattern
    // ═══════════════════════════════════════════════════════════════════════

    // Gate 1: Must be on bonding curve (check all mints, not just ones ending in "pump")
    const onCurve = await isOnBondingCurve(mint);
    if (!onCurve) {
      console.log(`[${source}] ⏭️ ${symbol} — not on bonding curve`);
      return;
    }

    // Gate 3: Minimum buy pressure (matched to velocity tracker thresholds)
    const MIN_TRACKING_SECS = 10;
    if (velData.buys60s < 5 || velData.sells60s < 1 || velData.buyRatio60s < 0.55 || velData.ageSec < MIN_TRACKING_SECS) {
      console.log(`[${source}] ⏭️ ${symbol} — weak signal: ${velData.buys60s}B/${velData.sells60s}S ${(velData.buyRatio60s*100).toFixed(0)}% ${velData.ageSec}s`);
      return;
    }

    // Gate 4: Buy count — 5+ buys with 65%+ ratio already required by velocity tracker
    // The 30s observation window is the real quality filter
    // No additional count gate needed here

    // Gate 5: Minimum velocity — at least some activity (acceleration not required)
    if (velData.velocity < 3) {
      console.log(`[${source}] ⏭️ ${symbol} — velocity too low (${velData.velocity.toFixed(0)} tx/min)`);
      return;
    }

    // Gate 6: Curve position — sweet spot 5-60%
    const curveState = await getBondingCurveState(mint);
    if (!curveState) {
      console.log(`[${source}] ❌ Can't read curve state for ${symbol}`);
      return;
    }
    const MIN_CURVE_PCT = 5;
    const MAX_CURVE_PCT = 60;
    const realSolInCurve = Number(curveState.realSolReserves) / 1e9;
    const estCurvePct = Math.min(100, (realSolInCurve / 85) * 100);
    if (estCurvePct < MIN_CURVE_PCT) {
      console.log(`[${source}] ⏭️ ${symbol} — curve ${estCurvePct.toFixed(0)}% < ${MIN_CURVE_PCT}%`);
      return;
    }
    if (estCurvePct > MAX_CURVE_PCT) {
      console.log(`[${source}] ⏭️ ${symbol} — curve ${estCurvePct.toFixed(0)}% > ${MAX_CURVE_PCT}%`);
      return;
    }

    // Gate 7: Top holder concentration check via Helius RPC
    try {
      const conn = new (await import('@solana/web3.js')).Connection(RPC, 'confirmed');
      const mintPk = new (await import('@solana/web3.js')).PublicKey(mint);
      const largest = await conn.getTokenLargestAccounts(mintPk);
      if (largest.value.length > 0) {
        const totalSupply = largest.value.reduce((s, a) => s + (a.uiAmount || 0), 0);
        const topHolder = largest.value[0]?.uiAmount || 0;
        const topHolderPct = totalSupply > 0 ? (topHolder / totalSupply) * 100 : 0;
        if (topHolderPct > 50) {
          console.log(`[${source}] ⏭️ ${symbol} — top holder owns ${topHolderPct.toFixed(0)}% (rug risk)`);
          return;
        }
      }
    } catch { /* non-fatal — skip check if RPC fails */ }

    console.log(`[${source}] ✅ ALL GATES PASSED: ${symbol} | curve:${estCurvePct.toFixed(0)}% | ${velData.buys60s}B/${velData.sells60s}S | accel:${velData.isAccelerating}`);

    {
      const buySol = await calcBuySize();
      const buyLamports = Math.floor(buySol * 1e9);

      // Get quote first
      const curveQuote = quoteTokensForSol(curveState, BigInt(buyLamports));
      if (!curveQuote || curveQuote.tokensOut === 0n) {
        console.log(`[${source}] ❌ Bonding curve quote failed for ${symbol}`);
        return;
      }

      let sig: string;
      if (PAPER_MODE) {
        sig = `PAPER_PUMP_${Date.now().toString(36)}`;
      } else {
        // LIVE: build and submit on-chain transaction
        const maxSolWithSlippage = BigInt(Math.floor(buyLamports * 1.10)); // 15% slippage buffer for momentum tokens
        const liveSig = await liveBuyOnCurve(connection, wallet, mint, curveQuote.tokensOut, maxSolWithSlippage);
        if (!liveSig) {
          console.log(`[${source}] ❌ Live curve buy TX failed for ${symbol}`);
          return;
        }
        sig = liveSig;
      }

      const tokenAmount = Number(curveQuote.tokensOut);
      const entryPriceSol = buySol / tokenAmount;
      const { tp: tpPct, sl: slPct } = calcExitTargets(0);

      console.log(`[${source}] 🎯 CURVE BUY ${symbol} | curve:${estCurvePct.toFixed(0)}% | ${buySol} SOL → ${(tokenAmount/1e6).toFixed(0)}M tokens | ${velData.buys60s}B/${velData.sells60s}S`);

      const entryMetrics: EntryMetrics = {
        volume1h: vol1h, priceChange1h: 0, momentum5m: 0, buyRatio,
        buys1h, liquidity: 0, mcap, tokenAgeSec: tokenAgeSec ?? 9999,
        velocityScore: velData.buys60s * velData.buyRatio60s,
        detectionSource: source === 'NEW-MINT' ? 1 : 2,
        source,
      };

      const pos: Position = {
        mint, ata: 'curve', symbol, buyPriceSol: buySol, tokenAmount,
        openedAt: Date.now(), entryPriceSol, signature: sig,
        tpPct, slPct, peakPnlPct: 0, entryBuyRatio: buyRatio, entryMetrics,
      };
      store.positions.push(pos);
      saveStore();
      publishPosition(mint, 'enter');

      // Send Telegram FIRST before anything that might throw
      await sendTelegram(
        `${PAPER_MODE ? '[PAPER]' : '[LIVE]'} <b>CURVE BUY ${symbol}</b>\n` +
        `Size: ${buySol} SOL | Curve: ${estCurvePct.toFixed(0)}%\n` +
        `Buys: ${velData.buys60s}B/${velData.sells60s}S (${(velData.buyRatio60s*100).toFixed(0)}%)\n` +
        `Mcap: $${(mcap/1000).toFixed(1)}k | TP:+${tpPct}% SL:-${slPct}%\n` +
        `<a href="https://pump.fun/coin/${mint}">pump.fun</a>`
      );

      try {
        logEntry(logDetection({ mint, symbol, source: source as any, velocity: velData, dexscreener: null }), {
          executedAt: Date.now(), buySizeSol: buySol, tokenAmount, entryPriceSol, tpPct, slPct,
        });
      } catch (e: any) { console.error(`[ANALYTICS] logEntry error: ${e.message}`); }
      return;
    }

    // For non-curve tokens: use the scorer + Jupiter path
    await trySnipe(mint, symbol, vol1h, 0, buys1h, sells1h, buyRatio,
                   undefined, undefined, tokenAgeSec);
  }

  velocityTracker = new VelocityTracker(RPC);

  // PRIMARY: New mint detection — catches fresh pump.fun launches in seconds
  velocityTracker.onNewMint(async (mint, velData) => {
    await velocitySnipe(mint, velData, 'NEW-MINT');
  });

  // SECONDARY: Acceleration on known mints — re-entry on momentum resurgence
  // ACCEL re-entries disabled — data shows they consistently lose
  // Only NEW-MINT entries are profitable (catching the initial wave)
  // velocityTracker.onAccelerating(async (mint, velData) => {
  //   await velocitySnipe(mint, velData, 'ACCEL');
  // });
  velocityTracker.start();

  await sendTelegram(
    `PCP Sniper started [${mode}]\n` +
    `Balance: ${PAPER_MODE ? PAPER_BALANCE + ' SOL (sim)' : 'live wallet'}\n` +
    `Poll: ${POLL_MS/1000}s | Velocity: in-process (0ms latency)`
  );

  const doPoll = async () => {
    if (!PAPER_MODE) await autoRefillWsol(connection, wallet, MIN_BUY_SOL).catch(() => {});
    await poll();
  };

  // DexScreener poll DISABLED — data shows it only finds post-pump tokens that lose money
  // All profitable trades come from velocity NEW-MINT curve buys
  // await doPoll();
  // setInterval(doPoll, POLL_MS);
  console.log('[SNIPER] DexScreener poll disabled — curve-only mode');

  // Cross-bot position deconfliction
  await initPositionSharing();

  // Separate fast exit check loop — 1s interval for tight stop losses
  setInterval(async () => {
    if (store.positions.length > 0 && !exitCheckRunning) {
      exitCheckRunning = true;
      try { await checkExits(); } catch (e: any) {
        console.error('[EXIT] Check error:', e.message);
      } finally { exitCheckRunning = false; }
    }
  }, EXIT_CHECK_MS);

  // Shadow candidate checker — learns from missed opportunities every 30s
  setInterval(async () => {
    try { await checkShadowCandidates(JUP_KEY); } catch { /* non-fatal */ }
  }, 30_000);

  process.on('SIGTERM', () => {
    saveStore();
    if (velocityTracker) velocityTracker.stop();
    process.exit(0);
  });
}

main().catch(e => { console.error('[SNIPER] Fatal:', e); process.exit(1); });
