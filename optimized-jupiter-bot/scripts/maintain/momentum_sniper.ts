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
import { getWsolBalance, autoRefillWsol, ensureWsolAta } from '../../src/utils/wsol_manager';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const RPC         = process.env.RPC_ENDPOINT!;
const JUP_KEY     = process.env.JUPITER_API_KEY!;
const JUP_BASE    = process.env.JUPITER_ENDPOINT || 'https://api.jup.ag/swap/v1';
const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH!;
const WSOL        = 'So11111111111111111111111111111111111111112';

const connection  = new Connection(RPC, { commitment: 'confirmed' });
const walletJson  = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
const wallet      = Keypair.fromSecretKey(new Uint8Array(walletJson));

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
const BASE_BUY_PCT     = guardParam('BASE_BUY_PCT');
const MIN_BUY_SOL      = guardParam('MIN_BUY_SOL');
const MAX_BUY_SOL      = guardParam('MAX_BUY_SOL');
const MAX_POSITIONS    = Math.round(guardParam('MAX_POSITIONS'));
const MAX_HOLD_MS      = Math.round(guardParam('MAX_HOLD_MS'));   // 6min default, hard ceiling 10min
const RETRACE_SHIELD_MS = 30_000;
const MIN_VOLUME_1H    = guardParam('MIN_VOLUME_1H');
const MIN_PRICE_CHG_1H = guardParam('MIN_PRICE_CHG_1H');
const MIN_BUY_RATIO    = guardParam('MIN_BUY_RATIO');
const MIN_BUYS_1H      = Math.round(guardParam('MIN_BUYS_1H'));
const MAX_TOKEN_AGE_MIN= parseFloat(process.env.SNIPER_MAX_AGE || '9999');
const MIN_MOMENTUM_5M  = guardParam('MIN_MOMENTUM_5M');
const POLL_MS          = 20_000;
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
    if (!fs.existsSync(VELOCITY_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(VELOCITY_FILE, 'utf-8'));
    const age = Date.now() - (raw.updatedAt || 0);
    if (age > 10_000) return null; // stale >10s
    return raw.mints?.[mint] || null;
  } catch { return null; }
}

