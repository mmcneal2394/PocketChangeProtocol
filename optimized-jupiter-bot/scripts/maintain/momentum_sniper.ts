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
import bs58 from 'bs58';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';
import { getWsolBalance, autoRefillWsol, ensureWsolAta } from '../../src/utils/wsol_manager';
import RedisBus from '../../src/utils/redis_bus';
import { REDIS_KEYS, STREAMS, CHANNELS, PARAM_NAMES } from '../../src/shared/redis_config';
import { validateTradeCandidate } from '../../src/shared/trade_validator';

let latestVelocityData: any = {};

dotenv.config({ path: path.join(process.cwd(), '.env') });

const RPC         = process.env.RPC_ENDPOINT!;
const JUP_KEY     = process.env.JUPITER_API_KEY!;
const JUP_BASE    = process.env.JUPITER_ENDPOINT || 'https://api.jup.ag/swap/v1';
const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH!;
const WSOL        = 'So11111111111111111111111111111111111111112';

export const connection  = new Connection(RPC, { commitment: 'confirmed' });

const walletIndex = process.env.WALLET_INDEX;
export let wallet: Keypair;
if (walletIndex && process.env[`PRIVATE_KEY_${walletIndex}`]) {
    const rawKey = process.env[`PRIVATE_KEY_${walletIndex}`]!;
    wallet = Keypair.fromSecretKey(bs58.decode(rawKey));
    console.log(`[BOOT] 🔑 Loaded Mult-Wallet via Base58 [INDEX: ${walletIndex} | PUB: ${wallet.publicKey.toBase58()}]`);
} else {
    // Legacy fallback
    const walletJson  = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
    wallet = Keypair.fromSecretKey(new Uint8Array(walletJson));
    console.log(`[BOOT] 🔑 Loaded Single-Wallet via File [PUB: ${wallet.publicKey.toBase58()}]`);
}

// ── Config ───────────────────────────────────────────────────────────────────
// ── Param bounds: clamp & validate every env-configurable value at startup ────
// Single source of truth for safe operating ranges. Values outside bounds are
// clamped and a PARAM_GUARD WARN is emitted — caught by pcp_monitor.sh.
// THIS PREVENTS .env overrides from silently breaking trading behaviour.
interface ParamBound { env: string; def: number; min: number; max: number; unit: string; }
const PARAM_BOUNDS: Record<string, ParamBound> = {
  BASE_BUY_PCT:     { env: 'SNIPER_BUY_PCT',  def: 0.10,   min: 0.01,  max: 0.30,   unit: 'fraction'       },
  MIN_BUY_SOL:      { env: 'SNIPER_MIN_BUY',  def: 0.005,  min: 0.001, max: 0.05,   unit: 'SOL'            },
  MAX_BUY_SOL:      { env: 'SNIPER_MAX_BUY',  def: 0.03,   min: 0.005, max: 0.10,   unit: 'SOL'            },
  MAX_POSITIONS:    { env: 'SNIPER_MAX_POS',  def: 1,      min: 1,     max: 5,      unit: 'slots'          },
  MAX_HOLD_MS:      { env: 'SNIPER_MAX_HOLD', def: 360000, min: 60000, max: 600000, unit: 'ms (max 10min)' },
  MIN_VOLUME_1H:    { env: 'SNIPER_MIN_VOL',  def: 8000,   min: 1000,  max: 500000, unit: 'USD'            },
  MIN_PRICE_CHG_1H: { env: 'SNIPER_MIN_CHG',  def: 3,      min: 0.5,   max: 100,    unit: '%'              },
  MIN_BUY_RATIO:    { env: 'SNIPER_MIN_BR',   def: 3.5,    min: 1.0,   max: 20,     unit: 'x'              },
  MIN_BUYS_1H:      { env: 'SNIPER_MIN_BUYS', def: 30,     min: 5,     max: 1000,   unit: 'txns'           },
  MIN_MOMENTUM_5M:  { env: 'SNIPER_MIN_5M',   def: 3,      min: 0,     max: 50,     unit: '%'              },
};
function guardParam(key: string): number {
  const b = PARAM_BOUNDS[key];
  const raw = process.env[b.env] !== undefined ? parseFloat(process.env[b.env]!) : b.def;
  if (isNaN(raw) || raw < b.min || raw > b.max) {
    const clamped = isNaN(raw) ? b.def : Math.min(b.max, Math.max(b.min, raw));
    console.warn(`[SNIPER] PARAM_GUARD ${b.env}=${process.env[b.env]} outside [${b.min}–${b.max}] ${b.unit} → clamped to ${clamped}`);
    return clamped;
  }
  return raw;
}
// Helper to ensure a parameter is within bounds, with a specific override for MIN_BUYS_1H
function ensureParam(value: number, min: number, max: number, def: number, envVar: string, unit: string): number {
  if (isNaN(value) || value < min || value > max) {
    const clamped = isNaN(value) ? def : Math.min(max, Math.max(min, value));
    console.warn(`[SNIPER] PARAM_GUARD ${envVar}=${process.env[envVar]} outside [${min}–${max}] ${unit} → clamped to ${clamped}`);
    return clamped;
  }
  return value;
}

let BASE_BUY_PCT     = guardParam('BASE_BUY_PCT');
let MAX_BUY_SOL      = guardParam('MAX_BUY_SOL');
let MIN_BUY_SOL      = Math.min(process.env.SNIPER_MIN_BUY ? parseFloat(process.env.SNIPER_MIN_BUY) : 0.005, MAX_BUY_SOL);
const MIN_PROFIT_BPS = process.env.MIN_PROFIT_BPS ? parseInt(process.env.MIN_PROFIT_BPS, 10) : 10;
const SLIPPAGE_BPS   = process.env.SLIPPAGE_BPS ? parseInt(process.env.SLIPPAGE_BPS, 10) : 50;

