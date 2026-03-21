/**
 * REALTIME ARB ENGINE — Option 3 + Option 4 Combined
 * ====================================================
 *
 * Option 3: 3-Token Hot Scanner
 *  - Scans USDC, USDT, jitoSOL via /ultra/v1/order every 3s (baseline)
 *  - Only 6 Ultra API calls per 3s = stays within rate limits
 *
 * Option 4: Helius WebSocket DEX Event Trigger
 *  - Subscribes to Raydium AMM + Orca Whirlpool program logs via WebSocket
 *  - Any on-chain DEX swap → immediately triggers a hot scan (debounced 800ms)
 *  - This gives sub-second reaction to actual market activity vs blind polling
 *
 * Combined: WebSocket triggers instant scans, fallback polling catches anything
 * the WS misses. Only execute when Ultra-priced net > MIN_PROFIT_LAM.
 *
 * Runs as PM2 persistent process. Per-tx P&L via getTransaction.
 *
 * Usage: node scripts/arb_realtime.js
 * PM2:   pm2 start scripts/arb_realtime.js --name arb-realtime
 */

'use strict';
require('dotenv').config();

const nodeFetch  = require('node-fetch');
const WebSocket  = require('ws');
const { Connection, Keypair, VersionedTransaction, Transaction } = require('@solana/web3.js');
const fs = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const HELIUS_RPC = process.env.RPC_ENDPOINT  || 'https://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY';
const HELIUS_WS  = (process.env.RPC_WEBSOCKET || 'wss://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY').replace(/\/$/, '');
const CHAIN_WS   = 'wss://solana-mainnet.core.chainstack.com/YOUR_CHAINSTACK_KEY';
const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH || './real_wallet.json';
const API_KEY     = process.env.JUPITER_API_KEY || '';
const ULTRA       = 'https://lite-api.jup.ag/ultra/v1';
const SOL_MINT    = 'So11111111111111111111111111111111111111112';

const TRADE_SOL      = 0.15;               // 0.15 SOL per leg
const TRADE_LAM      = Math.floor(TRADE_SOL * 1e9);
const MIN_PROFIT_LAM = 5_000;              // 0.000005 SOL minimum net (after ULTRA_FEE_CAL deducted)
const SLIP_BPS       = 20;                 // 0.20 %
const BASELINE_MS    = 2_000;             // option 3: baseline scan every 2s
const COOLDOWN_MS    = 6_000;             // per-token cool-down after trade
const ULTRA_DELAY_MS = 700;               // min gap between Ultra API calls
const LOG_INTERVAL   = 60_000;            // heartbeat stats every 60s
const EXCLUDE        = encodeURIComponent('GoonFi V2,AlphaQ,SolFi V2,BisonFi,HumidiFi');

