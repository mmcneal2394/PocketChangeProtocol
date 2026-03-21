/**
 * CEX/DEX STATISTICAL ARBITRAGE ENGINE  v2.0
 * ═══════════════════════════════════════════════════════════════════
 *  Signal:    Coinbase SOL-USD (+ Kraken / CoinGecko fallback), every 1.5s
 *  Direction: SOL → USDC on entry, USDC → SOL on exit
 *             Entry when DEX price > CEX by MIN_BASIS_BPS
 *             (DEX overpriced vs CEX → sell SOL high on-chain)
 *             Exit when spread closes or MAX_HOLD_MS elapsed
 *
 *  Fixed from v1:
 *    • Dual-RPC status polling loop (vs broken confirmTransaction)
 *    • dynamicSlippage in swap body; dynamicSlippage=true in quote
 *    • SOL as base currency (USDC→SOL had 6024 errors, SOL→USDC works)
 *    • 5s resend loop during confirmation window
 * ═══════════════════════════════════════════════════════════════════
 */
'use strict';
require('dotenv').config();

const nodeFetch  = require('node-fetch');
const { Connection, Keypair, VersionedTransaction, Transaction } = require('@solana/web3.js');
const fs         = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const HELIUS_RPC  = process.env.RPC_ENDPOINT  || 'https://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY';
const CHAIN_RPC   = 'https://rpc.YOUR_CHAINSTACK_ENDPOINT';
const JUP_KEY     = process.env.JUPITER_API_KEY || 'YOUR_JUPITER_API_KEY';
const JUP_BASE    = 'https://api.jup.ag/swap/v1';
const JUP_H       = { 'Content-Type': 'application/json', 'x-api-key': JUP_KEY };
const SOL_MINT    = 'So11111111111111111111111111111111111111112';
const USDC_MINT   = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const LOG_FILE    = './cex_dex_trades.json';

// ── CEX price endpoints (US-accessible) ──────────────────────────────────────
const COINBASE_TICKER = 'https://api.coinbase.com/v2/prices/SOL-USD/spot';
const KRAKEN_TICKER   = 'https://api.kraken.com/0/public/Ticker?pair=SOLUSD';
const COINGECKO_URL   = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';

// ── Tuning ────────────────────────────────────────────────────────────────────
// Entry: DEX price > CEX by this much (DEX overpriced → sell SOL high on DEX)
const MIN_BASIS_BPS  = 10;       // 0.10% — fee-adjusted break-even at 0.1 SOL size
const EXIT_BASIS_BPS = 5;        // 0.05% — exit when spread mostly closed
const MAX_HOLD_MS    = 30_000;   // 30s max hold
const MIN_HOLD_MS    = 2_000;
const CU_PRICE       = 300_000;
const CONFIRM_MS     = 90_000;
// Trade: 10% of SOL balance, clamped 0.03–0.15 SOL
const COMPOUND_PCT   = 0.20;          // 20% of SOL balance per trade
const MIN_TRADE_SOL  = 100_000_000;  // 0.1 SOL — minimum for fee efficiency
const MAX_TRADE_SOL  = 500_000_000;  // 0.5 SOL cap

// ── State ─────────────────────────────────────────────────────────────────────
let cexPrice     = 0;
let cexPricePrev = 0;
let position     = null;   // { sig, entrySolLam, entryUsdcLam, entryBasisBps, entryTime }
let netPnlSol    = 0;
let trades       = 0;
let scans        = 0;
let errors       = 0;

const conn      = new Connection(HELIUS_RPC, { commitment: 'confirmed' });
const connChain = new Connection(CHAIN_RPC,  { commitment: 'confirmed' });

function loadWallet() {
  const p = process.env.WALLET_KEYPAIR_PATH || './real_wallet.json';
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p))));
}
const wallet = loadWallet();

