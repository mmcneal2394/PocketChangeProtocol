/**
 * 5-MINUTE ARB CONFIRMATION TEST
 * ================================
 * Standalone 5-minute run using arb_realtime core logic.
 * P&L tracked via getBalance(wallet) BEFORE first leg and AFTER
 * second leg confirms — this is immune to WSOL accounting artifacts.
 *
 * Why: Jupiter SOL→TOKEN routes via wrapped SOL (WSOL). getTxDelta on
 * individual legs only captures the priority fee change on the native
 * account, not the full SOL outflow. getBalance is the ground truth.
 *
 * Usage: node scripts/arb5min_confirm.js
 */

'use strict';
require('dotenv').config();
const nodeFetch = require('node-fetch');
const { Connection, Keypair, VersionedTransaction, Transaction } = require('@solana/web3.js');
const fs = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const HELIUS_RPC  = process.env.RPC_ENDPOINT || 'https://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY';
const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH || './real_wallet.json';
const API_KEY     = process.env.JUPITER_API_KEY || '';
const ULTRA       = 'https://lite-api.jup.ag/ultra/v1';
const QUOTE_API   = 'https://lite-api.jup.ag/swap/v1';
const SOL_MINT    = 'So11111111111111111111111111111111111111112';

const TRADE_SOL      = 0.15;
const TRADE_LAM      = Math.floor(TRADE_SOL * 1e9);
const ULTRA_FEE_CAL  = 0.000070;   // confirmed on-chain avg cost per round-trip
const MIN_PROFIT_LAM = 5_000;      // 0.000005 SOL net minimum
const SLIP_BPS       = 20;
const COOLDOWN_MS    = 6_000;
const SCAN_DELAY_MS  = 700;
const RUN_MS         = 5 * 60 * 1000;
const EXCLUDE        = encodeURIComponent('GoonFi V2,AlphaQ,SolFi V2,BisonFi,HumidiFi');