// ── Hot Tokens (3 showing highest spreads — fits in Ultra rate limits) ─────────
const HOT_TOKENS = [
  { symbol: 'USDC',    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'USDT',    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'  },
  { symbol: 'jitoSOL', mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn' },
];

// ── DEX Programs to watch (Raydium + Orca) ────────────────────────────────────
const DEX_PROGRAMS = [
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca Whirlpool
];

// ── Infrastructure ────────────────────────────────────────────────────────────
const conn    = new Connection(HELIUS_RPC, { commitment: 'confirmed' });
const raw     = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
const wallet  = Keypair.fromSecretKey(new Uint8Array(raw));

// State
let scanCount = 0, execCount = 0, profitCount = 0;
let totalPnl  = 0;
let wsEvents  = 0;
let lastScan  = 0;
let scanning  = false;
const lastTradeAt = {};
const bestSeen    = {};

// Ultra API rate limiter — sequential calls with tracking
let lastUltraCall = 0;
async function uFetch(url, opts={}) {
  const gap = Date.now() - lastUltraCall;
  if (gap < ULTRA_DELAY_MS) await new Promise(r => setTimeout(r, ULTRA_DELAY_MS - gap));
  lastUltraCall = Date.now();
  let attempts = 0;
  while (attempts < 3) {
    try {
      const r = await nodeFetch(url, { ...opts, headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json', ...(opts.headers||{}) }});
      if (r.status === 429) {
        attempts++;
        console.log(`  ⚠️  Ultra 429 — waiting 5s (attempt ${attempts})`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    } catch(e) {
      attempts++;
      if (attempts >= 3) throw e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// ── Per-tx P&L tracker ────────────────────────────────────────────────────────
async function getTxDelta(sig) {
  for (let i = 0; i < 8; i++) {
    try {
      await new Promise(r => setTimeout(r, 2500));
      const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (tx?.meta) return (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9;
    } catch(_) {}
  }
  return null;
}

// ── SCAN via /swap/v1/quote — no wallet token balance required ─────────────────
// Ultra /order requires wallet to hold the token (raises "Insufficient funds")
// during scan. /quote is for pricing only — no wallet simulation.
// We subtract ULTRA_FEE_CAL from gross to estimate net after Ultra platform fees.
const QUOTE_API     = 'https://lite-api.jup.ag/swap/v1';
// ULTRA_FEE_CAL: confirmed on-chain cost per round-trip from diagnostic_realtime_b.log
// USDC avg: -0.000068 SOL, USDT avg: -0.000061 SOL → use conservative 0.000070
const ULTRA_FEE_CAL = 0.000070; // SOL per round-trip (legs 1+2 combined)

let lastQuoteCall = 0;
async function qFetch(url) {
  const gap = Date.now() - lastQuoteCall;
  if (gap < 500) await new Promise(r => setTimeout(r, 500 - gap));
  lastQuoteCall = Date.now();
  const r = await nodeFetch(url, { headers: { 'x-api-key': API_KEY } });
  if (r.status === 429) throw new Error('RATE_LIMITED');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function scanToken(symbol, mint) {
  if (lastTradeAt[symbol] && Date.now() - lastTradeAt[symbol] < COOLDOWN_MS) return null;
  try {
    const q1 = await qFetch(
      `${QUOTE_API}/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${TRADE_LAM}&slippageBps=${SLIP_BPS}&excludeDexes=${EXCLUDE}`
    );
    if (!q1?.outAmount) return null;

    const out1 = Number(q1.outAmount);
    const q2   = await qFetch(
      `${QUOTE_API}/quote?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${out1}&slippageBps=${SLIP_BPS}&excludeDexes=${EXCLUDE}`
    );
    if (!q2?.outAmount) return null;

    const out2      = Number(q2.outAmount);
    const grossLam  = out2 - TRADE_LAM;
    const netLam    = grossLam - Math.floor(ULTRA_FEE_CAL * 1e9);
    const grossSol  = grossLam / 1e9;
    const netSol    = netLam / 1e9;
    if (grossSol > (bestSeen[symbol] || -999)) bestSeen[symbol] = grossSol;
    return { symbol, mint, out1, grossLam, netLam, grossSol, netSol };
  } catch(e) {
    if (!e.message.includes('RATE')) console.log(`  ⚠️  scan ${symbol}: ${e.message.slice(0,60)}`);
    return null;
  }
}

// ── EXECUTE via Ultra — fetch fresh order at execution time ───────────────────
// We don't reuse the scan's quote because scan used /quote API not /order.
// At execution: fetch Ultra /order for leg1 fresh → sign → execute →
// use actual outputAmount → Ultra /order for leg2 → sign → execute.
async function executeOrders(opp) {
  // LEG 1: fresh Ultra /order (wallet has SOL, this works)
  const o1 = await uFetch(
    `${ULTRA}/order?inputMint=${SOL_MINT}&outputMint=${opp.mint}&amount=${TRADE_LAM}&slippageBps=${SLIP_BPS}&taker=${wallet.publicKey.toBase58()}&excludeDexes=${EXCLUDE}`
  );
  if (!o1?.transaction) throw new Error(`LEG1 order: ${o1?.error || 'no transaction'}`);

  let tx1;
  const tx1Buf = Buffer.from(o1.transaction, 'base64');
  try { tx1 = VersionedTransaction.deserialize(tx1Buf); } catch(_) { tx1 = Transaction.from(tx1Buf); }
  tx1.sign([wallet]);
  const exec1 = await uFetch(`${ULTRA}/execute`, {
    method: 'POST',
    body: JSON.stringify({ signedTransaction: Buffer.from(tx1.serialize()).toString('base64'), requestId: o1.requestId })
  });
  if (exec1?.status !== 'Success') throw new Error(`LEG1: ${exec1?.error || exec1?.status}`);

  // LEG 2: Ultra /order with actual received token amount (wallet now holds token)
  const realOut1 = Number(exec1.outputAmount || opp.out1);
  const o2 = await uFetch(
    `${ULTRA}/order?inputMint=${opp.mint}&outputMint=${SOL_MINT}&amount=${realOut1}&slippageBps=${SLIP_BPS}&taker=${wallet.publicKey.toBase58()}&excludeDexes=${EXCLUDE}`
  );
  if (!o2?.transaction) throw new Error(`LEG2 order: ${o2?.error || 'no transaction'}`);

  let tx2;
  const tx2Buf = Buffer.from(o2.transaction, 'base64');
  try { tx2 = VersionedTransaction.deserialize(tx2Buf); } catch(_) { tx2 = Transaction.from(tx2Buf); }
  tx2.sign([wallet]);
  const exec2 = await uFetch(`${ULTRA}/execute`, {
    method: 'POST',
    body: JSON.stringify({ signedTransaction: Buffer.from(tx2.serialize()).toString('base64'), requestId: o2.requestId })
  });
  if (exec2?.status !== 'Success') throw new Error(`LEG2: ${exec2?.error || exec2?.status}`);
  return { sig1: exec1.signature, sig2: exec2.signature, realOut1, realOut2: Number(exec2.outputAmount || '0') };
}


// ── Core scan loop — GSD parallel pattern ─────────────────────────────────────
// Like GSD's executeToolCallsParallel: prepare all calls concurrently,
// finalize (execute) only the best profitable result.
async function runScan(trigger = 'baseline') {
  if (scanning) return;
  scanning = true;
  lastScan = Date.now();
  scanCount++;
  try {
    // Parallel scan of all hot tokens (GSD: runnableCalls.map → execution)
    const results = await Promise.all(HOT_TOKENS.map(({ symbol, mint }) => scanToken(symbol, mint)));
    const viable  = results.filter(r => r !== null && r.netLam >= MIN_PROFIT_LAM)
                           .sort((a, b) => b.netLam - a.netLam);
    if (!viable.length) return;

    // Execute BEST opportunity (GSD: finalize the top prepared call)
    const best = viable[0];
    const ts   = new Date().toISOString().slice(11,19);
    console.log(`\n  [${ts}] 🎯 ARB! ${trigger} | ${best.symbol}  gross:+${best.grossSol.toFixed(6)} net:+${best.netSol.toFixed(6)} SOL`);
    lastTradeAt[best.symbol] = Date.now();
    execCount++;
    try {
      const t0  = Date.now();
      const res = await executeOrders(best);
      const execMs = Date.now() - t0;
      console.log(`  ✅ LEG1: https://solscan.io/tx/${res.sig1}`);
      console.log(`  ✅ LEG2: https://solscan.io/tx/${res.sig2}  (${execMs}ms)`);
      const [d1, d2] = await Promise.all([getTxDelta(res.sig1), getTxDelta(res.sig2)]);
      const net = (d1||0) + (d2||0);
      totalPnl += net;
      if (net > 0) profitCount++;
      const icon = net>0?'✅ PROFIT':net===0?'⚠️ FLAT':'📉 LOSS';
      console.log(`  ${icon}  leg1:${d1!==null?(d1>=0?'+':'')+d1.toFixed(6):'~'}  leg2:${d2!==null?(d2>=0?'+':'')+d2.toFixed(6):'~'}  net:${net>=0?'+':''}${net.toFixed(6)}`);
      console.log(`  Cumulative P&L: ${totalPnl>=0?'+':''}${totalPnl.toFixed(6)} SOL\n`);
      const entry = { ts: new Date().toISOString(), symbol: best.symbol, trigger,
                      grossSol: best.grossSol, netSol: best.netSol, actualNet: net,
                      sig1: res.sig1, sig2: res.sig2 };
      const logPath = './arb_realtime_trades.json';
      const existing = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath,'utf-8')) : [];
      existing.push(entry);
      fs.writeFileSync(logPath, JSON.stringify(existing, null, 2));
    } catch(e) {
      execCount--;
      console.log(`  ❌ ${e.message.slice(0,120)}`);
    }
  } finally {
    scanning = false;
  }
}


// ── WebSocket DEX event subscription (Option 4) ───────────────────────────────
// GSD-inspired: per-program debounce timers (like separate tool execution queues)
// Raydium and Orca events go into separate 800ms debounce buckets so they don't
// cancel each other — both triggers result in a scan, just not too frequently.
const wsDebounceMap = {};

function triggerWScan(progId) {
  wsEvents++;
  const key = progId || 'global';
  clearTimeout(wsDebounceMap[key]);
  wsDebounceMap[key] = setTimeout(() => { runScan('websocket:' + key.slice(0,8)); }, 800);
}

function connectWebSocket(wsUrl) {
  if (!wsUrl) wsUrl = HELIUS_WS;
  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    const source = wsUrl.includes('helius') ? 'Helius' : 'Chainstack';
    console.log(`  🔌 WebSocket connected (${source})`);
    DEX_PROGRAMS.forEach((prog, i) => {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: i + 1,
        method: 'logsSubscribe',
        params: [{ mentions: [prog] }, { commitment: 'processed' }]
      }));
    });
    console.log(`  📡 Subscribed to ${DEX_PROGRAMS.length} DEX programs (Raydium AMM + CLMM, Orca Whirlpool)`);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.method === 'logsNotification') {
        const progId  = msg.params?.result?.value?.signature ? undefined :
                        msg.params?.result?.context?.slot ? undefined : undefined;
        const logs    = msg.params?.result?.value?.logs || [];
        // GSD pattern: check for swap-relevant events before triggering
        const isSwap  = logs.some(l =>
          l.includes('Instruction: Swap') ||
          l.includes('swap') ||
          l.includes('ray_log') ||
          l.includes('Program log: amount') ||
          l.includes('SwapEvent')
        );
        if (isSwap) {
          // Use the subscription ID as the debounce key (per DEX program)
          const subId = msg.params?.subscription;
          triggerWScan(subId ? String(subId) : 'global');
        }
      }
    } catch(_) {}
  });

  ws.on('error', (e) => {
    const msg = e.message || '';
    // On 401, try the other endpoint
    if (msg.includes('401') && wsUrl === HELIUS_WS) {
      console.log('  ⚠️  Helius WS 401 — trying Chainstack WS...');
    }
    if (msg.includes('401') && wsUrl === CHAIN_WS) {
      console.log('  ⚠️  Chainstack WS 401 too — WS disabled, baseline polling only');
    }
  });

  ws.on('close', (code) => {
    // On 401 (code 4401 or typical HTTP 401), switch endpoint
    if (code === 4401 || code === 1002) {
      const next = wsUrl === HELIUS_WS ? CHAIN_WS : HELIUS_WS;
      console.log(`  🔄 WS closed (${code}) — switching to ${next.includes('helius')?'Helius':'Chainstack'} in 3s...`);
      setTimeout(() => connectWebSocket(next), 3000);
    } else {
      console.log(`  🔄 WS closed (${code}) — reconnecting same endpoint in 5s...`);
      setTimeout(() => connectWebSocket(wsUrl), 5000);
    }
  });

  const ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
    else clearInterval(ping);
  }, 20000);

  return ws;
}