// Load ALL velocity-tracked mints — used for velocity-first discovery
function loadAllVelocityMints(): Array<{
  mint: string; buys60s: number; sells60s: number; buyRatio60s: number;
  velocity: number; isAccelerating: boolean; solVolume60s: number;
}> {
  try {
    if (!fs.existsSync(VELOCITY_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(VELOCITY_FILE, 'utf-8'));
    const age = Date.now() - (raw.updatedAt || 0);
    if (age > 10_000) return []; // pcp-velocity down
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

async function getQuote(inputMint: string, outputMint: string, amountLamports: number): Promise<any | null> {
  try {
    const q = await jupFetch(`/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=500`);
    if (q.error || !q.outAmount) return null;
    return q;
  } catch { return null; }
}

async function executeSwap(quote: any, tipLamports = 25000): Promise<string | null> {
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
    let weighted  = raw * weight;

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

  const buySol     = await calcBuySize();
  const buyLamports = Math.floor(buySol * 1e9);
  const ageTag = tokenAgeSec ? ` | age:${(tokenAgeSec/60).toFixed(0)}min` : '';
  console.log(`[SNIPER] 🎯 Sniping ${symbol} | +${priceChg1h.toFixed(0)}%/1h | $${(volume1h/1000).toFixed(1)}k vol | ${buys1h}B/${sells1h}S (${buyRatio.toFixed(1)}x) | size: ${buySol} SOL${ageTag}`);

  const quote = await getQuote(WSOL, mint, buyLamports);
  if (!quote) {
    console.log(`[SNIPER] ❌ No quote for ${symbol} — skipping`);
    return;
  }

  const tokenAmount   = Number(quote.outAmount);
  const entryPriceSol = buySol / tokenAmount;

  const sig = await executeSwap(quote, 30000); // buy: modest priority
  if (!sig) return;

  // Derive ATA address for on-chain balance lookups
  const { getAssociatedTokenAddressSync } = await import('@solana/spl-token');
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), wallet.publicKey).toBase58();

  // Journal: BUY entry — include freshness metadata + ATA for AnalyzerAgent
  appendTrade({ agent: 'pcp-sniper', action: 'BUY', mint, symbol, amountSol: buySol, sig,
    reason: `${priceChg1h.toFixed(0)}%/1h ${buys1h}B/${sells1h}S`, taSig, taConf,
    tokenAgeSec, momentum5m, momentum1m, pairCreatedAt, ata } as any);

  const { tp: tpPct, sl: slPct } = calcExitTargets(priceChg1h);
  const pos: Position = {
    mint, ata, symbol, buyPriceSol: buySol, tokenAmount,
    openedAt: Date.now(), entryPriceSol, signature: sig,
    tpPct, slPct, peakPnlPct: 0,
    entryBuyRatio: buyRatio, // store for order flow reversal detection
  };
  store.positions.push(pos);
  saveStore();

  console.log(`[SNIPER] ✅ Entered ${symbol}: ${buySol} SOL → ${tokenAmount} tokens`);
  console.log(`[SNIPER] 🔗 https://solscan.io/tx/${sig}`);
  console.log(`[SNIPER] 🏦 ATA: ${ata}`);
  console.log(`[SNIPER] 📊 TP: +${tpPct}% | SL: -${slPct}% | hold≤${MAX_HOLD_MS/60000}min | entry was +${priceChg1h.toFixed(0)}%/1h | orderflow: ${buys1h}B/${sells1h}S (${buyRatio.toFixed(1)}x)`);
}

// ── Exit logic ────────────────────────────────────────────────────────────────
async function checkExits() {
  const now   = Date.now();
  const exits: Position[] = [];

  for (const pos of store.positions) {
    const heldMs    = now - pos.openedAt;
    const forceExit = heldMs > MAX_HOLD_MS; // 6min hard cap — data shows wins resolve in 2.6min avg
    const inRetrace = heldMs < RETRACE_SHIELD_MS;

    const curValueSol = await getCurrentPriceSol(pos.mint, pos.tokenAmount);
    if (!curValueSol && !forceExit) continue;

    const pnlPct = curValueSol
      ? ((curValueSol - pos.buyPriceSol) / pos.buyPriceSol) * 100
      : -100;

    // Update peak profit for trailing stop
    if (pnlPct > (pos.peakPnlPct || 0)) pos.peakPnlPct = pnlPct;
    const peak = pos.peakPnlPct || 0;

    // ── Time-decaying SL — tightens as trade ages ────────────────────────────
    // Fresh entry gets full SL headroom. As momentum fades with time,
    // we accept less drawdown — if it hasn't moved up yet, it won't.
    // Retrace shield (first 30s) doubles SL to protect against normal wick.
    let activeSl: number;
    if (inRetrace) {
      activeSl = pos.slPct * 2;           // 0-30s: double SL (retrace shield)
    } else if (heldMs < 60_000) {
      activeSl = pos.slPct;               // 30s-1min: full SL
    } else if (heldMs < 180_000) {
      activeSl = pos.slPct * 0.50;        // 1-3min: tighten to 50% — 15% SL → 7.5%
    } else {
      activeSl = pos.slPct * 0.25;        // 3min+: tighten to 25% — 15% SL → 3.75%
    }
    const tp = pnlPct >= pos.tpPct;
    const sl = pnlPct <= -activeSl;

    // ── Order Flow Reversal — early exit before hitting full SL ────────────────
    // If velocity shows buy ratio flipped hard (sellers now dominating) within
    // the first 3 minutes of holding AND price is already going negative,
    // exit immediately — don't wait for the full SL to trigger.
    let orderFlowReversal = false;
    if (heldMs < 180_000 && pnlPct < 0 && !forceExit) {
      const vel = loadVelocity(pos.mint);
      if (vel && vel.buys60s + vel.sells60s >= 3) { // enough data
        const curRatio = vel.buyRatio60s;  // 0-1 (fraction of swaps that are buys)
        const entryRatio = (pos.entryBuyRatio || 0.6) / (1 + (pos.entryBuyRatio || 0.6)); // normalize to 0-1
        // Reversal: buy ratio dropped below 40% AND fell significantly from entry
        if (curRatio < 0.40 && curRatio < entryRatio * 0.65) {
          orderFlowReversal = true;
          console.log(`[SNIPER] 🚨 ${pos.symbol} ORDER FLOW REVERSED — entry:${(entryRatio*100).toFixed(0)}% buy → now:${(curRatio*100).toFixed(0)}% buy | PnL:${pnlPct.toFixed(1)}% — exiting early`);
        }
      }
    }

    // ── Stale/flat exit — no momentum after 2min means the trade is dead ──────
    // Wins resolve fast. If price is flat (between -1% and +1%) after 2 minutes,
    // there's no reason to hold. Exit and free capital for the next opportunity.
    const staleFlat = heldMs > 120_000 && pnlPct > -1.0 && pnlPct < 1.0;
    if (staleFlat && !forceExit) {
      console.log(`[SNIPER] 💤 ${pos.symbol} STALE — flat at ${pnlPct.toFixed(1)}% after ${(heldMs/60000).toFixed(1)}min — exiting`);
    }

    // ── Tiered Trailing Take Profit ───────────────────────────────────────────
    // Activates at +1% peak (lowered from +2%). Gets tighter as we go higher.
    // Goal: lock in gains quickly on fast pumps, compound fast.
    let trailPct: number;  // how far below peak we allow before exit
    if      (peak >= 20) trailPct = peak * 0.15; // keep 85% — very tight at big peaks
    else if (peak >= 10) trailPct = peak * 0.20; // keep 80%
    else if (peak >= 5)  trailPct = peak * 0.25; // keep 75%
    else if (peak >= 3)  trailPct = peak * 0.35; // keep 65%
    else if (peak >= 2)  trailPct = peak * 0.40; // keep 60%
    else if (peak >= 1)  trailPct = peak * 0.50; // keep 50% — activate early at +1%
    else                 trailPct = 999;          // not activated yet
    const trail = peak >= 1 && pnlPct <= (peak - trailPct);

    if (tp || sl || trail || staleFlat || orderFlowReversal || forceExit) {
      const reason = tp                ? `TP +${pnlPct.toFixed(1)}%`
                   : trail             ? `TRAIL peak:+${peak.toFixed(1)}% pullback to:+${pnlPct.toFixed(1)}% (kept ${(peak - trailPct).toFixed(1)}%)`
                   : staleFlat         ? `STALE flat:${pnlPct.toFixed(1)}% after ${(heldMs/60000).toFixed(1)}min`
                   : orderFlowReversal ? `ORDERFLOW-REVERSAL ${pnlPct.toFixed(1)}% (sellers took over in first 3min)`
                   : sl                ? `SL ${pnlPct.toFixed(1)}% (shield:${inRetrace})`
                   :                    `TIME ${(heldMs/60000).toFixed(1)}min`;
      console.log(`[SNIPER] 🔄 Exiting ${pos.symbol} — ${reason}`);

      const sellQuote = await getQuote(pos.mint, WSOL, pos.tokenAmount);
      if (sellQuote) {
      const sellSig = await executeSwap(sellQuote, tp ? 5000 : sl ? 25000 : 10000);
        if (sellSig) {
          const realizedSol = Number(sellQuote.outAmount) / 1e9;
          const pnlSol      = realizedSol - pos.buyPriceSol;
          console.log(`[SNIPER] ${pnlSol >= 0 ? '✅ WIN' : '❌ LOSS'} ${pos.symbol} | PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL (${pnlPct.toFixed(1)}%)`);
          console.log(`[SNIPER] 🔗 https://solscan.io/tx/${sellSig}`);
          appendTrade({ agent: 'pcp-sniper', action: 'SELL', mint: pos.mint, symbol: pos.symbol,
            amountSol: realizedSol, pnlSol, sig: sellSig, reason, holdMs: heldMs });
          store.stats.totalPnlSol += pnlSol;
          if (pnlSol >= 0) store.stats.wins++; else store.stats.losses++;
          if (sl) store.blacklist.push(pos.mint);
          exits.push(pos);
        } else {
          console.warn(`[SNIPER] ❌ Swap execution failed for ${pos.symbol} — keeping in memory to retry`);
        }
      } else {
        console.warn(`[SNIPER] ⚠️  No sell quote for ${pos.symbol} — holding`);
        continue;
      }
    } else {
      // Status line: show trailing state when active
      const trailTag = peak >= 2
        ? ` | 🎯 trail floor: +${(peak - trailPct).toFixed(1)}% (peak:+${peak.toFixed(1)}%)`
        : '';
      console.log(`[SNIPER] 📊 ${pos.symbol} | PnL: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% | held: ${(heldMs/60000).toFixed(1)}min | SL: -${activeSl.toFixed(0)}%${trailTag}`);
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
      v.isAccelerating &&
      v.buys60s >= 8 &&               // at least 8 buys in last 60s (raised from 5 — filters micro-noise)
      v.buyRatio60s >= 0.65 &&        // ≥65% of swaps are buys (raised from 60% — stronger conviction)
      v.solVolume60s >= 0.005 &&      // at least 0.005 SOL traded (raised from 0.001 — real liquidity)
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
      if (vol1h < MIN_VOLUME_1H) return false;
      if (m.priceChange1h < MIN_PRICE_CHG_1H) return false;
      if (store.blacklist.includes(m.mint)) return false;
      if ((m.buyRatio || 0) < MIN_BUY_RATIO) return false;
      if (store.positions.find(p => p.mint === m.mint)) return false;

      // 5m momentum — must still be actively moving
      const mom5m = m.priceChange5m ?? m.priceChange5Min ?? null;
      if (mom5m !== null && mom5m < MIN_MOMENTUM_5M) {
        console.log(`[SNIPER] ⏭️  ${m.symbol} — 5m momentum ${mom5m.toFixed(1)}% < ${MIN_MOMENTUM_5M}% (move peaked)`);
        return false;
      }

      // Token age: log only (no gate)
      const createdAt = m.pairCreatedAt ?? m.createdAt ?? null;
      if (createdAt) m._ageMin = (Date.now() - createdAt) / 60_000;

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

  // Recurring
  setInterval(pollWithRefill, POLL_MS);

  process.on('SIGTERM', () => {
    saveStore();
    process.exit(0);
  });
}

main().catch(e => { console.error('[SNIPER] Fatal:', e); process.exit(1); });
