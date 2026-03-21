/**
 * mSOL BASIS ARB EXECUTOR  v1.0
 * ═══════════════════════════════════════════════════════════════════
 *  Buys mSOL when its DEX pool price is cheap vs Marinade NAV.
 *  Holds mSOL (earns ~8% APY staking yield as NAV grows).
 *  Sells when the discount closes back to NAV.
 *
 *  Why it works:
 *    - mSOL is redeemable for SOL at Marinade's on-chain rate (NAV)
 *    - Sell pressure events push pool price below NAV temporarily
 *    - Max 24h hold (if gap doesn't close, sell anyway — staking yield offsets)
 *
 *  NAV source:  api.marinade.finance/msol/price_sol  (grows ~8% APY)
 *  Pool source: Jupiter price v3 (mSOL USD / SOL USD)
 *  Execution:   Jupiter SOL→mSOL (entry) and mSOL→SOL (exit)
 * ═══════════════════════════════════════════════════════════════════
 */
'use strict';
require('dotenv').config();

const nodeFetch  = require('node-fetch');
const { Connection, Keypair, VersionedTransaction, Transaction } = require('@solana/web3.js');
const fs         = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const HELIUS_RPC = process.env.RPC_ENDPOINT || 'https://mainnet.helius-rpc.com/?api-key=df082a16-aebf-4ec4-8ad6-86abfa06c8fc';
const CHAIN_RPC  = 'https://solana-mainnet.core.chainstack.com/95d603f3d634acfbf2ac5a57a32baf97';
const JUP_KEY    = process.env.JUPITER_API_KEY || '05aa94b2-05d5-4993-acfe-30e18dc35ff1';
const JUP_BASE   = 'https://api.jup.ag/swap/v1';
const JUP_H_GET  = { 'x-api-key': JUP_KEY };
const JUP_H      = { 'Content-Type': 'application/json', 'x-api-key': JUP_KEY };
const SOL_MINT   = 'So11111111111111111111111111111111111111112';
const MSOL_MINT  = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So';
const LOG_FILE   = './lst_arb_trades.json';

// ── Tuning ────────────────────────────────────────────────────────────────────
const MIN_BASIS_BPS  = 15;        // 0.15% — entry trigger (pool < NAV by this much)
const EXIT_BASIS_BPS = 3;         // 0.03% — exit when pool almost at NAV
const MAX_HOLD_MS    = 24 * 3600_000; // 24h max hold (staking yield covers cost)
const MIN_HOLD_MS    = 30_000;    // 30s min hold
const CU_PRICE       = 300_000;
const CONFIRM_MS     = 90_000;
const COMPOUND_PCT   = 0.15;      // 15% of SOL balance per entry
const MIN_TRADE_SOL  = 100_000_000;  // 0.1 SOL
const MAX_TRADE_SOL  = 500_000_000;  // 0.5 SOL
const SCAN_MS        = 10_000;   // check every 10s (more patient than CEX/DEX)

// ── State ─────────────────────────────────────────────────────────────────────
let position   = null; // { sig, entrySolLam, entryMsolLam, entryNav, entryPool, basisBps, entryTime }
let netPnlSol  = 0;
let trades     = 0;
let scans      = 0;

const conn      = new Connection(HELIUS_RPC, { commitment: 'confirmed' });
const connChain = new Connection(CHAIN_RPC,  { commitment: 'confirmed' });

function loadWallet() {
  const p = process.env.WALLET_KEYPAIR_PATH || './real_wallet.json';
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p))));
}
const wallet = loadWallet();
function log(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [lst-arb] ${m}`); }

function logTrade(evt) {
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8')); } catch(_) {}
  arr.push({ ts: new Date().toISOString(), ...evt });
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(arr, null, 2)); } catch(_) {}
}

// ── Price feeds ───────────────────────────────────────────────────────────────
async function getMsolNav() {
  try {
    const r = await nodeFetch('https://api.marinade.finance/msol/price_sol', { timeout: 4000 });
    const t = await r.text();
    const p = parseFloat(t);
    if (p > 0) return p;
  } catch(_) {}
  return 0;
}

let _solUsd = 0, _solUsdTs = 0;
async function getSolUsd() {
  if (_solUsd > 0 && Date.now() - _solUsdTs < 30_000) return _solUsd;
  try {
    const r = await nodeFetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { timeout: 5000 });
    const j = await r.json();
    if (j?.solana?.usd > 0) { _solUsd = j.solana.usd; _solUsdTs = Date.now(); return _solUsd; }
  } catch(_) {}
  return _solUsd || 0;
}

async function getMsolPoolPrice() {
  try {
    const [rMsol, solUsd] = await Promise.all([
      nodeFetch(`https://api.jup.ag/price/v3?ids=${MSOL_MINT}`, { headers: JUP_H_GET, timeout: 4000 }).then(r => r.json()),
      getSolUsd(),
    ]);
    const msolUsd = parseFloat(rMsol?.[MSOL_MINT]?.usdPrice) || 0;
    if (!msolUsd || !solUsd) return 0;
    return msolUsd / solUsd; // SOL per 1 mSOL (pool-derived)
  } catch(_) { return 0; }
}