// ── Stats printer ─────────────────────────────────────────────────────────────
function printStats() {
  const ts  = new Date().toISOString().slice(11,19);
  const best = HOT_TOKENS.map(t => `${t.symbol}:${bestSeen[t.symbol]!==undefined?(bestSeen[t.symbol]>0?'+':'')+((bestSeen[t.symbol]||0)/1e9).toFixed(5):'?'}`).join(' ');
  console.log(`\n  📊 [${ts}] Scans:${scanCount} | WS Events:${wsEvents} | Trades:${execCount} (${profitCount}✅) | P&L:${totalPnl>=0?'+':''}${totalPnl.toFixed(5)} SOL | Best Ultra-net: ${best}`);
  // Reset bestSeen for fresh next window
  HOT_TOKENS.forEach(t => { bestSeen[t.symbol] = undefined; });
}

// ── Baseline polling fallback (Option 3) ──────────────────────────────────────
async function baselineLoop() {
  while (true) {
    await new Promise(r => setTimeout(r, BASELINE_MS));
    // Only run baseline if no WS scan in the last 2s
    if (!scanning && Date.now() - lastScan > 2000) {
      await runScan('baseline');
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const balBefore = (await conn.getBalance(wallet.publicKey)) / 1e9;

  console.log('\n' + '═'.repeat(72));
  console.log('  ⚡ REALTIME ARB ENGINE — Option 3 + Option 4');
  console.log('═'.repeat(72));
  console.log(`  Wallet:        ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance:       ${balBefore.toFixed(6)} SOL`);
  console.log(`  Trade size:    ${TRADE_SOL} SOL`);
  console.log(`  Min profit:    +${(MIN_PROFIT_LAM/1e9).toFixed(6)} SOL  (post-all-fees)`);
  console.log(`  Hot tokens:    ${HOT_TOKENS.map(t=>t.symbol).join(', ')}`);
  console.log(`  Baseline scan: every ${BASELINE_MS/1000}s (option 3)`);
  console.log(`  WS triggers:   Raydium AMM/CLMM + Orca Whirlpool swaps (option 4)`);
  console.log(`  P&L logging:   arb_realtime_trades.json`);
  console.log('═'.repeat(72) + '\n');

  // Start WebSocket subscription (Option 4)
  connectWebSocket();

  // Print stats every 60s
  setInterval(printStats, LOG_INTERVAL);

  // Start baseline polling (Option 3) — runs forever
  baselineLoop().catch(e => {
    console.error('❌ Baseline loop fatal:', e.message);
    process.exit(1);
  });
}

main().catch(e => { console.error('\n❌ FATAL:', e.message); process.exit(1); });