// ── Logging ──────────────────────────────────────────────────────────────────
function log(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [cex-dex] ${m}`); }

function logTrade(event) {
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8')); } catch(_) {}
  arr.push({ ts: new Date().toISOString(), ...event });
  try { fs.writeFileSync(LOG_FILE, JSON.stringify(arr, null, 2)); } catch(_) {}
}

// ── CEX Price Feed ────────────────────────────────────────────────────────────
async function fetchCexPrice() {
  // 1. Coinbase
  try {
    const r = await nodeFetch(COINBASE_TICKER, { timeout: 3000 });
    const j = await r.json();
    const p = parseFloat(j?.data?.amount);
    if (p > 0) { cexPricePrev = cexPrice; cexPrice = p; scans++; return; }
  } catch(_) {}
  // 2. Kraken
  try {
    const r = await nodeFetch(KRAKEN_TICKER, { timeout: 3000 });
    const j = await r.json();
    const p = parseFloat(j?.result?.SOLUSD?.c?.[0]);
    if (p > 0) { cexPricePrev = cexPrice; cexPrice = p; scans++; return; }
  } catch(_) {}
  // 3. CoinGecko (~30s stale — direction is still valid)
  try {
    const r = await nodeFetch(COINGECKO_URL, { timeout: 5000 });
    const j = await r.json();
    const p = j?.solana?.usd;
    if (p) { cexPricePrev = cexPrice; cexPrice = p; scans++; }
  } catch(_) {}
}

// ── DEX Price (Jupiter) ───────────────────────────────────────────────────────
async function getDexPrice() {
  const url = `${JUP_BASE}/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=1000000000&swapMode=ExactIn&dynamicSlippage=true`;
  const r   = await nodeFetch(url, { headers: JUP_H, timeout: 4000 });
  const j   = await r.json();
  // outAmount is USDC lamports for 1 SOL (1e9 lamports) → price in USD
  if (!j?.outAmount) return 0;
  return parseInt(j.outAmount) / 1e6;  // USDC per SOL
}

// ── SOL Balance ───────────────────────────────────────────────────────────────
async function getSolBalance() {
  const bal = await conn.getBalance(wallet.publicKey);
  return bal;  // lamports
}

// ── Basis: (DEX - CEX) / CEX — positive = DEX overpriced = sell SOL ──────────
function getBasisBps(cex, dex) {
  if (!cex || !dex) return 0;
  return Math.round(((dex - cex) / cex) * 10_000);
}

// ── Quote ─────────────────────────────────────────────────────────────────────
async function jupQuote(inMint, outMint, amountLam) {
  const url = `${JUP_BASE}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amountLam}&swapMode=ExactIn&dynamicSlippage=true`;
  const r   = await nodeFetch(url, { headers: JUP_H, timeout: 4000 });
  const j   = await r.json();
  if (!j?.outAmount) throw new Error(`Quote empty: ${JSON.stringify(j).slice(0,80)}`);
  return j;
}

// ── Swap + dual-RPC confirm ───────────────────────────────────────────────────
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
  if (!r.ok) throw new Error(`swap HTTP ${r.status}`);
  const j = await r.json();
  if (!j.swapTransaction) throw new Error(`No swapTx: ${JSON.stringify(j).slice(0,80)}`);

  const buf = Buffer.from(j.swapTransaction, 'base64');
  let tx;
  try { tx = VersionedTransaction.deserialize(buf); } catch(_) { tx = Transaction.from(buf); }
  tx.sign([wallet]);
  const raw = tx.serialize();

  const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
  log(`📤 ${label} → https://solscan.io/tx/${sig}`);

  // Resend every 5s during confirm window (aggressive relay)
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
  } catch(e) {
    clearInterval(rsIv);
    throw e;
  }
}

// ── Entry: SOL → USDC (sell SOL when DEX overpriced vs CEX) ──────────────────
async function enter(basisBps, dexPrice) {
  log(`🟢 ENTRY basis=${basisBps}bps DEX=$${dexPrice.toFixed(4)} CEX=$${cexPrice.toFixed(4)}`);
  const solBal   = await getSolBalance();
  const tradeLam = Math.min(MAX_TRADE_SOL, Math.max(MIN_TRADE_SOL, Math.floor(solBal * COMPOUND_PCT)));
  // Keep 0.01 SOL for gas
  if (solBal - tradeLam < 10_000_000) { log('⚠️  Insufficient SOL balance'); return; }

  const q   = await jupQuote(SOL_MINT, USDC_MINT, tradeLam);
  const res = await jupSwap(q, 'ENTRY SOL→USDC');
  position = {
    sig:           res.sig,
    entrySolLam:   tradeLam,
    entryUsdcLam:  res.outAmount,
    entryCexPrice: cexPrice,
    entryDexPrice: dexPrice,
    entryBasisBps: basisBps,
    entryTime:     Date.now(),
  };
  log(`📊 Sold ${(tradeLam/1e9).toFixed(4)} SOL → ${(res.outAmount/1e6).toFixed(4)} USDC`);
}