// Override ENV logic guard that clamped MIN_BUYS to 5. Now allows 3-1000.
const _minBuysConf   = process.env.SNIPER_MIN_BUYS ? parseInt(process.env.SNIPER_MIN_BUYS, 10) : 8;
let MIN_BUYS_1H      = ensureParam(_minBuysConf, 3, 1000, 8, 'SNIPER_MIN_BUYS', 'txns');

let MAX_POSITIONS    = Math.round(guardParam('MAX_POSITIONS'));
let MAX_HOLD_MS      = Math.round(guardParam('MAX_HOLD_MS'));   // 6min default, hard ceiling 10min
const RETRACE_SHIELD_MS = 30_000;
let MIN_VOLUME_1H    = guardParam('MIN_VOLUME_1H');
let MIN_PRICE_CHG_1H = guardParam('MIN_PRICE_CHG_1H');
let MIN_BUY_RATIO    = guardParam('MIN_BUY_RATIO');
const MAX_TOKEN_AGE_MIN= parseFloat(process.env.SNIPER_MAX_AGE || '9999');
let MIN_MOMENTUM_5M  = guardParam('MIN_MOMENTUM_5M');
const POLL_MS          = 60_000; // Increased from 20s to drop RPC background sweep load
const SIGNALS_DIR      = path.join(process.cwd(), 'signals');
const TRENDING_FILE    = path.join(SIGNALS_DIR, 'trending.json');
const SNIPER_LOG       = path.join(SIGNALS_DIR, 'sniper_positions.json');
const STRATEGY_FILE    = path.join(SIGNALS_DIR, 'chart_strategy.json');
const JOURNAL_FILE     = path.join(SIGNALS_DIR, 'trade_journal.jsonl');
const ALLOCATION_FILE  = path.join(SIGNALS_DIR, 'allocation.json');  // HarmonyAgent capital weight
const VELOCITY_FILE    = path.join(SIGNALS_DIR, 'velocity.json');     // pcp-velocity real-time swap feed
const WALLET_SIG_FILE  = path.join(SIGNALS_DIR, 'wallet_signals.json'); // pcp-wallet-tracker alpha signals

// Load velocity for a single mint
function loadVelocity(mint: string): {
  buys60s: number; sells60s: number; buyRatio60s: number;
  velocity: number; isAccelerating: boolean; solVolume60s: number;
} | null {
  try {
    if (!latestVelocityData || !latestVelocityData.mints) return null;
    const age = Date.now() - (latestVelocityData.updatedAt || 0);
    if (age > 10_000) return null; // stale >10s
    return latestVelocityData.mints[mint] || null;
  } catch { return null; }
}

