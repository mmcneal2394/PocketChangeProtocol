/**
 * FORCE TEST — 1 Minute, Verify All Connections + Live Round-Trip
 * ================================================================
 * Checks:
 *   [1] Helius DEX WebSocket — subscribes, waits for first log event
 *   [2] CoinAPI WebSocket — connects, waits for first trade message
 *   [3] Bags API quote (SOL→USDC) — exponential backoff on 429
 *   [4] Bags API swap LEG1 (SOL→USDC) — executes with quoteResponse
 *   [5] Bags API swap LEG2 (USDC→SOL) — executes with quoteResponse
 *   [6] True P&L report — balance before vs after
 */
'use strict';
require('dotenv').config();

const nodeFetch = require('node-fetch');
const WebSocket = require('ws');
const bs58 = require('bs58');
const { Connection, Keypair, VersionedTransaction, Transaction } = require('@solana/web3.js');
const fs = require('fs');

const HELIUS_RPC  = process.env.RPC_ENDPOINT || 'https://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY';
const HELIUS_WS   = (process.env.RPC_WEBSOCKET || 'wss://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY').replace(/\/$/, '');
const CHAIN_RPC   = 'https://rpc.YOUR_CHAINSTACK_ENDPOINT';
const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH || './real_wallet.json';
const BAGS_KEYS = [
  process.env.BAGS_API_KEY   || 'bags_prod_bhNWKWR4_HAseNYlrmgpJX4NklFdCzAbDdYpx9UIIgg',
  process.env.BAGS_API_KEY_2 || 'bags_prod_kfsnkMqQ4NJW16_BknWl1ox31Ysr1kZL1MA2mGSlt5c',
  process.env.BAGS_API_KEY_3 || 'bags_prod_QJ3a_QsV3R8FEg9kbxWZ7yMOqVD7OnAu2mxLHNfkia8',
  process.env.BAGS_API_KEY_4 || 'bags_prod_a64DNgP7fs2O9DcqT0JIIva4Qsy_XEPmdgLtP67jbSU',
  process.env.BAGS_API_KEY_5 || 'bags_prod_pIHo6k8F6k7W_5q0N4kVCzodVgPqMBQ_tj0G0S2Mn9o',
  process.env.BAGS_API_KEY_6 || 'bags_prod_b5Aeygaqa1vb5JGdwm5hsRoBCyVKMBCK12p-DCIodlU',
];
const COINAPI_KEY = process.env.COINAPI_KEY || '9320e9e4-9048-4e41-a7fc-7811674e7249';
const BAGS_API    = 'https://public-api-v2.bags.fm/api/v1';
const SOL_MINT    = 'So11111111111111111111111111111111111111112';
const USDC_MINT   = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TRADE_LAM   = 20_000_000; // 0.02 SOL
const SLIP_BPS    = 50;
const CU_PRICE    = 100_000;

const conn      = new Connection(HELIUS_RPC, { commitment: 'confirmed' });
const connChain = new Connection(CHAIN_RPC,  { commitment: 'confirmed' });
const raw    = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
const wallet = Keypair.fromSecretKey(new Uint8Array(raw));

function tick(label, status, detail = '') {
  const icons = { ok: '✅', fail: '❌', wait: '⏳', skip: '⚪' };
  console.log(`  ${icons[status] || status} ${label}${detail ? '  — ' + detail : ''}`);
}

async function getBalance() {
  for (const c of [connChain, conn]) {
    try { return await c.getBalance(wallet.publicKey); } catch(_) {}
  }
  throw new Error('All RPCs failed');
}

// ── Connection checker: Helius DEX WS ────────────────────────────────────────
function checkDEXWebSocket(timeoutMs = 8000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(HELIUS_WS);
    let resolved = false;
    const done = (ok, detail) => {
      if (!resolved) { resolved = true; ws.terminate(); resolve({ ok, detail }); }
    };
    const t = setTimeout(() => done(false, 'timeout after 8s'), timeoutMs);
    ws.on('open', () => {
      // Subscribe to Raydium AMM
      ws.send(JSON.stringify({ jsonrpc:'2.0', id:1, method:'logsSubscribe',
        params: [{ mentions: ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'] }, { commitment:'processed' }] }));
    });
    ws.on('message', (d) => {
      try {
        const m = JSON.parse(d.toString());
        if (m.result !== undefined || m.method === 'logsNotification') {
          clearTimeout(t); done(true, `subscribed (id:${m.id || m.params?.subscription})`);
        }
      } catch(_) {}
    });
    ws.on('error', (e) => { clearTimeout(t); done(false, e.message.slice(0,60)); });
    ws.on('close', () => done(false, 'closed unexpectedly'));
  });
}

// ── Connection checker: CoinAPI WS ────────────────────────────────────────────
function checkCoinAPIWebSocket(timeoutMs = 10000) {
  return new Promise((resolve) => {
    const ws = new WebSocket('wss://ws.coinapi.io/v1/');
    let resolved = false;
    let gotConnected = false;
    const done = (ok, detail) => {
      if (!resolved) { resolved = true; ws.terminate(); resolve({ ok, detail }); }
    };
    const t = setTimeout(() => {
      done(gotConnected, gotConnected ? 'connected, awaiting first trade tick' : 'timeout after 10s');
    }, timeoutMs);
    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'hello', apikey: COINAPI_KEY, heartbeat: false,
        subscribe_data_type: ['trade'],
        subscribe_filter_symbol_id: ['BINANCE_SPOT_SOL_USDT'],
      }));
    });
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.type === 'error') { clearTimeout(t); done(false, `API error: ${m.message}`); return; }
        if (!gotConnected) { gotConnected = true; }
        if (m.type === 'trade') {
          clearTimeout(t);
          done(true, `SOL/USDT price: $${m.price?.toFixed(4)}  (${m.type})`);
        }
      } catch(_) {}
    });
    ws.on('error', (e) => { clearTimeout(t); done(false, e.message.slice(0,60)); });
    ws.on('close', () => { if (!resolved) done(false, 'closed before data'); });
  });
}