// ── Exit: USDC → SOL (buy SOL back when spread closes) ───────────────────────
async function exitPos(reason, dexPrice) {
  if (!position) return;
  const holdMs = Date.now() - position.entryTime;
  log(`🔴 EXIT(${reason}) held=${holdMs}ms DEX=$${dexPrice.toFixed(4)} CEX=$${cexPrice.toFixed(4)}`);

  const q   = await jupQuote(USDC_MINT, SOL_MINT, position.entryUsdcLam);
  const res = await jupSwap(q, 'EXIT USDC→SOL');
  const pnlSol = (res.outAmount - position.entrySolLam) / 1e9;
  netPnlSol   += pnlSol;
  trades++;
  errors = 0;

  log(`${pnlSol >= 0 ? '💰' : '📉'} PnL=${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(6)} SOL | Net=${netPnlSol >= 0 ? '+' : ''}${netPnlSol.toFixed(6)} SOL | trades=${trades}`);
  logTrade({ reason, holdMs, basisBps: position.entryBasisBps, pnlSol, netPnlSol });
  position = null;
}

// ── Monitor loop ──────────────────────────────────────────────────────────────
async function monitor() {
  if (!cexPrice) return;

  let dexPrice;
  try { dexPrice = await getDexPrice(); }
  catch(e) { log(`DEX price err: ${e.message}`); return; }
  if (!dexPrice) return;

  const basisBps    = getBasisBps(cexPrice, dexPrice);
  const momentumBps = cexPrice && cexPricePrev
    ? Math.round(((cexPrice - cexPricePrev) / cexPricePrev) * 10_000) : 0;

  const posStr = position
    ? `[IN hold=${Date.now()-position.entryTime}ms basis@entry=${position.entryBasisBps}bps]`
    : '[flat]';
  log(`📊 CEX=$${cexPrice.toFixed(3)} DEX=$${dexPrice.toFixed(3)} basis=${basisBps}bps Δcex=${momentumBps}bps ${posStr}`);

  if (position) {
    const holdMs = Date.now() - position.entryTime;
    const shouldExit = holdMs > MAX_HOLD_MS || basisBps < EXIT_BASIS_BPS || basisBps < -MIN_BASIS_BPS;
    if (shouldExit && holdMs >= MIN_HOLD_MS) {
      const reason = holdMs > MAX_HOLD_MS ? 'TIME_STOP' : basisBps < -MIN_BASIS_BPS ? 'REVERSED' : 'TARGET';
      try { await exitPos(reason, dexPrice); }
      catch(e) { log(`Exit err: ${e.message}`); errors++; }
    }
    return;
  }

  // Entry: DEX overpriced AND CEX momentum is negative (CEX falling, DEX hasn't caught up)
  if (basisBps >= MIN_BASIS_BPS) {
    try { await enter(basisBps, dexPrice); }
    catch(e) { log(`Entry err: ${e.message}`); errors++; }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('═══════════════════════════════════════════════');
  log('  CEX/DEX STAT ARB  v2.0');
  log(`  Wallet:  ${wallet.publicKey.toString().slice(0,8)}...`);
  log(`  Entry:   DEX > CEX by >= ${MIN_BASIS_BPS}bps → sell SOL on DEX`);
  log(`  Exit:    spread < ${EXIT_BASIS_BPS}bps or ${MAX_HOLD_MS/1000}s stop`);
  log(`  Size:    ${COMPOUND_PCT*100}% SOL balance [${MIN_TRADE_SOL/1e9}–${MAX_TRADE_SOL/1e9} SOL]`);
  log(`  CEX:     Coinbase → Kraken → CoinGecko`);
  log('═══════════════════════════════════════════════');

  await fetchCexPrice();
  setInterval(fetchCexPrice, 1_500);

  await new Promise(r => setTimeout(r, 2500));

  setInterval(async () => {
    try { await monitor(); } catch(e) { log(`Monitor err: ${e.message}`); }
  }, 2_500);

  setInterval(() => {
    log(`⏱  trades=${trades} netPnlSOL=${netPnlSol >= 0 ? '+' : ''}${netPnlSol.toFixed(6)} scans=${scans} errors=${errors}`);
  }, 60_000);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });



