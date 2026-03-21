/**
 * REALTIME DIAGNOSTIC — 1-Minute Payload Validation
 * ===================================================
 * Tests WITHOUT executing any trades. Validates:
 *  1. Ultra /order response structure (transaction, outAmount, requestId, swapMode)
 *  2. Round-trip pricing (leg1 outAmt → leg2 outAmt → net SOL)
 *  3. WebSocket DEX subscription (event count in 60s)
 *  4. Rate limiter health (no 429s during controlled scan)
 *
 * Usage: node scripts/diagnostic_realtime.js
 */

'use strict';
require('dotenv').config();

const nodeFetch  = require('node-fetch');
const WebSocket  = require('ws');
const { Connection, Keypair, VersionedTransaction, Transaction } = require('@solana/web3.js');
const fs = require('fs');

const HELIUS_RPC = process.env.RPC_ENDPOINT  || 'https://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY';
const HELIUS_WS  = (process.env.RPC_WEBSOCKET || 'wss://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY').replace(/\/$/, '');
const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH || './real_wallet.json';
const API_KEY     = process.env.JUPITER_API_KEY || '';
const ULTRA       = 'https://lite-api.jup.ag/ultra/v1';
const SOL_MINT    = 'So11111111111111111111111111111111111111112';

const TRADE_SOL  = 0.15;
const TRADE_LAM  = Math.floor(TRADE_SOL * 1e9);
const SLIP_BPS   = 20;
const EXCLUDE    = encodeURIComponent('GoonFi V2,AlphaQ,SolFi V2,BisonFi,HumidiFi');
const RUN_MS     = 60_000;

const HOT_TOKENS = [
  { symbol: 'USDC',    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'USDT',    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'  },
  { symbol: 'jitoSOL', mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn' },
];

const DEX_PROGRAMS = [
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
];

const raw    = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
const wallet = Keypair.fromSecretKey(new Uint8Array(raw));
const conn   = new Connection(HELIUS_RPC, { commitment: 'confirmed' });

// State
let wsEvents = 0, wsSwapEvents = 0, wsConnected = false;
const scanResults = [];
const errors = [];

// ── Ultra fetch with full 429 handling ────────────────────────────────────────
let lastCall = 0;
async function uFetch(url, opts={}) {
  const gap = Date.now() - lastCall;
  if (gap < 900) await new Promise(r => setTimeout(r, 900 - gap));
  lastCall = Date.now();

  const r = await nodeFetch(url, { ...opts, headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json', ...(opts.headers||{}) } });
  if (r.status === 429) { errors.push('RATE_LIMITED'); throw new Error('RATE_LIMITED'); }
  if (!r.ok) { errors.push(`HTTP_${r.status}`); throw new Error(`HTTP ${r.status}`); }
  return r.json();
}

// ── Single token round-trip diagnostic ────────────────────────────────────────
async function diagToken(symbol, mint) {
  const t0 = Date.now();
  const result = { symbol, ts: new Date().toISOString().slice(11,19), ok: false };

  try {
    // LEG 1
    const o1 = await uFetch(
      `${ULTRA}/order?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${TRADE_LAM}&slippageBps=${SLIP_BPS}&taker=${wallet.publicKey.toBase58()}&excludeDexes=${EXCLUDE}`
    );

    // Validate leg1 payload structure
    result.leg1 = {
      hasTransaction: !!o1?.transaction,
      hasOutAmount:   !!o1?.outAmount,
      hasRequestId:   !!o1?.requestId,
      hasSwapMode:    !!o1?.swapMode,
      outAmount:      o1?.outAmount,
      requestId:      o1?.requestId?.slice(0,16) + '...',
      swapMode:       o1?.swapMode,
      txLenBytes:     o1?.transaction ? Buffer.from(o1.transaction, 'base64').length : 0,
      error:          o1?.error,
    };

    if (!o1?.transaction || !o1?.outAmount) {
      result.error = `LEG1 missing fields: ${JSON.stringify(Object.keys(o1||{}))}`;
      return result;
    }

    // Validate tx is deserializable
    try {
      const txBuf = Buffer.from(o1.transaction, 'base64');
      try { VersionedTransaction.deserialize(txBuf); result.leg1.txType = 'versioned'; }
      catch(_) { Transaction.from(txBuf); result.leg1.txType = 'legacy'; }
    } catch(e) {
      result.leg1.txType = `DESERIALIZE_ERROR: ${e.message.slice(0,60)}`;
    }

    // LEG 2
    const out1 = Number(o1.outAmount);
    const o2   = await uFetch(
      `${ULTRA}/order?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${out1}&slippageBps=${SLIP_BPS}&taker=${wallet.publicKey.toBase58()}&excludeDexes=${EXCLUDE}`
    );

    result.leg2 = {
      hasTransaction: !!o2?.transaction,
      hasOutAmount:   !!o2?.outAmount,
      hasRequestId:   !!o2?.requestId,
      outAmount:      o2?.outAmount,
      requestId:      o2?.requestId?.slice(0,16) + '...',
      txLenBytes:     o2?.transaction ? Buffer.from(o2.transaction, 'base64').length : 0,
      error:          o2?.error,
    };

    if (!o2?.transaction || !o2?.outAmount) {
      result.error = `LEG2 missing fields: ${JSON.stringify(Object.keys(o2||{}))}`;
      return result;
    }

    const out2  = Number(o2.outAmount);
    const netLam = out2 - TRADE_LAM;
    result.roundTrip = {
      input:       TRADE_LAM,
      afterLeg1:   out1,
      afterLeg2:   out2,
      netLamports: netLam,
      netSOL:      (netLam / 1e9).toFixed(6),
      profitable:  netLam > 0,
    };
    result.latencyMs = Date.now() - t0;
    result.ok = true;
  } catch(e) {
    result.error = e.message;
  }
  return result;
}

// ── WebSocket diagnostic ──────────────────────────────────────────────────────
function diagWebSocket() {
  return new Promise((resolve) => {
    const ws = new WebSocket(HELIUS_WS);
    const wsResult = { connected: false, subscriptions: [], events: 0, swapEvents: 0, error: null };
    let subId = null;

    ws.on('open', () => {
      wsResult.connected = true;
      wsConnected = true;
      // Subscribe to Raydium AMM
      DEX_PROGRAMS.forEach((prog, i) => {
        ws.send(JSON.stringify({ jsonrpc:'2.0', id: i+1, method:'logsSubscribe', params:[{ mentions:[prog] }, { commitment:'processed' }] }));
      });
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.result && typeof msg.result === 'number') {
          wsResult.subscriptions.push({ program: DEX_PROGRAMS[msg.id - 1]?.slice(0,16), subId: msg.result });
        }
        if (msg.method === 'logsNotification') {
          wsResult.events++;
          wsEvents++;
          const logs = msg.params?.result?.value?.logs || [];
          const isSwap = logs.some(l => l.includes('swap') || l.includes('ray_log') || l.includes('Instruction: Swap') || l.includes('amount'));
          if (isSwap) { wsResult.swapEvents++; wsSwapEvents++; }
        }
      } catch(_) {}
    });

    ws.on('error', (e) => { wsResult.error = e.message; });

    // Close after 30s and resolve
    setTimeout(() => { ws.close(); resolve(wsResult); }, 30000);
  });
}

// ── Main diagnostic ───────────────────────────────────────────────────────────
async function main() {
  const bal = (await conn.getBalance(wallet.publicKey)) / 1e9;
  const startTs = Date.now();

  console.log('\n' + '═'.repeat(72));
  console.log('  🔬 REALTIME DIAGNOSTIC — 1-Minute Payload Validation');
  console.log('═'.repeat(72));
  console.log(`  Wallet:   ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance:  ${bal.toFixed(6)} SOL`);
  console.log(`  WS URL:   ${HELIUS_WS.slice(0,50)}...`);
  console.log(`  API Key:  ${API_KEY ? API_KEY.slice(0,8)+'...' : '(none)'}`);
  console.log('═'.repeat(72));

  // ── Phase 1: WebSocket (30s parallel) ──────────────────────────────────────
  console.log('\n  PHASE 1 — WebSocket DEX Subscription (30s)');
  console.log('  ─────────────────────────────────────────────');
  const wsPromise = diagWebSocket();

  // ── Phase 2: Ultra scan cycles (30s) ───────────────────────────────────────
  console.log('  PHASE 2 — Ultra /order Payload Scans (3 tokens × 2 legs)');
  console.log('  ─────────────────────────────────────────────────────────');

  const endTime = Date.now() + RUN_MS;
  let cycle = 0;

  while (Date.now() < endTime) {
    cycle++;
    console.log(`\n  [Cycle ${cycle}] — ${new Date().toISOString().slice(11,19)}`);

    for (const { symbol, mint } of HOT_TOKENS) {
      if (Date.now() >= endTime) break;
      process.stdout.write(`    ${symbol.padEnd(8)} `);
      const r = await diagToken(symbol, mint);
      scanResults.push(r);

      if (r.ok) {
        const net = r.roundTrip.netSOL;
        const icon = r.roundTrip.profitable ? '✅' : '📉';
        const l1ok = r.leg1.hasTransaction && r.leg1.hasOutAmount && r.leg1.hasRequestId ? '✅' : '❌';
        const l2ok = r.leg2.hasTransaction && r.leg2.hasOutAmount && r.leg2.hasRequestId ? '✅' : '❌';
        console.log(`LEG1:${l1ok} LEG2:${l2ok} ${icon} net:${net} SOL | txType:${r.leg1.txType} | ${r.latencyMs}ms`);
      } else {
        console.log(`❌ ERROR: ${r.error}`);
      }
    }
    // Wait between cycles to respect rate limits
    if (Date.now() < endTime - 6000) {
      const wait = Math.min(6000, endTime - Date.now());
      await new Promise(r => setTimeout(r, wait));
    } else break;
  }

  // ── Wait for WS results ────────────────────────────────────────────────────
  console.log('\n  Waiting for WebSocket 30s window to complete...');
  const wsResult = await wsPromise;

  const elapsed = Date.now() - startTs;

  // ── Final Report ───────────────────────────────────────────────────────────
  console.log('\n\n' + '═'.repeat(72));
  console.log('  📋 DIAGNOSTIC REPORT');
  console.log('═'.repeat(72));

  // WebSocket results
  console.log('\n  🔌 WebSocket');
  console.log(`    Connected:          ${wsResult.connected ? '✅ YES' : '❌ NO'}`);
  console.log(`    Subscriptions acked: ${wsResult.subscriptions.length}/${DEX_PROGRAMS.length}`);
  wsResult.subscriptions.forEach(s => console.log(`      • ${s.program}... → subId:${s.subId}`));
  console.log(`    Events received:    ${wsResult.events} total  (${wsResult.swapEvents} swap-specific)`);
  console.log(`    Error:              ${wsResult.error || 'none'}`);

  // Ultra scan results
  console.log('\n  ⚡ Ultra /order Scans');
  const good = scanResults.filter(r => r.ok);
  const fail = scanResults.filter(r => !r.ok);
  console.log(`    Total scans:        ${scanResults.length}  (${good.length} ok / ${fail.length} failed)`);
  console.log(`    Rate limit errors:  ${errors.filter(e=>e==='RATE_LIMITED').length}`);

  if (good.length > 0) {
    console.log('\n  📦 Payload Structure (first valid scan per token):');
    const seen = new Set();
    good.forEach(r => {
      if (seen.has(r.symbol)) return;
      seen.add(r.symbol);
      console.log(`\n    ${r.symbol}:`);
      console.log(`      LEG1 transaction:  ${r.leg1.hasTransaction ? `✅ ${r.leg1.txLenBytes} bytes (${r.leg1.txType})` : '❌ MISSING'}`);
      console.log(`      LEG1 outAmount:    ${r.leg1.hasOutAmount ? `✅ ${r.leg1.outAmount}` : '❌ MISSING'}`);
      console.log(`      LEG1 requestId:    ${r.leg1.hasRequestId ? `✅ ${r.leg1.requestId}` : '❌ MISSING'}`);
      console.log(`      LEG1 swapMode:     ${r.leg1.swapMode || '(none)'}`);
      console.log(`      LEG2 transaction:  ${r.leg2.hasTransaction ? `✅ ${r.leg2.txLenBytes} bytes` : '❌ MISSING'}`);
      console.log(`      LEG2 outAmount:    ${r.leg2.hasOutAmount ? `✅ ${r.leg2.outAmount}` : '❌ MISSING'}`);
      console.log(`      LEG2 requestId:    ${r.leg2.hasRequestId ? `✅ ${r.leg2.requestId}` : '❌ MISSING'}`);
      console.log(`      Round-trip net:    ${r.roundTrip.profitable?'✅':'📉'} ${r.roundTrip.netSOL} SOL  (after all Ultra fees)`);
      console.log(`      Round-trip ms:     ${r.latencyMs}ms`);
    });
  }

  if (fail.length > 0) {
    console.log('\n  ❌ Failed scans:');
    fail.forEach(r => console.log(`    ${r.symbol}: ${r.error}`));
  }

  // Net pricing summary
  console.log('\n  📊 Net Pricing by Token (Ultra-priced, all cycles averaged):');
  HOT_TOKENS.forEach(({ symbol }) => {
    const t = good.filter(r => r.symbol === symbol);
    if (!t.length) { console.log(`    ${symbol.padEnd(8)}: no data`); return; }
    const avg = t.reduce((s,r) => s + r.roundTrip.netLamports, 0) / t.length;
    const best = Math.max(...t.map(r => r.roundTrip.netLamports));
    const worst = Math.min(...t.map(r => r.roundTrip.netLamports));
    console.log(`    ${symbol.padEnd(8)}: avg ${avg>=0?'+':''}${(avg/1e9).toFixed(6)} SOL | best ${(best/1e9).toFixed(6)} | worst ${(worst/1e9).toFixed(6)} | n=${t.length}`);
  });

  // Go/No-Go
  const allFieldsOk = good.length > 0 && good.every(r => r.leg1.hasTransaction && r.leg1.hasRequestId && r.leg2.hasTransaction && r.leg2.hasRequestId);
  const txDeserOk   = good.every(r => !r.leg1.txType?.includes('ERROR'));
  const wsOk        = wsResult.connected && wsResult.subscriptions.length > 0;

  console.log('\n  ─────────────────────────────');
  console.log('  🚦 GO / NO-GO CHECK');
  console.log(`    Ultra payload structure: ${allFieldsOk ? '✅ ALL FIELDS PRESENT' : '❌ MISSING FIELDS'}`);
  console.log(`    Tx deserialization:      ${txDeserOk ? '✅ OK' : '❌ BROKEN'}`);
  console.log(`    WebSocket connected:     ${wsOk ? '✅ OK' : '❌ FAILING'}`);
  console.log(`    Rate limits:             ${errors.length === 0 ? '✅ CLEAN' : `⚠️  ${errors.length} 429s`}`);
  const allGo = allFieldsOk && txDeserOk && wsOk;
  console.log(`\n    OVERALL: ${allGo ? '✅ ALL SYSTEMS GO' : '❌ ISSUES DETECTED — review above'}`);
  console.log('\n' + '═'.repeat(72) + '\n');

  fs.writeFileSync('./diagnostic_realtime_result.json', JSON.stringify({ wsResult, scanResults, errors, summary: { allFieldsOk, txDeserOk, wsOk, elapsed } }, null, 2));
  console.log('  📄 diagnostic_realtime_result.json');
}

main().catch(e => { console.error('\n❌ FATAL:', e.message); process.exit(1); });