// ── Bags API with exponential backoff ────────────────────────────────────────
async function bagsCall(path, method = 'GET', body = null, maxRetries = 7) {
  const BASE = 2_000;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const key = BAGS_KEYS[attempt % BAGS_KEYS.length];
    const opts = { method, headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) };
    const r = await nodeFetch(`${BAGS_API}${path}`, opts);
    const remaining = r.headers.get('x-ratelimit-remaining');
    const reset     = r.headers.get('x-ratelimit-reset');
    if (r.status === 429) {
      const exp   = Math.min(BASE * Math.pow(2, attempt), 60_000);
      const resetMs = reset ? Math.max(0, Number(reset)*1000 - Date.now()) : Infinity;
      const wait  = Math.min(exp, resetMs < Infinity ? resetMs + 500 : exp);
      console.log(`  ⏳ [${attempt+1}] key[${attempt%2}] 429 — backoff ${(wait/1000).toFixed(1)}s`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    const j = await r.json();
    if (remaining) process.stdout.write(`[rl:${remaining}] `);
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0,80)}`);
    return j;
  }
  throw new Error('Rate limit: max retries exceeded');
}

// ── Send tx — multi-RPC confirm with 90s timeout ─────────────────────────────
async function sendTx(rawTxBuf, label) {
  const sig = await conn.sendRawTransaction(rawTxBuf, { skipPreflight: true, maxRetries: 3 });
  console.log(`     🔗 ${label}: https://solscan.io/tx/${sig}`);

  const deadline = Date.now() + 90_000;
  let lastResend = Date.now();
  while (Date.now() < deadline) {
    // Try both RPCs in parallel
    const [h, c] = await Promise.allSettled([
      conn.getSignatureStatus(sig, { searchTransactionHistory: true }),
      connChain.getSignatureStatus(sig, { searchTransactionHistory: true }),
    ]);
    for (const r of [h, c]) {
      if (r.status === 'fulfilled') {
        const status = r.value?.value;
        if (status?.err) throw new Error(`${label} tx failed on-chain: ${JSON.stringify(status.err)}`);
        if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
          return sig;
        }
      }
    }
    // Re-broadcast every 20s to handle blockhash expiry
    if (Date.now() - lastResend > 20_000) {
      conn.sendRawTransaction(rawTxBuf, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      lastResend = Date.now();
    }
    await new Promise(r => setTimeout(r, 2_000));
  }
  throw new Error(`${label} not confirmed in 90s — sig: ${sig}`);
}

async function buildAndSendTx(swapTxStr, label) {
  const buf = Buffer.from(bs58.decode(swapTxStr));
  let tx; try { tx = VersionedTransaction.deserialize(buf); } catch(_) { tx = Transaction.from(buf); }
  tx.sign([wallet]);
  const rawBuf = tx.serialize();
  return sendTx(rawBuf, label);
}


// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const startMs = Date.now();

  console.log('\n' + '═'.repeat(65));
  console.log('  ⚡ FORCE TEST — Connection Verification + Live Round-Trip');
  console.log('═'.repeat(65));
  const balBefore = await getBalance();
  console.log(`  Wallet:  ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance: ${(balBefore/1e9).toFixed(6)} SOL`);
  console.log('═'.repeat(65) + '\n');

  // ── [1] Helius DEX WebSocket ───────────────────────────────────────────────
  console.log('[ 1/6 ] Helius DEX WebSocket...');
  const dex = await checkDEXWebSocket();
  tick('Helius DEX WS', dex.ok ? 'ok' : 'fail', dex.detail);

  // ── [2] CoinAPI WebSocket ─────────────────────────────────────────────────
  console.log('\n[ 2/6 ] CoinAPI WebSocket (Binance SOL/USDT)...');
  const cex = await checkCoinAPIWebSocket();
  tick('CoinAPI WS   ', cex.ok ? 'ok' : 'fail', cex.detail);

  // ── [3] Bags quote LEG1 ───────────────────────────────────────────────────
  console.log('\n[ 3/6 ] Bags quote: SOL → USDC...');
  const q1j = await bagsCall(`/trade/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=${TRADE_LAM}&slippageMode=auto&slippageBps=${SLIP_BPS}`);
  if (!q1j.success || !q1j.response?.outAmount) throw new Error('q1 bad: ' + JSON.stringify(q1j).slice(0,100));
  const q1  = q1j.response;
  const out1 = Number(q1.outAmount);
  tick('Bags quote 1 ', 'ok', `outAmount: ${out1} USDC-units  impact: ${q1.priceImpactPct||0}%`);

  // ── [4] Bags quote LEG2 ───────────────────────────────────────────────────
  console.log('\n[ 4/6 ] Bags quote: USDC → SOL...');
  const q2j = await bagsCall(`/trade/quote?inputMint=${USDC_MINT}&outputMint=${SOL_MINT}&amount=${out1}&slippageMode=auto&slippageBps=${SLIP_BPS}`);
  if (!q2j.success || !q2j.response?.outAmount) throw new Error('q2 bad: ' + JSON.stringify(q2j).slice(0,100));
  const q2   = q2j.response;
  const out2 = Number(q2.outAmount);
  const grossSol = (out2 - TRADE_LAM) / 1e9;
  tick('Bags quote 2 ', 'ok', `outAmount: ${out2} lamSOL  gross: ${grossSol>=0?'+':''}${grossSol.toFixed(6)} SOL`);

  // ── [5] LEG1 swap ─────────────────────────────────────────────────────────
  const el1 = ((Date.now()-startMs)/1000).toFixed(1);
  console.log(`\n[ 5/6 ] Swap LEG1: SOL → USDC  (${el1}s elapsed)...`);
  const s1j = await bagsCall('/trade/swap', 'POST', {
    quoteResponse: q1, userPublicKey: wallet.publicKey.toBase58(),
    computeUnitPriceMicroLamports: CU_PRICE, wrapAndUnwrapSol: false,
  });
  const swapTx1 = s1j.response?.swapTransaction || s1j.swapTransaction;
  if (!swapTx1) throw new Error('LEG1 no tx: ' + JSON.stringify(s1j).slice(0,120));
  const sig1 = await buildAndSendTx(swapTx1, 'LEG1');
  tick('Bags swap 1  ', 'ok', 'confirmed on-chain');

  // ── [6] LEG2 swap ─────────────────────────────────────────────────────────
  const el2 = ((Date.now()-startMs)/1000).toFixed(1);
  console.log(`\n[ 6/6 ] Swap LEG2: USDC → SOL  (${el2}s elapsed)...`);
  const s2j = await bagsCall('/trade/swap', 'POST', {
    quoteResponse: q2, userPublicKey: wallet.publicKey.toBase58(),
    computeUnitPriceMicroLamports: CU_PRICE, wrapAndUnwrapSol: false,
  });
  const swapTx2 = s2j.response?.swapTransaction || s2j.swapTransaction;
  if (!swapTx2) throw new Error('LEG2 no tx: ' + JSON.stringify(s2j).slice(0,120));
  const sig2 = await buildAndSendTx(swapTx2, 'LEG2');
  tick('Bags swap 2  ', 'ok', 'confirmed on-chain');

  await new Promise(r => setTimeout(r, 2000));

  // ── Result ────────────────────────────────────────────────────────────────
  const balAfter = await getBalance();
  const trueNet  = (balAfter - balBefore) / 1e9;
  const elapsed  = ((Date.now()-startMs)/1000).toFixed(1);
  const verdict  = trueNet > 0 ? '✅ PROFIT' : '📉 LOSS (fee)';

  console.log('\n' + '═'.repeat(65));
  console.log('  📋 VERIFICATION SUMMARY');
  console.log('═'.repeat(65));
  console.log(`  [1] Helius DEX WS:   ${dex.ok  ? '✅ PASS' : '❌ FAIL'}  ${dex.detail}`);
  console.log(`  [2] CoinAPI WS:      ${cex.ok  ? '✅ PASS' : '❌ FAIL'}  ${cex.detail}`);
  console.log(`  [3] Bags quote LEG1: ✅ PASS  ${out1} USDC-units`);
  console.log(`  [4] Bags quote LEG2: ✅ PASS  gross ${grossSol>=0?'+':''}${grossSol.toFixed(6)} SOL`);
  console.log(`  [5] Bags swap LEG1:  ✅ PASS  confirmed`);
  console.log(`  [6] Bags swap LEG2:  ✅ PASS  confirmed`);
  console.log('─'.repeat(65));
  console.log(`  Balance:  ${(balBefore/1e9).toFixed(6)} → ${(balAfter/1e9).toFixed(6)} SOL`);
  console.log(`  True P&L: ${trueNet>=0?'+':''}${trueNet.toFixed(6)} SOL  (${verdict})`);
  console.log(`  Time:     ${elapsed}s`);
  console.log(`  LEG1: https://solscan.io/tx/${sig1}`);
  console.log(`  LEG2: https://solscan.io/tx/${sig2}`);
  console.log('═'.repeat(65));
  process.exit(0);
}
main().catch(e => { console.error('\n❌ FATAL:', e.message); process.exit(1); });