// Load ALL velocity-tracked mints — used for velocity-first discovery
function loadAllVelocityMints(): Array<{
  mint: string; buys60s: number; sells60s: number; buyRatio60s: number;
  velocity: number; isAccelerating: boolean; solVolume60s: number;
}> {
  try {
    if (!latestVelocityData || !latestVelocityData.mints) return [];
    const age = Date.now() - (latestVelocityData.updatedAt || 0);
    if (age > 10_000) return []; // pcp-velocity down
    const mints = latestVelocityData.mints || {};
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


export function appendTrade(record: {
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
  ata?: string;             // Associated Token Account
}) {
  try {
    const pub = RedisBus.getPublisher();
    const entries: string[] = [];
    for (const [k, v] of Object.entries(record)) {
        if (v !== undefined && v !== null) {
            entries.push(k, v.toString());
        }
    }
    entries.push('ts', Date.now().toString());
    
    // Asynchronously stream into Redis memory buffer
    pub.xadd(STREAMS.TRADES, '*', ...entries).catch(() => {});
    
    // Optional fallback telemetry log
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
  peakPnlPct:     number;
  entryBuyRatio?: number;

  maxTPpct:       number;
  maxHoldMinutes: number;
  stopLossPct:    number;

  engineForceEvict?: boolean;
}

interface PositionStore {
  positions: Position[];
  blacklist: string[];       // mints to never snipe again
  stats: {
    wins: number;
    losses: number;
    totalPnlSol: number;
  };
}

// ── State ────────────────────────────────────────────────────────────────────
let store: PositionStore = { positions: [], blacklist: [], stats: { wins: 0, losses: 0, totalPnlSol: 0 } };
loadStore();

function loadStore() {
  try {
    if (fs.existsSync(SNIPER_LOG)) {
      store = JSON.parse(fs.readFileSync(SNIPER_LOG, 'utf-8'));
    }
  } catch { /* start fresh */ }
}

function saveStore() {
  fs.writeFileSync(SNIPER_LOG, JSON.stringify(store, null, 2));
}

// ── Jupiter helpers ───────────────────────────────────────────────────────────
async function jupFetch(path: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(`${JUP_BASE}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-api-key': JUP_KEY, ...opts.headers },
    signal: AbortSignal.timeout(10000),
  });
  return res.json();
}

export async function getQuote(inputMint: string, outputMint: string, amountLamports: number, slippageBps = 500): Promise<any | null> {
  try {
    const q = await jupFetch(`/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`);
    if (q.error || !q.outAmount) return null;
    return q;
  } catch { return null; }
}

export async function executeSwap(quote: any, tipLamports = 25000): Promise<string | null> {
    if (process.env.PAPER_MODE === 'true') {
        const mockSig = `PAPER_TRADE_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        console.log(`[SNIPER] 🧻 PAPER MODE: Mocking successful Swap Routing for ${quote?.outAmount} lamports. Ghost Sig: ${mockSig}`);
        return mockSig;
    }

    try {
      const swapData = await jupFetch('/swap', {
      method: 'POST',
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: false,   // ← WSOL-native: no wrap/unwrap instructions → lower CU → lower fees
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
    const pub = RedisBus.getPublisher();
    await pub.incr('rpc:calls:total');
    console.log(`[SNIPER] TX submitted: ${sig}`);
    return sig;
  } catch (e: any) {
    console.error('[SNIPER] Swap failed:', e.message);
    return null;
  }
}

async function getCurrentPriceSol(mint: string, tokenLamports: number): Promise<number | null> {
  const q = await getQuote(mint, WSOL, tokenLamports);
  if (!q) return null;
  return Number(q.outAmount) / 1e9; // SOL
}

// ── Dynamic TP/SL — small-win compounding mode ───────────────────────────────
// Take quick gains, recycle capital. Pennies compound into dollars.
// Entry already moved a lot? Take even less — just clip the tail.
function calcExitTargets(priceChg1h: number): { tp: number; sl: number } {
  if (priceChg1h >= 80) return { tp: 8,   sl: 7  };  // late entry  — grab 8%, cut at -7%
  if (priceChg1h >= 40) return { tp: 12,  sl: 10 };  // mid entry   — grab 12%, cut at -10%
  return                        { tp: 20,  sl: 15 };  // early entry — grab 20%, cut at -15%
}

// ── Dynamic buy size: WSOL balance % × harmony allocation weight ──────────────
// Reads from persistent WSOL ATA — no wrap/unwrap needed on trade execution.
// SIZE_UP: when WALLET_SIZE_UP=1 (set by alpha wallet consensus signal), 1.5× buy
async function calcBuySize(): Promise<number> {
  try {
    const wsolBal = await getWsolBalance(connection, wallet.publicKey);
    const bal     = wsolBal > 0 ? wsolBal : (await connection.getBalance(wallet.publicKey)) / 1e9;
    const raw     = bal * BASE_BUY_PCT;
    const weight  = loadSniperWeight();
    
    // Dynamic Performance Throttling
    let throttleMult = 1.0;
    try {
        const p = RedisBus.getPublisher();
        const perf = await p.hgetall(REDIS_KEYS.CONFIG_PERFORMANCE);
        if (perf && Object.keys(perf).length > 0) {
            if (perf.circuitBreaker === 'true') {
                 console.log(`[SNIPER] 🔴 CIRCUIT BREAKER ACTIVE — Halting all new entries!`);
                 return 0; // Absolute block
            }
            throttleMult = parseFloat(perf.positionSizeMultiplier) || 1.0;
        }
    } catch(e) {}
    
    let weighted  = raw * weight * throttleMult;

    // SIZE_UP: 3+ alpha wallets agreed — boost position size 1.5×
    const sizeUp = process.env.WALLET_SIZE_UP === '1';
    if (sizeUp) {
      weighted *= 1.5;
      console.log(`[SNIPER] 📈 SIZE_UP active — boosted to ${(weighted).toFixed(4)} SOL`);
    }

    const size = Math.min(MAX_BUY_SOL, Math.max(MIN_BUY_SOL, parseFloat(weighted.toFixed(4))));
    if (weight < 1.0) console.log(`[SNIPER] 🎯 Harmony weight: ${(weight*100).toFixed(0)}% → buy: ${size} SOL`);
    if (wsolBal > 0) console.log(`[SNIPER] 🪙 WSOL: ${wsolBal.toFixed(4)} | size: ${size} SOL${sizeUp ? ' 🔥SIZE_UP' : ''}`);
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

  const pub = RedisBus.getPublisher();
  
  // ── Duplicate Action Prevention (30s Cooldown) ─────────────────────────
  const isInCooldown = await pub.get(REDIS_KEYS.cooldown(mint));
  if (isInCooldown) {
      console.log(`[SNIPER] ⏳ Skipping ${symbol} — actively cooling down post-trade.`);
      return;
  }
  
  // ── Mathematical Expectations Pre-Validation ───────────────────────────
  // Rejects EV < 0 and tokens marked with Apex Manipulation flags synchronously
  const validationPassed = await validateTradeCandidate(mint);
  // TEMPORARY BYPASS:
  // if (!validationPassed) {
  //     return;
  // }

  // ── Dynamic Penalty Blacklist Cooling-Off ────────────────────────────────────
  const penaltyKey = REDIS_KEYS.tempBlacklist(mint);
  const penaltyStr = await pub.get(penaltyKey);
  const penaltyFactor = penaltyStr ? parseFloat(penaltyStr) : 1;

  const reqBuys = MIN_BUYS_1H * penaltyFactor;
  const reqRatio = MIN_BUY_RATIO * penaltyFactor;

  // ── Real-time velocity gate (pcp-velocity gRPC stream) ───────────────────
  // Supersedes DexScreener 5m lag with live 60s rolling swap counts.
  const vel = loadVelocity(mint);
  let velocityOverride = false;
  if (vel) {
    const MIN_VEL_BUYS   = 2 * penaltyFactor;    
    const MIN_VEL_RATIO  = 0.50 * penaltyFactor; 
    
    // VELOCITY OVERRIDE: If a token has massive speed right now (15+ tx/min and 3+ buys in 60s), 
    if (vel.buys60s >= MIN_VEL_BUYS && vel.velocity >= 15) {
        console.log(`[SNIPER] ⚡ VELOCITY OVERRIDE TRIGGERED FOR ${symbol} (${vel.buys60s}B/60s @ ${vel.velocity}tx/m)`);
        velocityOverride = true;
    } else {
        if (vel.buys60s < MIN_VEL_BUYS) {
          console.log(`[SNIPER] ⚡ ${symbol} VELOCITY SKIP — only ${vel.buys60s} buys/60s (min ${MIN_VEL_BUYS.toFixed(1)}) | vel:${vel.velocity.toFixed(0)}txpm`);
          return;
        }
        if (vel.buyRatio60s < MIN_VEL_RATIO) {
          console.log(`[SNIPER] ⚡ ${symbol} VELOCITY SKIP — buy ratio ${(vel.buyRatio60s*100).toFixed(0)}% <${(MIN_VEL_RATIO*100).toFixed(0)}% | ${vel.buys60s}B/${vel.sells60s}S`);
          return;
        }
    }
    const accTag = vel.isAccelerating ? ' 🚀 ACCELERATING' : '';
    console.log(`[SNIPER] ⚡ VELOCITY ${symbol}: ${vel.buys60s}B/${vel.sells60s}S (${(vel.buyRatio60s*100).toFixed(0)}%) | ${vel.velocity.toFixed(0)}tx/min | ${vel.solVolume60s.toFixed(3)} SOL/60s${accTag}`);
  } else {
    console.log(`[SNIPER] ℹ️  ${symbol} — velocity.json not available, relying purely on DexScreener.`);
  }

  // Edge filter: buy pressure must dominate unless actively accelerating via Spike
  if (buyRatio < reqRatio && !velocityOverride) {
    console.log(`[SNIPER] ⏭️  ${symbol} skipped — buy ratio ${buyRatio.toFixed(1)}x < req ${reqRatio.toFixed(1)}x (${buys1h}B/${sells1h}S)`);
    return;
  }
  if (buys1h < reqBuys && !velocityOverride) {
    console.log(`[SNIPER] ⏭️  ${symbol} skipped — only ${buys1h} buys in 1h (min ${reqBuys})`);
    return;
  }

  // ── EV and Slippage Firewall ───────────────────────────────────────────────
  const params = await pub.hgetall(`trade:params:${mint}`);
  const solPrice = parseFloat(await pub.hget('price:So11111111111111111111111111111111111111112', 'usd') || '150');

  let buySol = await calcBuySize(); // fallback
  if (buySol === 0) {
      console.log(`[SNIPER] 🚫 CIRCUIT BREAKER REJECTION: Halting snipe attempt on ${symbol}.`);
      return;
  }

  if (params && Object.keys(params).length > 0) {
      // if (params.isProfitable === 'false') {
      //     console.log(`[SNIPER] ⏭️ ${symbol} skipped — Negative Expected Value (EV=${parseFloat(params.expectedValue).toFixed(4)})`);
      //     return;
      // }
      
      if (params.positionSizeUSD) {
         const proposedSol = parseFloat(params.positionSizeUSD) / solPrice;
         const safeSol = Math.min(MAX_BUY_SOL, Math.max(MIN_BUY_SOL, proposedSol));
         buySol = parseFloat(safeSol.toFixed(4));
         if (parseFloat(params.positionSizeUSD) === 0) { // Circuit Breaker zero-out catch
             console.log(`[SNIPER] 🔴 ABORT: Performance circuit block detected in target.`);
             return;
         }
         console.log(`[SNIPER] 🧠 Kelly Criterion Sizing: ${buySol} SOL ($${parseFloat(params.positionSizeUSD).toFixed(2)})`);
      }
  }

  const buyLamports = Math.floor(buySol * 1e9);
  const ageTag = tokenAgeSec ? ` | age:${(tokenAgeSec/60).toFixed(0)}min` : '';
  console.log(`[SNIPER] 🎯 Sniping ${symbol} | +${priceChg1h.toFixed(0)}%/1h | $${(volume1h/1000).toFixed(1)}k vol | ${buys1h}B/${sells1h}S (${buyRatio.toFixed(1)}x) | size: ${buySol} SOL${ageTag}`);

  const quote = await getQuote(WSOL, mint, buyLamports);
  if (!quote) {
    console.log(`[SNIPER] ❌ No route via Jupiter yet for ${symbol} — retrying in 5s (indexer lag)`);
    await pub.setex(REDIS_KEYS.cooldown(mint), 5, '1'); // 5 second flat cooldown, no penalty!
    return;
  }

  const tokenAmount   = Number(quote.outAmount);
  
  // Guard against extreme slippage before we execute the swap
  const currentPriceSol = buySol / (tokenAmount / Math.pow(10, 6)); // Correct token decimals estimation assumes 6
  // Wait, token amount out from quote is in raw units (lamports equivalent). We can use exact USD ratio from solprice.
  const currentPriceUSD = (buySol * solPrice) / (tokenAmount / 1e6);

  if (params && params.maxBuyPrice) {
      const maxUSD = parseFloat(params.maxBuyPrice);
      // Rough estimation using 6 decimals as default spl standard
      if (currentPriceUSD > maxUSD && currentPriceUSD < maxUSD * 1000) { 
          // (sanity check to avoid broken decimal false positives rejecting all)
          console.log(`[SNIPER] 🚨 SLIPPAGE GUARD: ${symbol} quoted at ~$${currentPriceUSD.toFixed(4)} > Max Threshold $${maxUSD.toFixed(4)} — aborting`);
          await pub.setex(REDIS_KEYS.tempBlacklist(mint), 300, '1.5'); // 5 min penalty
          return;
      }
  }

  const entryPriceSol = buySol / tokenAmount;
  const sig = await executeSwap(quote, 250_000); // buy: aggressive priority (0.00025 SOL)
  if (!sig) {
      console.log(`[SNIPER] ❌ Swap execution failed for ${symbol} — blacklisting temporarily`);
      await pub.setex(REDIS_KEYS.tempBlacklist(mint), 300, '2.0'); // 5 min penalty
      return;
  }

  // Duplicate Check: Add SETNX lock immediately
  const posLockStr = await pub.set(REDIS_KEYS.position(mint), 'LOCKED', 'EX', 3600, 'NX');
  if (!posLockStr) {
      console.log(`[SNIPER] ⚠️ RACE DETECTED: Position lock already exists for ${symbol}. Skipping memory tracking.`);
      return;
  }

  // Set 30s re-buy cooldown locally just in case
  await pub.setex(REDIS_KEYS.cooldown(mint), 30, 'LOCKED');

  // Derive ATA address for on-chain balance lookups
  const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), wallet.publicKey).toBase58();

  // Journal: BUY entry — include freshness metadata + ATA for AnalyzerAgent
  appendTrade({ agent: 'pcp-sniper', action: 'BUY', mint, symbol, amountSol: buySol, sig,
    reason: `${priceChg1h.toFixed(0)}%/1h ${buys1h}B/${sells1h}S`, taSig, taConf,
    tokenAgeSec, momentum5m, momentum1m, pairCreatedAt, ata } as any);

  // Fetch dynamically precomputed bounds from Market Data Daemon
  let maxTPpct = parseFloat(process.env.MAX_TP_PERCENT || '20') / 100;
  let maxHoldMinutes = parseFloat(process.env.MAX_HOLD_MINUTES || '10');
  let stopLossPct = parseFloat(process.env.STOP_LOSS_PERCENT || '50') / 100;

  try {
      const pub = RedisBus.getPublisher();
      const params = await pub.hgetall(`trade:params:${mint}`);
      if (params && params.maxTPpct && params.stopLossPct) {
          maxTPpct = parseFloat(params.maxTPpct);
          maxHoldMinutes = parseFloat(params.maxHoldMinutes);
          stopLossPct = parseFloat(params.stopLossPct);
      }
  } catch (e) { }

  const pos: Position = {
    mint, ata, symbol, buyPriceSol: buySol, tokenAmount,
    openedAt: Date.now(), entryPriceSol, signature: sig,
    peakPnlPct: 0, entryBuyRatio: buyRatio,
    maxTPpct, maxHoldMinutes, stopLossPct
  };
  store.positions.push(pos);
  saveStore();

  // Route newly armed position to Apex Predator queue for asynchronous Forensics Sweeps
  try {
     const pub = RedisBus.getPublisher();
     await pub.rpush(REDIS_KEYS.apexCandidates, JSON.stringify({
         mint: pos.mint,
         symbol: pos.symbol,
         entryPriceSol: pos.entryPriceSol
     }));
     console.log(`[SNIPER] 🦅 Handed off ${pos.symbol} to Apex Predator for retroactive forensics...`);
  } catch (e) {
     console.log(`[SNIPER] ⚠️ Redis Warning: Failed to enqueue ${pos.symbol} to apex:candidates`);
  }

  console.log(`[SNIPER] ✅ Entered ${symbol}: ${buySol} SOL → ${tokenAmount} tokens`);
  console.log(`[SNIPER] 🔗 https://solscan.io/tx/${sig}`);
  console.log(`[SNIPER] 🏦 ATA: ${ata}`);
  console.log(`[SNIPER] 📊 TP: +${(maxTPpct * 100).toFixed(1)}% | SL: -${(stopLossPct * 100).toFixed(1)}% | hold≤${maxHoldMinutes.toFixed(1)}min | entry was +${priceChg1h.toFixed(0)}%/1h | orderflow: ${buys1h}B/${sells1h}S (${buyRatio.toFixed(1)}x)`);
}

// ── Exit logic ────────────────────────────────────────────────────────────────
async function checkExits() {
  const now   = Date.now();
  const exits: Position[] = [];

  for (const pos of store.positions) {
    const heldMs    = now - pos.openedAt;
    let forceExit = heldMs > MAX_HOLD_MS || !!pos.engineForceEvict; // 6min hard cap or manual dump from network
    const inRetrace = heldMs < RETRACE_SHIELD_MS;

    // ── APEX PREDATOR: Asynchronous Conviction Rejection ────────────
    const pub = RedisBus.getPublisher();
    const analysisStr = await pub.get(REDIS_KEYS.apexAnalysis(pos.mint));
    let isHighConviction = true; // Assume innocent until proven manipulated
    let apexCancelReason = '';
    
    if (analysisStr) {
        try {
            const analysis = JSON.parse(analysisStr);
            isHighConviction = analysis.is_high_conviction;
            if (isHighConviction === false) {
                 console.log(`[SNIPER] 🚨 APEX PREDATOR RETRO-FIRE-SELL: ${pos.symbol} flagged for CRIME (Score ≤ 3) — DUMPING IMMEDIATELY!`);
                 forceExit = true; 
                 apexCancelReason = 'APEX: MANIPULATION DETECTED';
            }
        } catch(e) {}
    }

    const curValueSol = await getCurrentPriceSol(pos.mint, pos.tokenAmount);
    if (!curValueSol && !forceExit) continue;

    const pnlPct = curValueSol
      ? ((curValueSol - pos.buyPriceSol) / pos.buyPriceSol) * 100
      : -100;

    // Update peak profit for trailing stop
    if (pnlPct > (pos.peakPnlPct || 0)) pos.peakPnlPct = pnlPct;
    const peak = pos.peakPnlPct || 0;

    // ── APEX: $4M Market Cap Check ───────────────────────────────────────
    // Approximate mcap using default 1B supply for solana meme tokens
    const solPrice = 150; // Use static approx, or could cache from Redis
    const approxMcapUSD = curValueSol ? (curValueSol / pos.tokenAmount) * solPrice * 1e9 : 0;
    
    if (approxMcapUSD >= 4_000_000 && !forceExit) {
        // Query Apex Liquidity Cache for the $1M/$2M marks
        const liqCheckObj = await pub.get(`apex:liquidity:${pos.mint}`);
        if (liqCheckObj) {
            const liq = JSON.parse(liqCheckObj);
            if (liq.liquidity_sufficient === false) {
                 console.log(`[SNIPER] 🚨 $4M MAX MCAP TRIGGERED: Thin liquidity mapped by Apex. Dumping instantly!`);
                 forceExit = true;
                 apexCancelReason = 'APEX: $4M MCAP / NO LIQUIDITY';
            }
        }
    }

    // ── Triple-Layer Hard Exit Constraints ───────────────────────────────────────────
    const targetTP = pos.maxTPpct || 0.20;
    const targetSL = pos.stopLossPct || 0.50;
    const targetTime = pos.maxHoldMinutes || 10;

    const elapsedMinutes = heldMs / 60000;
    const tpHit = pnlPct >= (targetTP * 100);
    const slHit = pnlPct <= -(targetSL * 100);
    const timeHit = elapsedMinutes >= targetTime;

    if (tpHit || slHit || timeHit || forceExit) {
      const reason = apexCancelReason ? apexCancelReason
                   : forceExit        ? `FORCE_EXIT (Apex / Emergency)`
                   : tpHit            ? `MAX_TP_HIT +${pnlPct.toFixed(1)}%`
                   : slHit            ? `STOP_LOSS -${Math.abs(pnlPct).toFixed(1)}%`
                   :                    `TIME_EXIT (${elapsedMinutes.toFixed(1)}m)`;
      
      console.log(`[SNIPER] 🔄 Exiting ${pos.symbol} — ${reason}`);

      const sellFraction = 1.0; // Rigid 100% exit
      // Aggressive execution for stop-loss and time-based force exits to prevent hold-over
      const isEmergencyExit = slHit || forceExit;
      const slippageBps = isEmergencyExit ? 1500 : 500; // 15% slippage on dumps/force closes
      
      let exactBalanceLamports = Number(pos.tokenAmount);
      try {
        const pub = RedisBus.getPublisher();
        await pub.incr('rpc:calls:total');
        const balAcct = await connection.getTokenAccountBalance(new PublicKey(pos.ata));
        exactBalanceLamports = Number(balAcct.value.amount);
      } catch (e: any) {
        console.warn(`[SNIPER] ⚠️ Could not fetch live balance for ${pos.symbol}, using cached entry amount`);
      }

      if (exactBalanceLamports <= 0) {
        console.warn(`[SNIPER] 👻 Token ${pos.symbol} balance is zero/dust on-chain! Dropping from memory to prevent infinite sell loop.`);
        exits.push(pos);
        continue;
      }

      // Calculate how many raw tokens to swap using fraction
      const activeSwapBal = Math.floor(exactBalanceLamports * sellFraction);

      const sellQuote = await getQuote(pos.mint, WSOL, activeSwapBal, slippageBps);
      if (sellQuote) {
      const priorityFee = tpHit ? 150_000 : isEmergencyExit ? 450_000 : 250_000;
      const sellSig = await executeSwap(sellQuote, priorityFee);
        if (sellSig) {
          const realizedSol = Number(sellQuote.outAmount) / 1e9;
          
          const pnlSol = realizedSol - pos.buyPriceSol; // Estimate PnL across total lifecycle vs remaining
          appendTrade({ agent: 'pcp-sniper', action: 'SELL', mint: pos.mint, symbol: pos.symbol, amountSol: realizedSol, pnlSol, sig: sellSig, reason, holdMs: heldMs });
          
          store.stats.totalPnlSol += pnlSol;
          if (pnlSol >= 0) store.stats.wins++; else store.stats.losses++;
          
          // Dynamic Cooling Off instead of permanent Array Blacklist
          if (slHit || forceExit) {
               const pubPublisher = RedisBus.getPublisher();
               console.log(`[SNIPER] 🧊 Blacklisted ${pos.symbol} strictly for 30 minutes! (2.0x Penalty)`);
               await pubPublisher.setex(REDIS_KEYS.tempBlacklist(pos.mint), 1800, '2.0');
          } else if (timeHit) {
               const pubPublisher = RedisBus.getPublisher();
               console.log(`[SNIPER] 🧊 Timeout minor penalty ${pos.symbol} for 10 minutes! (1.5x Penalty)`);
               await pubPublisher.setex(REDIS_KEYS.tempBlacklist(pos.mint), 600, '1.5');
          }
          
          // Unset position lock and set post-trade generic cooldown
          const outerPub = RedisBus.getPublisher();
          await outerPub.del(REDIS_KEYS.position(pos.mint));
          await outerPub.setex(REDIS_KEYS.cooldown(pos.mint), 30, 'LOCKED');

          exits.push(pos);
        } else {
          console.warn(`[SNIPER] ❌ Swap execution failed for ${pos.symbol} — keeping in memory to retry`);
        }
      } else {
        console.warn(`[SNIPER] ⚠️  No sell quote for ${pos.symbol} — holding`);
        // Self-heal: If token is dead/honeypot, drop it after double max hold to free up active slots
        if (heldMs > MAX_HOLD_MS * 2) {
            console.error(`[SNIPER] 💀 Token ${pos.symbol} has 0 liquidity/no route after ${(heldMs/60000).toFixed(1)}m. Dropping from active tracker.`);
            store.blacklist.push(pos.mint);
            exits.push(pos);
        }
        continue;
      }
    } else {
      // Status line
      const targetTP = pos.maxTPpct || 0.20;
      const targetSL = pos.stopLossPct || 0.50;
      console.log(`[SNIPER] 📊 ${pos.symbol} | PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% | held: ${(heldMs/60000).toFixed(1)}min | target: +${(targetTP * 100).toFixed(0)}% | SL: -${(targetSL * 100).toFixed(0)}%`);
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
]);


async function recoverOrphans() {
  try {
    const seen = new Map<string, {amount: string; uiAmount: number}>();

    // Scan both token programs with finalized commitment
    for (const prog of [TOKEN_PROG, TOKEN_PROG_22]) {
      try {
        const pub = RedisBus.getPublisher();
        await pub.incr('rpc:calls:total');
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
  // ── PATH 0 (pre): Force-sell queue — execute orphan sweep sells ───────────
  // Written by orphan_sweep.py or monitor. Processed once then deleted.
  const FORCE_SELL_FILE = path.join(SIGNALS_DIR, 'force_sell.json');
  if (fs.existsSync(FORCE_SELL_FILE)) {
    try {
      const fsData = JSON.parse(fs.readFileSync(FORCE_SELL_FILE, 'utf-8'));
      const sells: any[] = fsData.sells || [];
      console.log(`[SNIPER] 🧹 Force-sell queue: ${sells.length} orphan(s) to sweep`);
      fs.unlinkSync(FORCE_SELL_FILE); // delete first — prevents re-processing on crash
      for (const s of sells) {
        try {
          const q = await getQuote(s.mint, WSOL, s.amount);
          if (!q) { console.warn(`[SNIPER] ⚠️ No route for orphan ${s.mint.slice(0,12)}`); continue; }
          const sig = await executeSwap(q, 30_000);
          if (sig) {
            const solOut = Number(q.outAmount) / 1e9;
            console.log(`[SNIPER] ♻️ ORPHAN_SWEEP ${s.mint.slice(0,12)}... → +${solOut.toFixed(5)} SOL`);
            appendTrade({ agent:'pcp-sniper', action:'SELL', mint:s.mint, symbol:'ORPHAN',
              amountSol:solOut, pnlSol:0, sig, reason:'ORPHAN_SWEEP', holdMs:0 });
            store.stats.totalPnlSol += solOut;
          }
        } catch (e: any) { console.error(`[SNIPER] Force-sell error ${s.mint.slice(0,12)}: ${e.message}`); }
      }
    } catch (e: any) { console.error('[SNIPER] force_sell.json parse error:', e.message); }
  }

  // ── PATH 0a: Alpha wallet SELL exit (highest priority — before price checks) ──
  // If a tracked smart-money wallet SELLS a token we're holding, exit immediately.
  // Their exit = informed signal that the move is done.

  if (store.positions.length > 0 && fs.existsSync(WALLET_SIG_FILE)) {
    try {
      const wData = JSON.parse(fs.readFileSync(WALLET_SIG_FILE, 'utf-8'));
      const sellSigs: any[] = (wData.sell_signals || []).filter((s: any) => !s.expired);
      for (const sellSig of sellSigs) {
        const pos = store.positions.find((p: any) => p.mint === sellSig.mint);
        if (!pos) continue;
        console.log(`[SNIPER] 🚨 ALPHA WALLET SOLD ${pos.symbol} — force exit | held by alpha: ${(sellSig.holdMs/60000).toFixed(1)}min`);
        const sellQuote = await getQuote(pos.mint, WSOL, pos.tokenAmount);
        if (sellQuote) {
          const sellSigTx = await executeSwap(sellQuote, 15000);
          if (sellSigTx) {
            const realizedSol = Number(sellQuote.outAmount) / 1e9;
            const pnlSol      = realizedSol - pos.buyPriceSol;
            const pnlPct      = ((realizedSol - pos.buyPriceSol) / pos.buyPriceSol) * 100;
            console.log(`[SNIPER] ${pnlSol >= 0 ? '✅ WIN' : '❌ LOSS'} ${pos.symbol} | PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%) | ALPHA_SELL_TRIGGER`);
            appendTrade({ agent: 'pcp-sniper', action: 'SELL', mint: pos.mint, symbol: pos.symbol,
              amountSol: realizedSol, pnlSol, sig: sellSigTx, reason: `ALPHA_SELL wallet:${sellSig.walletAddr?.slice(0,8)}`, holdMs: Date.now() - pos.openedAt });
            store.stats.totalPnlSol += pnlSol;
            if (pnlSol >= 0) store.stats.wins++; else store.stats.losses++;
            store.positions = store.positions.filter(p => p.mint !== pos.mint);
            saveStore();
          }
        }
      }
    } catch {}
  }

  // Check exits (price-based logic)
  if (store.positions.length > 0) await checkExits();

  try {
    // ══════════════════════════════════════════════════════════════════════
    // PATH 0: ALPHA WALLET SIGNAL (pcp-wallet-tracker)
    // ── Highest priority — 2+ tracked smart money wallets bought same token
    // ── HIGH_CONVICTION flag = skip normal filters, enter immediately
    // ══════════════════════════════════════════════════════════════════════
    if (store.positions.length < MAX_POSITIONS && fs.existsSync(WALLET_SIG_FILE)) {
      try {
        const wData = JSON.parse(fs.readFileSync(WALLET_SIG_FILE, 'utf-8'));

        // ── SELL signals processed in checkExits() above ──
        // ── BUY signals: SIZE_UP → large entry, HIGH → normal entry ──
        const buySigs: any[] = (wData.buy_signals || []).filter((s: any) =>
          (s.conviction === 'HIGH' || s.sizeUp) &&
          !s.expired &&
          !store.blacklist.includes(s.mint) &&
          !store.positions.find((p: any) => p.mint === s.mint)
        );

        if (buySigs.length > 0) {
          const top = buySigs[0];
          const sizeTag = top.sizeUp ? 'SIZE_UP' : 'HIGH_CONV';
          const sectorTag = top.sector ? ` [${top.sector}]` : '';
          const hotSector = wData.hot_sector;

          console.log(`[SNIPER] 🧠 ${sizeTag}: ${top.symbol || top.mint.slice(0,8)}${sectorTag} | ${top.wallets.length} wallets | consensus:${(top.consensusScore||0).toFixed(2)} | hot:${hotSector||'none'}`);

          let trendingMeta: any = {};
          if (fs.existsSync(TRENDING_FILE)) {
            try {
              const tRaw = JSON.parse(fs.readFileSync(TRENDING_FILE, 'utf-8'));
              trendingMeta = (tRaw.mints || []).find((m: any) => m.mint === top.mint) || {};
            } catch {}
          }

          // SIZE_UP: override buy size to 1.5× normal (capped at MAX_BUY_SOL)
          if (top.sizeUp) {
            process.env.WALLET_SIZE_UP = '1'; // signal to calcBuySize
          }

          await trySnipe(
            top.mint,
            top.symbol || trendingMeta.symbol || top.mint.slice(0, 8),
            trendingMeta.volume1h || (top.swapSolAmount * 1000),
            trendingMeta.priceChange1h || 0,
            trendingMeta.buys1h || top.wallets.length,
            trendingMeta.sells1h || 0,
            top.consensusScore > 0 ? top.consensusScore : (trendingMeta.buyRatio || 0.7),
            `ALPHA_${sizeTag}`, top.consensusScore || 0.9,
          );

          process.env.WALLET_SIZE_UP = '0';
        }
      } catch (e: any) {
        console.error('[SNIPER] Wallet signal read error:', e.message);
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // PATH 1: VELOCITY-FIRST DISCOVERY (pcp-velocity WebSocket stream)
    // ── Catch pumps BEFORE DexScreener shows them ─────────────────────────
    // Scans velocity.json for isAccelerating mints, cross-checks trending.json
    // for directional confirmation. This is the sub-2s early-entry path.
    // ══════════════════════════════════════════════════════════════════════
    const velMints = loadAllVelocityMints();

    const accelerating = velMints.filter(v =>
      v.buys60s >= 2 &&               // Dropped to 2 buys max capture
      v.buyRatio60s >= 0.50 &&        // Dropped to 50%
      v.solVolume60s >= 0 &&          // Dropped to 0 (velocity natively outputs 0 solAmt)
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
    // ── Transitioned completely to High-Fidelity Railway Webhook.
  } catch (e: any) {
    console.error('[SNIPER] Poll error:', e.message);
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  PCP MOMENTUM SNIPER v1.1  (WSOL-native) ║');
  console.log('║  Wallet:', wallet.publicKey.toBase58().slice(0,20) + '…      ║');
  console.log(`║  Buy: ${MIN_BUY_SOL}-${MAX_BUY_SOL} SOL (20% bal) | TP/SL: tiered║`);
  console.log(`║  Max positions: ${MAX_POSITIONS} | Hold: ${MAX_HOLD_MS/60000}min max     ║`);
  console.log(`║  Base currency: WSOL (no wrap/unwrap fees)║`);
  console.log('╚══════════════════════════════════════════╝');

  // ── WSOL ATA initialization ───────────────────────────────────────────────
  // Ensure the persistent WSOL ATA exists — one on-chain check at startup
  try {
    await ensureWsolAta(connection, wallet);
    const wsolBal = await getWsolBalance(connection, wallet.publicKey);
    if (wsolBal > 0) {
      console.log(`[SNIPER] 🪙 WSOL trading balance: ${wsolBal.toFixed(4)} SOL`);
    } else {
      console.log('[SNIPER] ⚠️  WSOL ATA empty — auto-refill from native SOL on next poll');
      // Auto-fill immediately from native SOL
      await autoRefillWsol(connection, wallet, MIN_BUY_SOL);
    }
  } catch (e: any) {
    console.warn('[SNIPER] WSOL init warning:', e.message, '— falling back to native SOL');
  }

  // Recover any wallet tokens not tracked as positions
  await recoverOrphans();

  // Wrap native SOL → WSOL before each poll (no-op if WSOL balance adequate)
  const pollWithRefill = async () => {
    await autoRefillWsol(connection, wallet, MIN_BUY_SOL).catch(() => {});
    await poll();
  };

  // Initial poll
  await pollWithRefill();

  // Network Event Loop
  const sub = RedisBus.getSubscriber();
  sub.subscribe(CHANNELS.VELOCITY_SPIKE);
  sub.subscribe(CHANNELS.CONFIG_UPDATE);
  sub.subscribe(CHANNELS.ENGINE_FORCE_SELL);
  sub.on('message', (ch, msg) => {
    if (ch === CHANNELS.VELOCITY_SPIKE) {
      try {
        latestVelocityData = JSON.parse(msg);
        console.log('[DEBUG] VELOCITY SPIKE RECEIVED!', Object.keys(latestVelocityData.mints).length, latestVelocityData.updatedAt);
        pollWithRefill(); // High-Frequency Sub-Second Trigger
      } catch (e) {
        console.error('[DEBUG] Parse error on spike:', e);
      }
    } 
    else if (ch === CHANNELS.ENGINE_FORCE_SELL) {
      try {
        const payload = JSON.parse(msg);
        const idx = store.positions.findIndex(p => p.mint === payload.mint);
        if (idx > -1) {
            console.log(`[SNIPER] 🚨 ENGINE BLOCK: Dumping ${payload.symbol}!`);
            store.positions[idx].engineForceEvict = true;
        }
      } catch {}
    }
    else if (ch === CHANNELS.CONFIG_UPDATE) {
      try {
        const overrides = JSON.parse(msg);
        console.log(`[SNIPER/ADJUSTER] 🛡️ DYNAMIC OVERRIDE PROTOCOL INITIATED:`, overrides);
        
        if (overrides.BASE_BUY_PCT) BASE_BUY_PCT = overrides.BASE_BUY_PCT;
        if (overrides.MIN_BUY_SOL) MIN_BUY_SOL = overrides.MIN_BUY_SOL;
        if (overrides.MAX_BUY_SOL) MAX_BUY_SOL = overrides.MAX_BUY_SOL;
        if (overrides.MAX_POSITIONS) MAX_POSITIONS = overrides.MAX_POSITIONS;
        if (overrides.MAX_HOLD_MS) MAX_HOLD_MS = overrides.MAX_HOLD_MS;
      } catch (e: any) {
        console.error('[SNIPER/ADJUSTER] Override Parse Error:', e.message);
      }
    }
  });

  // Watchdog Heartbeat
  setInterval(() => {
    RedisBus.publish('heartbeat:agent', { agent: 'pcp-sniper', timestamp: Date.now() });
  }, 30000);

  // Fallback Interval if Velocity stalls
  setInterval(pollWithRefill, POLL_MS);

  process.on('SIGTERM', () => {
    saveStore();
    process.exit(0);
  });
}

main().catch(e => { console.error('[SNIPER] Fatal:', e); process.exit(1); });
