/**
 * pumpfun_sniper.ts  v3 — Strategy-Tuner Aware
 * ─────────────────────────────────────────────────────────────────────────────
 * Scans DexScreener every 15s for tokens < 5min old with buy pressure.
 * Uses strategy_params.json (written by the slow/fast tuner loops) to
 * self-calibrate: buy size, slippage, and TP/SL adjust based on Kelly
 * fraction + live win-rate EMA from our own trade history.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs   from 'fs';
import path from 'path';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import dotenv from 'dotenv';
import { getWsolBalance, autoRefillWsol, ensureWsolAta } from '../../src/utils/wsol_manager';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const RPC         = process.env.RPC_ENDPOINT!;
const JUP_KEY     = process.env.JUPITER_API_KEY!;
const JUP_BASE    = process.env.JUPITER_ENDPOINT || 'https://api.jup.ag/swap/v1';
const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH!;
const WSOL        = 'So11111111111111111111111111111111111111112';

const connection = new Connection(RPC, { commitment: 'confirmed' });
const walletJson = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
const wallet     = Keypair.fromSecretKey(new Uint8Array(walletJson));

const SIGNALS_DIR   = path.join(process.cwd(), 'signals');
const PF_LOG        = path.join(SIGNALS_DIR, 'pumpfun_positions.json');
const PARAMS_PATH   = path.join(process.cwd(), 'strategy_params.json');
const JOURNAL_FILE  = path.join(SIGNALS_DIR, 'trade_journal.jsonl');

function appendTrade(record: {
  agent: string; action: 'BUY' | 'SELL';
  mint: string; symbol: string;
  amountSol: number; pnlSol?: number;
  sig: string; reason?: string;
  holdMs?: number; tpPct?: number; slPct?: number;
}) {
  try {
    if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });
    fs.appendFileSync(JOURNAL_FILE, JSON.stringify({ ...record, ts: Date.now() }) + '\n', 'utf-8');
  } catch { /* never crash on journal write */ }
}

// ── Strategy params (live-updated by strategy_tuner) ─────────────────────────
interface StrategyParams {
  MAX_TRADE_SIZE_SOL: number;
  MAX_SLIPPAGE_BPS:   number;
  TIP_PERCENTAGE:     number;
}

function loadParams(): StrategyParams {
  try {
    if (fs.existsSync(PARAMS_PATH)) {
      const p = JSON.parse(fs.readFileSync(PARAMS_PATH, 'utf-8'));
      return {
        MAX_TRADE_SIZE_SOL: p.MAX_TRADE_SIZE_SOL || 0.01,
        MAX_SLIPPAGE_BPS:   p.MAX_SLIPPAGE_BPS   || 50,
        TIP_PERCENTAGE:     p.TIP_PERCENTAGE      || 0.30,
      };
    }
  } catch { /* fall through */ }
  return { MAX_TRADE_SIZE_SOL: 0.01, MAX_SLIPPAGE_BPS: 50, TIP_PERCENTAGE: 0.30 };
}

// ── Inline math (ported from strategy_tuner.ts) ───────────────────────────────
function ema(values: number[], period: number): number {
  if (!values.length) return 0;
  const alpha = 2 / (period + 1);
  return values.reduce((acc, v, i) => i === 0 ? v : alpha * v + (1 - alpha) * acc, values[0]);
}

function kellyFraction(winRate: number, avgWin: number, avgLoss: number): number {
  if (avgLoss <= 0 || avgWin <= 0) return 0.05;
  const b = avgWin / avgLoss;
  const k = (winRate * b - (1 - winRate)) / b;
  return Math.max(0.01, Math.min(0.25, k * 0.25)); // quarter-Kelly, clamped
}

// ── Config ────────────────────────────────────────────────────────────────────
const MAX_POSITIONS = parseInt(process.env.PF_MAX_POS   || '2');
const MAX_AGE_MIN   = 5;
const MIN_LIQ       = 1000;
const MAX_LIQ       = 200000;
const MIN_BUY_RATIO = 1.5;
const MIN_BUYS_5M   = 5;
const SCAN_MS       = 15_000;
const EXIT_MS       = 5_000;
const RETRACE_MS    = 60_000; // SL doubled for first 60s after entry

// Base TP/SL — adjusted by Kelly win-rate each cycle
const BASE_TP_PCT = 10;
const BASE_SL_PCT = 8;