function getBasisBps(nav, pool) {
  if (!nav || !pool) return 0;
  return Math.round(((nav - pool) / nav) * 10_000); // positive = pool cheap vs NAV
}

// ── Quote + Swap ──────────────────────────────────────────────────────────────
async function jupQuote(inMint, outMint, amountLam) {
  const url = `${JUP_BASE}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amountLam}&swapMode=ExactIn&dynamicSlippage=true`;
  const r   = await nodeFetch(url, { headers: JUP_H_GET, timeout: 4000 });
  const j   = await r.json();
  if (!j?.outAmount) throw new Error(`Quote failed: ${JSON.stringify(j).slice(0,80)}`);
  return j;
}

async function jupSwap(quoteResponse, label) {
  const body = {
    quoteResponse,
    userPublicKey:                 wallet.publicKey.toBase58(),
    wrapAndUnwrapSol:              true,
    computeUnitPriceMicroLamports: CU_PRICE,
    dynamicComputeUnitLimit:       true,
    dynamicSlippage:               { maxBps: 300 },
  };
  const r = await nodeFetch(`${JUP_BASE}/swap`, { method: 'POST', headers: JUP_H, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Swap HTTP ${r.status}`);
  const j = await r.json();
  if (!j.swapTransaction) throw new Error(`No swapTx: ${JSON.stringify(j).slice(0,80)}`);

  const buf = Buffer.from(j.swapTransaction, 'base64');
  let tx; try { tx = VersionedTransaction.deserialize(buf); } catch(_) { tx = Transaction.from(buf); }
  tx.sign([wallet]);
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
  log(`📤 ${label} → https://solscan.io/tx/${sig}`);

  const deadline = Date.now() + CONFIRM_MS;
  const rsIv = setInterval(async () => {
    if (Date.now() > deadline) return;
    try { await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }); } catch(_) {}
  }, 5_000);

  try {
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const [h, c] = await Promise.allSettled([
        conn.getSignatureStatus(sig,      { searchTransactionHistory: true }),
        connChain.getSignatureStatus(sig, { searchTransactionHistory: true }),
      ]);
      for (const res of [h, c]) {
        if (res.status !== 'fulfilled') continue;
        const st = res.value?.value;
        if (!st) continue;
        if (st.err) throw new Error(`${label} on-chain err: ${JSON.stringify(st.err)}`);
        if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
          clearInterval(rsIv);
          log(`✅ ${label} confirmed → https://solscan.io/tx/${sig}`);
          return { sig, outAmount: parseInt(quoteResponse.outAmount) };
        }
      }
    }
    throw new Error(`${label} timed out`);
  } catch(e) { clearInterval(rsIv); throw e; }
}

// ── Entry: SOL → mSOL (buy cheap mSOL) ───────────────────────────────────────
async function enter(nav, pool, basisBps) {
  log(`🟢 ENTRY mSOL basis=${basisBps}bps | NAV=${nav.toFixed(5)} Pool=${pool.toFixed(5)}`);
  const solBal   = await conn.getBalance(wallet.publicKey);
  const tradeLam = Math.min(MAX_TRADE_SOL, Math.max(MIN_TRADE_SOL, Math.floor(solBal * COMPOUND_PCT)));
  if (solBal - tradeLam < 10_000_000) { log('⚠️  Low SOL balance'); return; }

  const q   = await jupQuote(SOL_MINT, MSOL_MINT, tradeLam);
  log(`Quote: ${(tradeLam/1e9).toFixed(4)} SOL → ${(q.outAmount/1e9).toFixed(5)} mSOL`);
  const res = await jupSwap(q, 'ENTRY SOL→mSOL');

  position = {
    sig:          res.sig,
    entrySolLam:  tradeLam,
    entryMsolLam: res.outAmount,
    entryNav:     nav,
    entryPool:    pool,
    entryBasis:   basisBps,
    entryTime:    Date.now(),
  };
  log(`📊 Holding ${(res.outAmount/1e9).toFixed(5)} mSOL — earning ~8% APY staking yield while waiting for NAV gap to close`);
}

// ── Exit: mSOL → SOL (sell mSOL when gap closes) ─────────────────────────────
async function exitPos(reason, nav, pool) {
  if (!position) return;
  const holdMs = Date.now() - position.entryTime;
  const holdHrs = (holdMs / 3_600_000).toFixed(2);
  log(`🔴 EXIT(${reason}) held=${holdHrs}h | NAV=${nav.toFixed(5)} Pool=${pool.toFixed(5)}`);

  const q   = await jupQuote(MSOL_MINT, SOL_MINT, position.entryMsolLam);
  const res = await jupSwap(q, 'EXIT mSOL→SOL');
  const pnlSol = (res.outAmount - position.entrySolLam) / 1e9;
  netPnlSol   += pnlSol;
  trades++;

  log(`${pnlSol >= 0 ? '💰' : '📉'} PnL=${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(6)} SOL | Net=${netPnlSol >= 0 ? '+' : ''}${netPnlSol.toFixed(6)} SOL | trades=${trades}`);
  logTrade({ reason, holdMs, entryBasis: position.entryBasis, pnlSol, netPnlSol });
  position = null;
}

// ── Monitor ───────────────────────────────────────────────────────────────────
async function monitor() {
  scans++;
  const [nav, pool] = await Promise.all([getMsolNav(), getMsolPoolPrice()]);
  if (!nav || !pool) { log(`⏳ Waiting for price data (nav=${nav} pool=${pool})`); return; }

  const basisBps = getBasisBps(nav, pool);
  const holdMs   = position ? Date.now() - position.entryTime : 0;

  log(`📊 mSOL NAV=${nav.toFixed(5)} Pool=${pool.toFixed(5)} basis=${basisBps}bps ${position ? `[IN hold=${(holdMs/1000).toFixed(0)}s entry=${position.entryBasis}bps]` : '[flat]'}`);

  if (position) {
    const shouldExit =
      basisBps <= EXIT_BASIS_BPS   ||   // gap closed — target hit
      basisBps < -MIN_BASIS_BPS    ||   // pool now ABOVE NAV (sell at premium)
      holdMs > MAX_HOLD_MS;             // 24h time stop

    if (shouldExit && holdMs >= MIN_HOLD_MS) {
      const reason = holdMs > MAX_HOLD_MS ? 'TIME_STOP' : basisBps < 0 ? 'PREMIUM' : 'TARGET';
      try { await exitPos(reason, nav, pool); }
      catch(e) { log(`Exit err: ${e.message}`); }
    }
    return;
  }

  // Entry: pool cheap vs NAV
  if (basisBps >= MIN_BASIS_BPS) {
    try { await enter(nav, pool, basisBps); }
    catch(e) { log(`Entry err: ${e.message}`); }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('═══════════════════════════════════════════════════');
  log('  mSOL BASIS ARB EXECUTOR  v1.0');
  log(`  Wallet:   ${wallet.publicKey.toString().slice(0,8)}...`);
  log(`  Entry:    pool < NAV by >= ${MIN_BASIS_BPS}bps → buy mSOL (SOL→mSOL)`);
  log(`  Exit:     gap <= ${EXIT_BASIS_BPS}bps OR 24h hold → sell mSOL (mSOL→SOL)`);
  log(`  Yield:    ~8% APY staking rewards accrue while holding`);
  log(`  Size:     ${COMPOUND_PCT*100}% SOL [${MIN_TRADE_SOL/1e9}–${MAX_TRADE_SOL/1e9} SOL]`);
  log('═══════════════════════════════════════════════════');

  await monitor(); // immediate scan on start

  setInterval(async () => {
    try { await monitor(); } catch(e) { log(`Monitor err: ${e.message}`); }
  }, SCAN_MS);

  setInterval(() => {
    log(`⏱  trades=${trades} netPnlSOL=${netPnlSol >= 0 ? '+' : ''}${netPnlSol.toFixed(6)} scans=${scans} ${position ? `[IN pos since ${((Date.now()-position.entryTime)/3600000).toFixed(2)}h]` : ''}`);
  }, 300_000); // status every 5 min
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