const HOT_TOKENS = [
  { symbol: 'USDC',    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'USDT',    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'  },
  { symbol: 'jitoSOL', mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn' },
];

const conn   = new Connection(HELIUS_RPC, { commitment: 'confirmed' });
const raw    = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
const wallet = Keypair.fromSecretKey(new Uint8Array(raw));

let lastQuoteCall = 0, lastUltraCall = 0;
const lastTradeAt = {};

// ── API helpers ───────────────────────────────────────────────────────────────
async function qFetch(url) {
  const gap = Date.now() - lastQuoteCall;
  if (gap < 500) await new Promise(r => setTimeout(r, 500 - gap));
  lastQuoteCall = Date.now();
  const r = await nodeFetch(url, { headers: { 'x-api-key': API_KEY } });
  if (r.status === 429) throw new Error('RATE_LIMITED');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function uFetch(url, opts={}) {
  const gap = Date.now() - lastUltraCall;
  if (gap < SCAN_DELAY_MS) await new Promise(r => setTimeout(r, SCAN_DELAY_MS - gap));
  lastUltraCall = Date.now();
  let tries = 0;
  while (tries < 3) {
    try {
      const r = await nodeFetch(url, { ...opts, headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json', ...(opts.headers||{}) } });
      if (r.status === 429) { tries++; console.log('  ⚠️  429 — waiting 5s'); await new Promise(r => setTimeout(r, 5000)); continue; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    } catch(e) { tries++; if (tries >= 3) throw e; await new Promise(r => setTimeout(r, 1000)); }
  }
}

// ── Scan via /quote (no wallet balance needed) ────────────────────────────────
async function scanToken(symbol, mint) {
  if (lastTradeAt[symbol] && Date.now() - lastTradeAt[symbol] < COOLDOWN_MS) return null;
  try {
    const q1 = await qFetch(`${QUOTE_API}/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${TRADE_LAM}&slippageBps=${SLIP_BPS}&excludeDexes=${EXCLUDE}`);
    if (!q1?.outAmount) return null;
    const out1 = Number(q1.outAmount);
    const q2   = await qFetch(`${QUOTE_API}/quote?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${out1}&slippageBps=${SLIP_BPS}&excludeDexes=${EXCLUDE}`);
    if (!q2?.outAmount) return null;
    const out2    = Number(q2.outAmount);
    const gross   = out2 - TRADE_LAM;
    const net     = gross - Math.floor(ULTRA_FEE_CAL * 1e9);
    return { symbol, mint, out1, gross, grossSol: gross/1e9, net, netSol: net/1e9 };
  } catch(e) { if (!e.message.includes('RATE')) console.log(`  ⚠️  scan ${symbol}: ${e.message.slice(0,60)}`); return null; }
}

// ── Execute via Ultra (fetch fresh order at execution time) ───────────────────
async function executeOrders(opp) {
  const o1 = await uFetch(`${ULTRA}/order?inputMint=${SOL_MINT}&outputMint=${opp.mint}&amount=${TRADE_LAM}&slippageBps=${SLIP_BPS}&taker=${wallet.publicKey.toBase58()}&excludeDexes=${EXCLUDE}`);
  if (!o1?.transaction) throw new Error(`LEG1: ${o1?.error || 'no tx'}`);
  let tx1; try { tx1 = VersionedTransaction.deserialize(Buffer.from(o1.transaction, 'base64')); } catch(_) { tx1 = Transaction.from(Buffer.from(o1.transaction, 'base64')); }
  tx1.sign([wallet]);
  const exec1 = await uFetch(`${ULTRA}/execute`, { method:'POST', body: JSON.stringify({ signedTransaction: Buffer.from(tx1.serialize()).toString('base64'), requestId: o1.requestId }) });
  if (exec1?.status !== 'Success') throw new Error(`LEG1 execute: ${exec1?.error || exec1?.status}`);

  const realOut1 = Number(exec1.outputAmount || opp.out1);
  const o2 = await uFetch(`${ULTRA}/order?inputMint=${opp.mint}&outputMint=${SOL_MINT}&amount=${realOut1}&slippageBps=${SLIP_BPS}&taker=${wallet.publicKey.toBase58()}&excludeDexes=${EXCLUDE}`);
  if (!o2?.transaction) throw new Error(`LEG2: ${o2?.error || 'no tx'}`);
  let tx2; try { tx2 = VersionedTransaction.deserialize(Buffer.from(o2.transaction, 'base64')); } catch(_) { tx2 = Transaction.from(Buffer.from(o2.transaction, 'base64')); }
  tx2.sign([wallet]);
  const exec2 = await uFetch(`${ULTRA}/execute`, { method:'POST', body: JSON.stringify({ signedTransaction: Buffer.from(tx2.serialize()).toString('base64'), requestId: o2.requestId }) });
  if (exec2?.status !== 'Success') throw new Error(`LEG2 execute: ${exec2?.error || exec2?.status}`);
  return { sig1: exec1.signature, sig2: exec2.signature };
}

// ── Wait for tx confirmation then return balance ──────────────────────────────
async function waitAndBalance(sig, label) {
  // Poll until confirmed
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const status = await conn.getSignatureStatus(sig);
      const conf   = status?.value?.confirmationStatus;
      if (conf === 'confirmed' || conf === 'finalized') {
        const bal = await conn.getBalance(wallet.publicKey);
        console.log(`  [${label}] Confirmed ✅  Balance: ${(bal/1e9).toFixed(6)} SOL`);
        return bal;
      }
    } catch(_) {}
  }
  const bal = await conn.getBalance(wallet.publicKey);
  console.log(`  [${label}] Timeout — Balance: ${(bal/1e9).toFixed(6)} SOL`);
  return bal;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const balStart = await conn.getBalance(wallet.publicKey);
  const startSol = balStart / 1e9;
  const endTime  = Date.now() + RUN_MS;
  const trades   = [];
  let scanCount  = 0, trueRunningPnl = 0;
  let bestGross  = -999, bestToken = '';

  console.log('\n' + '═'.repeat(72));
  console.log('  ⚡ 5-MINUTE ARB CONFIRMATION TEST');
  console.log('═'.repeat(72));
  console.log(`  Wallet:         ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance START:  ${startSol.toFixed(6)} SOL  ← ground truth`);
  console.log(`  Trade size:     ${TRADE_SOL} SOL`);
  console.log(`  ULTRA_FEE_CAL:  ${ULTRA_FEE_CAL} SOL (confirmed on-chain avg)`);
  console.log(`  MIN_PROFIT:     +${(MIN_PROFIT_LAM/1e9).toFixed(6)} SOL net`);
  console.log(`  P&L method:     getBalance(wallet) BEFORE → AFTER per trade pair`);
  console.log('═'.repeat(72) + '\n');

  while (Date.now() < endTime) {
    const remaining = Math.round((endTime - Date.now()) / 1000);
    const elapsed   = Math.round((Date.now() - (endTime - RUN_MS)) / 1000);

    // Parallel scan all 3 hot tokens
    const results = await Promise.all(HOT_TOKENS.map(({ symbol, mint }) => scanToken(symbol, mint)));
    scanCount++;
    results.filter(Boolean).forEach(r => { if (r.grossSol > bestGross) { bestGross = r.grossSol; bestToken = r.symbol; } });

    const viable = results.filter(r => r !== null && r.net >= MIN_PROFIT_LAM).sort((a,b) => b.net-a.net);

    if (scanCount % 5 === 0) {
      process.stdout.write(`\r  [${elapsed}s/${remaining}s] scans:${scanCount} | trades:${trades.length} | true P&L:${trueRunningPnl>=0?'+':''}${trueRunningPnl.toFixed(5)} | best gross: ${bestGross>=0?'+':''}${bestGross.toFixed(5)} on ${bestToken||'?'}`);
    }

    if (!viable.length) { await new Promise(r => setTimeout(r, 500)); continue; }

    const best = viable[0];
    const elapsed2 = Math.round((Date.now() - (endTime - RUN_MS)) / 1000);
    process.stdout.write('\n');
    console.log(`\n  [${elapsed2}s] 🎯 Signal: ${best.symbol}  gross:+${best.grossSol.toFixed(6)} net(est):+${best.netSol.toFixed(6)} SOL`);

    // TRUE P&L: getBalance BEFORE execution
    const balBefore = await conn.getBalance(wallet.publicKey);
    console.log(`  Balance BEFORE: ${(balBefore/1e9).toFixed(6)} SOL`);

    lastTradeAt[best.symbol] = Date.now();
    try {
      const t0  = Date.now();
      const res = await executeOrders(best);
      const execMs = Date.now() - t0;
      console.log(`  🔗 LEG1: https://solscan.io/tx/${res.sig1}`);
      console.log(`  🔗 LEG2: https://solscan.io/tx/${res.sig2}  (${execMs}ms submit)`);

      // TRUE P&L: getBalance AFTER leg2 confirms
      const balAfter = await waitAndBalance(res.sig2, 'LEG2');
      const trueNet  = (balAfter - balBefore) / 1e9;
      trueRunningPnl += trueNet;
      const icon = trueNet > 0 ? '✅ TRUE PROFIT' : trueNet === 0 ? '⚠️  FLAT' : '📉 TRUE LOSS';
      console.log(`  ${icon}  ${(balBefore/1e9).toFixed(6)} → ${(balAfter/1e9).toFixed(6)} SOL  delta:${trueNet>=0?'+':''}${trueNet.toFixed(6)}`);
      console.log(`  Est was +${best.netSol.toFixed(6)} | Actual: ${trueNet>=0?'+':''}${trueNet.toFixed(6)} | Diff: ${(trueNet - best.netSol >= 0?'+':'')+(trueNet - best.netSol).toFixed(6)}`);
      console.log(`  Cumulative TRUE P&L: ${trueRunningPnl>=0?'+':''}${trueRunningPnl.toFixed(6)} SOL\n`);
      trades.push({ symbol: best.symbol, grossSol: best.grossSol, estNet: best.netSol, trueNet, sig1: res.sig1, sig2: res.sig2 });
    } catch(e) {
      console.log(`  ❌ ${e.message.slice(0,140)}`);
      trades.push({ symbol: best.symbol, grossSol: best.grossSol, estNet: best.netSol, error: e.message });
    }
  }

  // ── Final ─────────────────────────────────────────────────────────────────
  const balEnd = await conn.getBalance(wallet.publicKey);
  const totalReal = (balEnd - balStart) / 1e9;

  console.log('\n\n' + '═'.repeat(72));
  console.log('  📊 5-MINUTE CONFIRMATION REPORT');
  console.log('═'.repeat(72));
  console.log(`  Balance:    ${startSol.toFixed(6)} → ${(balEnd/1e9).toFixed(6)} SOL`);
  console.log(`  TRUE P&L:   ${totalReal>=0?'✅ +':'📉 '}${totalReal.toFixed(6)} SOL  ← actual wallet delta`);
  console.log(`  Est P&L:    +${trades.filter(t=>!t.error).reduce((s,t)=>s+t.estNet,0).toFixed(6)} SOL  (pre-execution estimate)`);
  console.log(`  Scans:      ${scanCount}`);
  console.log(`  Trades:     ${trades.length} (${trades.filter(t=>t.trueNet>0).length}✅ ${trades.filter(t=>t.trueNet<0&&!t.error).length}📉 ${trades.filter(t=>t.error).length}❌)`);
  console.log(`  Best gross: ${bestGross>=0?'+':''}${bestGross.toFixed(6)} SOL on ${bestToken}`);
  console.log('─'.repeat(72));
  if (trades.length > 0) {
    console.log('\n  PER-TRADE:');
    trades.forEach((t,i) => {
      if (t.error) { console.log(`  [${i+1}] ❌ ${t.symbol} → ${t.error.slice(0,60)}`); return; }
      const icon = t.trueNet>0?'✅':t.trueNet===0?'⚠️ ':'📉';
      console.log(`  [${i+1}] ${icon} ${t.symbol}  gross:+${t.grossSol.toFixed(6)}  est:+${t.estNet.toFixed(6)}  TRUE:${t.trueNet>=0?'+':''}${t.trueNet.toFixed(6)}`);
      console.log(`       sig1: https://solscan.io/tx/${t.sig1}`);
      console.log(`       sig2: https://solscan.io/tx/${t.sig2}`);
    });
  }
  console.log('\n' + '═'.repeat(72) + '\n');
  fs.writeFileSync('./arb5min_confirm_result.json', JSON.stringify({ balStart: startSol, balEnd: balEnd/1e9, totalReal, scanCount, trades }, null, 2));
  console.log('  📄 arb5min_confirm_result.json');
}
main().catch(e => { console.error('\n❌ FATAL:', e.message); process.exit(1); });