// ── State ─────────────────────────────────────────────────────────────────────
interface PFPosition {
  mint: string; symbol: string;
  tokenAmount: number; buySol: number;
  openedAt: number; sig: string;
  tpPct: number; slPct: number;
}
let positions: PFPosition[] = [];
let blacklist:  string[]    = [];
let tradeLog: { success: boolean; pnlSol: number }[] = [];
let stats = { wins: 0, losses: 0, pnlSol: 0 };
const seenMints = new Set<string>();

try {
  const s = JSON.parse(fs.readFileSync(PF_LOG, 'utf-8'));
  positions = s.positions || [];
  blacklist  = s.blacklist  || [];
  tradeLog   = s.tradeLog   || [];
  stats      = s.stats      || stats;
  positions.forEach(p => seenMints.add(p.mint));
} catch { /* fresh */ }

function save() {
  fs.writeFileSync(PF_LOG, JSON.stringify({ positions, blacklist, tradeLog, stats }, null, 2));
}

function calcTargets(wsolBal = 0): { tpPct: number; slPct: number; buySol: number } {
  const params  = loadParams();

  // Use our own sniper trade history for Kelly, not the arb engine's
  const wins    = tradeLog.filter(t => t.success && t.pnlSol > 0);
  const losses  = tradeLog.filter(t => !t.success || t.pnlSol <= 0);
  const winRate = tradeLog.length > 5 ? wins.length / tradeLog.length : 0.5; // assume 50% if no data
  const avgWin  = wins.length   > 0 ? wins.reduce((a, t) => a + t.pnlSol, 0)          / wins.length   : 0.001;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, t) => a + t.pnlSol, 0) / losses.length) : 0.001;
  const kelly   = kellyFraction(winRate, avgWin, avgLoss);

  // EMA of win/loss binary — recent trend
  const emaWin  = ema(tradeLog.slice(-20).map(t => t.success ? 1 : 0), 10);

  // TP: base 10%, widen if winning streak (EMA win > 60%), tighten if losing
  let tpPct = BASE_TP_PCT;
  if (emaWin > 0.60) tpPct = Math.min(BASE_TP_PCT * 1.3, 18); // doing well — let it run
  if (emaWin < 0.35) tpPct = Math.max(BASE_TP_PCT * 0.8, 7);  // losing — take small wins fast

  // SL: tighten on losing streak, loosen slightly when winning
  let slPct = BASE_SL_PCT;
  if (emaWin < 0.35) slPct = Math.max(BASE_SL_PCT * 0.8, 5);  // losing — cut losses earlier
  if (emaWin > 0.60) slPct = Math.min(BASE_SL_PCT * 1.2, 12); // winning — more room to breathe

  // Buy size: Kelly fraction of WSOL balance (or native SOL fallback), capped to strategy_params max
  const effectiveBal = wsolBal > 0 ? wsolBal : 0.042; // use WSOL balance for Kelly sizing
  const buySol = Math.min(
    Math.max(kelly * effectiveBal, 0.005),
    params.MAX_TRADE_SIZE_SOL,
    0.02, // hard cap for this capital level
  );

  return { tpPct: parseFloat(tpPct.toFixed(1)), slPct: parseFloat(slPct.toFixed(1)), buySol: parseFloat(buySol.toFixed(4)) };
}

// ── Jupiter ───────────────────────────────────────────────────────────────────
async function jupFetch(p: string, opts: RequestInit = {}): Promise<any> {
  const r = await fetch(`${JUP_BASE}${p}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-api-key': JUP_KEY, ...opts.headers },
    signal: AbortSignal.timeout(8000),
  });
  return r.json();
}

async function getQuote(inMint: string, outMint: string, lamports: number, slippageBps = 500): Promise<any | null> {
  try {
    const q = await jupFetch(`/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${lamports}&slippageBps=${slippageBps}`);
    return q?.error || !q?.outAmount ? null : q;
  } catch { return null; }
}

async function execSwap(quote: any, tipLamports = 10000): Promise<string | null> {
  try {
    const d = await jupFetch('/swap', {
      method: 'POST',
      body: JSON.stringify({
        quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: false,   // ← WSOL-native: eliminates wrap/unwrap instructions
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: tipLamports,
      }),
    });
    if (!d?.swapTransaction) return null;
    const tx = VersionedTransaction.deserialize(Buffer.from(d.swapTransaction, 'base64'));
    tx.sign([wallet]);
    return await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  } catch (e: any) { console.error('[PF] Swap fail:', e.message); return null; }
}

// ── Scan ──────────────────────────────────────────────────────────────────────
async function scan() {
  if (positions.length >= MAX_POSITIONS) return;

  // Ensure WSOL ATA topped up before buying
  const wsolBal = await getWsolBalance(connection, wallet.publicKey).catch(() => 0);
  await autoRefillWsol(connection, wallet).catch(() => {});

  const { tpPct, slPct, buySol } = calcTargets(wsolBal);
  const params   = loadParams();
  const lamports = Math.floor(buySol * 1e9);

  try {
    // Use boosted pairs endpoint - returns recent high-momentum Solana tokens
    const res  = await fetch('https://api.dexscreener.com/token-boosts/latest/v1', {
      signal: AbortSignal.timeout(10000),
    });
    const raw   = await res.json();
    const solTokens: string[] = (Array.isArray(raw) ? raw : [])
      .filter((t: any) => t.chainId === 'solana')
      .slice(0, 30)
      .map((t: any) => t.tokenAddress)
      .filter(Boolean);

    if (!solTokens.length) { console.log('[PF] No boosted tokens'); return; }

    const pairsRes  = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${solTokens.slice(0,29).join(',')}`, {
      signal: AbortSignal.timeout(10000),
    });
    const pairsData = await pairsRes.json();
    const pairs: any[] = (pairsData?.pairs || []).filter((p: any) => p.chainId === 'solana');
    const now = Date.now();
    let scanned = 0, ageOk = 0, liqOk = 0, pressureOk = 0;

    for (const pair of pairs) {
      if (positions.length >= MAX_POSITIONS) break;
      const mint = pair.baseToken?.address;
      if (!mint || seenMints.has(mint) || blacklist.includes(mint)) continue;
      scanned++;

      const ageMin = pair.pairCreatedAt ? (now - pair.pairCreatedAt) / 60_000 : -1;

      // Accept if:  (a) age is known and < MAX_AGE_MIN, OR
      //             (b) age unknown but 5m volume is hot (>25% of 1h = recent spike)
      const vol5m = pair.volume?.m5  || 0;
      const vol1h = pair.volume?.h1  || 1;
      const volSpiking = vol5m / vol1h > 0.25;
      const ageValid   = ageMin >= 0 && ageMin <= MAX_AGE_MIN;
      if (!ageValid && !volSpiking) continue;
      ageOk++;

      const liq = pair.liquidity?.usd || 0;
      if (liq < MIN_LIQ || liq > MAX_LIQ) continue;
      liqOk++;

      const buys  = pair.txns?.m5?.buys  || pair.txns?.h1?.buys  || 0;
      const sells = pair.txns?.m5?.sells || pair.txns?.h1?.sells || 1;
      const ratio = buys / sells;
      if (ratio < MIN_BUY_RATIO || buys < MIN_BUYS_5M) continue;
      if ((pair.priceChange?.m5 || 0) <= 0) continue;
      pressureOk++;

      seenMints.add(mint);
      const sym   = pair.baseToken?.symbol || '?';
      const pc5m  = pair.priceChange?.m5 || 0;

      console.log(`[PF] 🚀 ${sym} | ${ageMin.toFixed(1)}min old | liq:$${(liq/1000).toFixed(1)}k | ${buys}B/${sells}S (${ratio.toFixed(1)}x) | +${pc5m.toFixed(0)}%/5m | size:${buySol} SOL | TP:+${tpPct}% SL:-${slPct}%`);

      const quote = await getQuote(WSOL, mint, lamports, params.MAX_SLIPPAGE_BPS * 10);
      if (!quote) { console.log(`[PF] ❌ No route for ${sym}`); continue; }

      const sig = await execSwap(quote, 30000); // buy: modest priority to land quickly
      if (!sig) continue;

      positions.push({ mint, symbol: sym, tokenAmount: Number(quote.outAmount), buySol, openedAt: now, sig, tpPct, slPct });
      save();
      appendTrade({ agent: 'pcp-pumpfun', action: 'BUY', mint, symbol: sym, amountSol: buySol, sig,
        reason: `age:${ageMin.toFixed(1)}min liq:$${(liq/1000).toFixed(1)}k ${buys}B/${sells}S`, tpPct, slPct });
      console.log(`[PF] ✅ Entered ${sym}: ${buySol} SOL → ${Number(quote.outAmount).toLocaleString()} tokens`);
      console.log(`[PF] 🔗 https://solscan.io/tx/${sig}`);
    }

    // Always log scan result so we know it's alive
    console.log(`[PF] Scan: ${pairs.length} pairs | age✓:${ageOk} liq✓:${liqOk} pressure✓:${pressureOk} | targets: TP+${tpPct}% SL-${slPct}% size:${buySol}SOL | pos:${positions.length}/${MAX_POSITIONS}`);
  } catch (e: any) { console.error('[PF] Scan error:', e.message); }
}

// ── Exit monitor ──────────────────────────────────────────────────────────────
async function checkExits() {
  if (!positions.length) return;
  const now    = Date.now();
  const exits: PFPosition[] = [];
  const params = loadParams();

  for (const pos of positions) {
    const heldMs  = now - pos.openedAt;
    const force    = heldMs > 180_000;
    const inRetrace = heldMs < RETRACE_MS;
    const q = await getQuote(pos.mint, WSOL, pos.tokenAmount, Math.min(params.MAX_SLIPPAGE_BPS * 10, 500));
    if (!q && !force) continue;

    const curSol = q ? Number(q.outAmount) / 1e9 : 0;
    const pnlPct = ((curSol - pos.buySol) / pos.buySol) * 100;
    const tp     = pnlPct >= pos.tpPct;
    const activeSl = inRetrace ? pos.slPct * 2 : pos.slPct;
    const sl     = pnlPct <= -activeSl;

    if (!tp && !sl && !force) {
      console.log(`[PF] 📊 ${pos.symbol} | ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% | ${(heldMs/1000).toFixed(0)}s | SL:-${activeSl.toFixed(0)}% ${inRetrace ? '🛡️' : ''}`);
      continue;
    }

    const reason = tp ? `TP +${pnlPct.toFixed(1)}%` : sl ? `SL ${pnlPct.toFixed(1)}%` : 'TIME';
    if (q) {
      const sellSig = await execSwap(q, tp ? 5000 : sl ? 25000 : 10000);
      if (sellSig) {
        const pnlSol = curSol - pos.buySol;
        const won = pnlSol >= 0;
        console.log(`[PF] ${won ? '✅ WIN' : '❌ LOSS'} ${pos.symbol} | ${reason} | ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(5)} SOL`);
        console.log(`[PF] 🔗 https://solscan.io/tx/${sellSig}`);
        appendTrade({ agent: 'pcp-pumpfun', action: 'SELL', mint: pos.mint, symbol: pos.symbol,
          amountSol: curSol, pnlSol, sig: sellSig, reason, holdMs: heldMs, tpPct: pos.tpPct, slPct: pos.slPct });
        stats.pnlSol += pnlSol;
        won ? stats.wins++ : stats.losses++;
        tradeLog.push({ success: won, pnlSol });
        if (tradeLog.length > 100) tradeLog = tradeLog.slice(-100); // keep last 100
        if (!won) blacklist.push(pos.mint); // never re-enter rugs
        exits.push(pos);
      }
    } else if (force) {
      console.warn(`[PF] ⚠️ ${pos.symbol} force-dropped (no exit quote)`);
      exits.push(pos);
    }
  }

  if (exits.length) {
    positions = positions.filter(p => !exits.find(e => e.mint === p.mint));
    save();
    const emaWin = tradeLog.length > 3 ? ema(tradeLog.slice(-20).map(t => t.success ? 1 : 0), 10) : 0.5;
    console.log(`[PF] 📈 W:${stats.wins} L:${stats.losses} | PnL:${stats.pnlSol >= 0 ? '+' : ''}${stats.pnlSol.toFixed(5)} SOL | EMA win:${(emaWin*100).toFixed(0)}%`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const params = loadParams();
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  PCP PUMPFUN SNIPER v3 — Strategy-Tuner Aware   ║');
  console.log(`║  Age:<${MAX_AGE_MIN}min | Liq:$${MIN_LIQ/1000}k-$${MAX_LIQ/1000}k | BuyRatio>${MIN_BUY_RATIO}x        ║`);
  console.log(`║  Kelly-sized buys | Base: WSOL (no wrap fees)   ║`);
  console.log(`║  MaxTradeSize:${params.MAX_TRADE_SIZE_SOL} SOL | Slippage:${params.MAX_SLIPPAGE_BPS}bps     ║`);
  console.log('╚══════════════════════════════════════════════════╝');

  if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });

  // Ensure WSOL ATA exists at startup
  try {
    await ensureWsolAta(connection, wallet);
    const wBal = await getWsolBalance(connection, wallet.publicKey);
    console.log(`[PF] 🪙 WSOL balance: ${wBal.toFixed(4)} SOL`);
    if (wBal === 0) await autoRefillWsol(connection, wallet);
  } catch (e: any) {
    console.warn('[PF] WSOL init warning:', e.message);
  }

  await scan();
  setInterval(scan, SCAN_MS);
  setInterval(checkExits, EXIT_MS);
  process.on('SIGTERM', () => { save(); process.exit(0); });
}

main().catch(e => { console.error('[PF] Fatal:', e); process.exit(1); });
