/**
 * GENUINE ARB v3 — Confirmed P&L Edition
 * ========================================
 * Key fixes over v2:
 *  1. P&L measured via getTransaction(sig).meta.preBalances[0]/postBalances[0]
 *     — immune to unrelated wallet activity (token sells, transfers, etc)
 *  2. Execution via Jupiter Ultra /order + /execute (managed routing, confirmed
 *     inclusion) instead of raw Jito bundles (which get dropped silently)
 *  3. Rate-limit fix: limiter bumped, scan waits added between cycles
 *  4. 22 validated tokens (stSOL/JTO/ZEUS/PONKE removed)
 *
 * Usage: node scripts/arb5min_v3.js
 */

'use strict';
require('dotenv').config();

const nodeFetch  = require('node-fetch');
const { Connection, Keypair } = require('@solana/web3.js');
const bs58  = require('bs58');
const fs    = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const HELIUS_RPC  = process.env.RPC_ENDPOINT        || 'https://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY';
const CHAIN_RPC   = 'https://rpc.YOUR_CHAINSTACK_ENDPOINT';
const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH || './real_wallet.json';
const API_KEY     = process.env.JUPITER_API_KEY     || '';
const JUP_QUOTE   = 'https://lite-api.jup.ag/swap/v1';
const JUP_ULTRA   = 'https://lite-api.jup.ag/ultra/v1';   // /order and /execute appended below
const SOL_MINT    = 'So11111111111111111111111111111111111111112';

const TRADE_SOL  = 0.10;           // 0.10 SOL trade size
const TRADE_LAM  = Math.floor(TRADE_SOL * 1e9);
const MIN_PROFIT = 0.000030;       // 0.00003 SOL net minimum
const FEE_EST    = 0.000080;       // Ultra API covers fees — just budget for base fee
const SCAN_MS    = 200;            // 200ms between scan cycles (was 100ms — prevents RL)
const RUN_MS     = 5 * 60 * 1000;
const SLIP_BPS   = 20;             // 0.20%

// Only exclude genuinely broken vote-account lockers
const EXCLUDE = encodeURIComponent('GoonFi V2,AlphaQ,SolFi V2,BisonFi,HumidiFi');

// ── VALIDATED Tokens (22 — all confirmed routable on Jupiter) ─────────────────
const TOKENS = [
  { symbol: 'USDC',    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'USDT',    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'  },
  { symbol: 'mSOL',    mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'  },
  { symbol: 'jitoSOL', mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn' },
  { symbol: 'bSOL',    mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1'  },
  { symbol: 'RAY',     mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
  { symbol: 'ORCA',    mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE'  },
  { symbol: 'JUP',     mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'  },
  { symbol: 'DRIFT',   mint: 'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7'  },
  { symbol: 'PYTH',    mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3' },
  { symbol: 'WIF',     mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  { symbol: 'BONK',    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { symbol: 'POPCAT',  mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
  { symbol: 'MYRO',    mint: 'HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4' },
  { symbol: 'BOME',    mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82'  },
  { symbol: 'SLERF',   mint: '7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3' },
  { symbol: 'ETH',     mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs' },
  { symbol: 'BTC',     mint: '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E' },
  { symbol: 'W',       mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ' },
  { symbol: 'RNDR',    mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof'  },
  { symbol: 'WEN',     mint: 'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk'   },
  { symbol: 'UXD',     mint: '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT'  },
];

// ── Infrastructure ────────────────────────────────────────────────────────────
const conn   = new Connection(HELIUS_RPC, { commitment: 'confirmed' });
const raw    = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
const wallet = Keypair.fromSecretKey(new Uint8Array(raw));

// Gentle rate limiter — 60 req/min to Jupiter
let reqCount = 0, reqWindowStart = Date.now();
async function jFetch(url, opts={}) {
  // Rate limit: max 50 requests per 15 seconds
  reqCount++;
  if (reqCount > 50 && (Date.now() - reqWindowStart) < 15000) {
    await new Promise(r => setTimeout(r, 15000 - (Date.now() - reqWindowStart)));
    reqCount = 0; reqWindowStart = Date.now();
  } else if (Date.now() - reqWindowStart > 15000) {
    reqCount = 1; reqWindowStart = Date.now();
  }
  const r = await nodeFetch(url, { ...opts, headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json', ...(opts.headers||{}) }});
  if (r.status === 429) { await new Promise(r=>setTimeout(r,2000)); throw new Error('RATE_LIMITED'); }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── Blockhash race ─────────────────────────────────────────────────────────
let cachedBH = null;
async function raceBH() {
  const got = await Promise.race([
    nodeFetch(HELIUS_RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getLatestBlockhash',params:[{commitment:'processed'}]})}).then(r=>r.json()).then(d=>d?.result?.value?.blockhash).catch(()=>null),
    nodeFetch(CHAIN_RPC, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getLatestBlockhash',params:[{commitment:'processed'}]})}).then(r=>r.json()).then(d=>d?.result?.value?.blockhash).catch(()=>null),
  ]);
  if (got) cachedBH = got;
}
setInterval(raceBH, 800);
raceBH();

// ── Scan one token for round-trip arb spread ──────────────────────────────────
async function scanToken(symbol, mint) {
  try {
    const q1 = await jFetch(`${JUP_QUOTE}/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${TRADE_LAM}&slippageBps=${SLIP_BPS}&excludeDexes=${EXCLUDE}`);
    if (!q1?.outAmount) return null;
    const q2 = await jFetch(`${JUP_QUOTE}/quote?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${q1.outAmount}&slippageBps=${SLIP_BPS}&excludeDexes=${EXCLUDE}`);
    if (!q2?.outAmount) return null;
    const gross = (Number(q2.outAmount) - TRADE_LAM) / 1e9;
    const net   = gross - FEE_EST;
    return { symbol, mint, q1, q2, gross, net };
  } catch(_) { return null; }
}

// ── Execute via Jupiter Ultra — GET /order then POST /execute ─────────────────
// Based on working force_live_test_ultra.js pattern
async function executeUltra(opp) {
  const { VersionedTransaction, Transaction } = require('@solana/web3.js');

  // LEG 1: SOL → Token (GET /order with query params)
  const order1 = await jFetch(
    `${JUP_ULTRA}/order?inputMint=${SOL_MINT}&outputMint=${opp.mint}&amount=${TRADE_LAM}&slippageBps=${SLIP_BPS}&taker=${wallet.publicKey.toBase58()}&excludeDexes=${EXCLUDE}`
  );
  if (!order1?.transaction) throw new Error(`Ultra order1 no tx: ${JSON.stringify(order1).slice(0,100)}`);

  const tx1Buf = Buffer.from(order1.transaction, 'base64');
  let tx1;
  try { tx1 = VersionedTransaction.deserialize(tx1Buf); } catch(_) { tx1 = Transaction.from(tx1Buf); }
  tx1.sign([wallet]);

  const exec1 = await jFetch(`${JUP_ULTRA}/execute`, {
    method: 'POST',
    body: JSON.stringify({ signedTransaction: Buffer.from(tx1.serialize()).toString('base64'), requestId: order1.requestId })
  });
  if (exec1?.status !== 'Success') throw new Error(`Leg1 failed: ${exec1?.error || exec1?.status || JSON.stringify(exec1).slice(0,100)}`);
  const sig1    = exec1.signature;
  const outAmt1 = Number(exec1.outputAmount || order1.outAmount || opp.q1.outAmount);

  // LEG 2: Token → SOL
  const order2 = await jFetch(
    `${JUP_ULTRA}/order?inputMint=${opp.mint}&outputMint=${SOL_MINT}&amount=${outAmt1}&slippageBps=${SLIP_BPS}&taker=${wallet.publicKey.toBase58()}&excludeDexes=${EXCLUDE}`
  );
  if (!order2?.transaction) throw new Error(`Ultra order2 no tx: ${JSON.stringify(order2).slice(0,100)}`);

  const tx2Buf = Buffer.from(order2.transaction, 'base64');
  let tx2;
  try { tx2 = VersionedTransaction.deserialize(tx2Buf); } catch(_) { tx2 = Transaction.from(tx2Buf); }
  tx2.sign([wallet]);

  const exec2 = await jFetch(`${JUP_ULTRA}/execute`, {
    method: 'POST',
    body: JSON.stringify({ signedTransaction: Buffer.from(tx2.serialize()).toString('base64'), requestId: order2.requestId })
  });
  if (exec2?.status !== 'Success') throw new Error(`Leg2 failed: ${exec2?.error || exec2?.status || JSON.stringify(exec2).slice(0,100)}`);
  const sig2    = exec2.signature;
  const outAmt2 = Number(exec2.outputAmount || '0');

  return { sig1, sig2, outAmt1, outAmt2 };
}


// ── Get EXACT P&L for a specific tx via on-chain meta ─────────────────────────
// This is immune to unrelated wallet activity (other token sells, transfers, etc)
async function getTxDelta(sig) {
  try {
    await new Promise(r => setTimeout(r, 3000)); // Wait 3s for confirmation
    const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!tx?.meta) return null;
    const pre  = tx.meta.preBalances[0];   // wallet SOL before tx
    const post = tx.meta.postBalances[0];  // wallet SOL after tx
    return (post - pre) / 1e9;             // net SOL change for THIS tx only
  } catch(_) { return null; }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  while (!cachedBH) await new Promise(r=>setTimeout(r,100));

  const balBefore = (await conn.getBalance(wallet.publicKey)) / 1e9;
  const endTime   = Date.now() + RUN_MS;
  const trades    = [];
  const oppsFound = [];

  let cycle = 0, scanTotal = 0;
  let bestGross = 0, bestToken = '';
  const tokenBest = {};
  TOKENS.forEach(t => { tokenBest[t.symbol] = 0; });

  console.log('\n' + '═'.repeat(70));
  console.log('  🔥 GENUINE ARB v3 — Confirmed P&L Edition');
  console.log('═'.repeat(70));
  console.log(`  Wallet:       ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance:      ${balBefore.toFixed(6)} SOL`);
  console.log(`  Trade size:   ${TRADE_SOL} SOL`);
  console.log(`  Min profit:   ${MIN_PROFIT} SOL`);
  console.log(`  Execution:    Jupiter Ultra /execute (confirmed inclusion)`);
  console.log(`  P&L method:   getTransaction(sig) per-tx — immune to wallet noise`);
  console.log(`  Tokens:       ${TOKENS.length} validated`);
  console.log(`  Slippage:     ${SLIP_BPS} BPS`);
  console.log('═'.repeat(70));
  console.log('\n  Scanning... [periodically shows best spread per token]\n');

  // Scan in sequential token batches to avoid rate limits
  const BATCH_SIZE = 6; // scan 6 tokens at a time

  while (Date.now() < endTime) {
    cycle++;

    // Scan tokens in batches of BATCH_SIZE in parallel, then next batch
    const allResults = [];
    for (let i = 0; i < TOKENS.length; i += BATCH_SIZE) {
      const batch = TOKENS.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(t => scanToken(t.symbol, t.mint)));
      allResults.push(...results);
      if (i + BATCH_SIZE < TOKENS.length) await new Promise(r => setTimeout(r, 100));
    }
    scanTotal += TOKENS.length;

    allResults.filter(Boolean).forEach(r => {
      if (r.gross > (tokenBest[r.symbol]||0)) tokenBest[r.symbol] = r.gross;
      if (r.gross > bestGross) { bestGross = r.gross; bestToken = r.symbol; }
    });

    const opps = allResults.filter(r => r !== null && r.net >= MIN_PROFIT).sort((a,b) => b.net - a.net);

    if (!opps.length) {
      if (cycle % 10 === 0) {
        const remaining = Math.round((endTime - Date.now()) / 1000);
        const leaders = Object.entries(tokenBest)
          .filter(([,v]) => v > 0).sort(([,a],[,b]) => b-a).slice(0, 5)
          .map(([s,v]) => `${s}:${v.toFixed(5)}`).join(' ');
        process.stdout.write(`\r  [${remaining}s] ${scanTotal.toLocaleString()} scans | ${leaders || 'scanning...'}`);
        TOKENS.forEach(t => { tokenBest[t.symbol] = 0; });
      }
      await new Promise(r => setTimeout(r, SCAN_MS));
      continue;
    }

    const best = opps[0];
    oppsFound.push({ ...best, ts: Date.now() });
    const pct = ((best.net / TRADE_SOL) * 100).toFixed(4);
    process.stdout.write(`\n\n  🎯 ARB! ${best.symbol}  net:+${best.net.toFixed(6)} SOL (${pct}%)  gross:+${best.gross.toFixed(6)}\n`);
    process.stdout.write(`  ⚡ Executing via Jupiter Ultra (2-leg managed swap)...\n`);

    try {
      const t0     = Date.now();
      const result = await executeUltra(best);
      const execMs = Date.now() - t0;

      console.log(`  ✅ LEG1 confirmed: ${result.sig1.slice(0,20)}...`);
      console.log(`  ✅ LEG2 confirmed: ${result.sig2.slice(0,20)}...`);
      console.log(`  🔗 https://solscan.io/tx/${result.sig1}`);
      console.log(`  🔗 https://solscan.io/tx/${result.sig2}`);
      console.log(`  ⏱️  Total execute: ${execMs}ms`);

      // Get EXACT per-tx deltas — not wallet balance diff
      const [delta1, delta2] = await Promise.all([
        getTxDelta(result.sig1),
        getTxDelta(result.sig2),
      ]);
      const totalDelta = (delta1 || 0) + (delta2 || 0);

      trades.push({ symbol: best.symbol, sig1: result.sig1, sig2: result.sig2,
                    expectedNet: best.net, leg1Delta: delta1, leg2Delta: delta2,
                    totalDelta, execMs });

      const runningPnl = trades.reduce((s,t) => s + (t.totalDelta||0), 0);
      console.log(`  📊 LEG1 Δ: ${delta1!==null?(delta1>=0?'+':'')+delta1.toFixed(6):'confirming...'}`);
      console.log(`  📊 LEG2 Δ: ${delta2!==null?(delta2>=0?'+':'')+delta2.toFixed(6):'confirming...'}`);
      console.log(`  💰 Net:    ${totalDelta>=0?'+':''}${totalDelta.toFixed(6)} SOL  |  Running P&L: ${runningPnl>=0?'+':''}${runningPnl.toFixed(6)} SOL`);
      process.stdout.write('\n  Resuming scan...\n');
    } catch(e) {
      console.log(`  ❌ Exec failed: ${e.message.slice(0,120)}`);
      trades.push({ symbol: best.symbol, sig1: null, sig2: null, expectedNet: best.net, totalDelta: 0, execMs: 0, error: e.message });
    }

    await new Promise(r => setTimeout(r, SCAN_MS));
  }

  // ── Final Report ──────────────────────────────────────────────────────────
  const balAfter  = (await conn.getBalance(wallet.publicKey)) / 1e9;
  const txPnl     = trades.reduce((s,t) => s + (t.totalDelta||0), 0);
  const actualPnl = balAfter - balBefore; // total wallet change (includes unrelated activity)

  console.log('\n\n' + '═'.repeat(70));
  console.log('  📊 GENUINE ARB v3 — FINAL REPORT');
  console.log('═'.repeat(70));
  console.log(`  Wallet balance change:  ${actualPnl>=0?'+':''}${actualPnl.toFixed(6)} SOL  (includes ALL wallet activity)`);
  console.log(`  Arb-specific P&L:       ${txPnl>=0?'+':''}${txPnl.toFixed(6)} SOL  (per-tx confirmed only)`);
  console.log(`  Scans:                  ${scanTotal.toLocaleString()} quotes`);
  console.log(`  Opps detected:          ${oppsFound.length}`);
  console.log(`  Trades executed:        ${trades.length}`);
  console.log(`  Best quote spread:      +${bestGross.toFixed(6)} SOL on ${bestToken}`);
  console.log('─'.repeat(70));

  if (trades.length > 0) {
    console.log('\n  PER-TRADE BREAKDOWN (per-tx confirmed, not wallet diff):');
    trades.forEach((t,i) => {
      const status = t.error ? '❌' : (t.totalDelta > 0 ? '✅' : t.totalDelta === 0 ? '⚠️ ' : '📉');
      console.log(`  [${i+1}] ${status} ${t.symbol}  expected:+${t.expectedNet.toFixed(6)}  leg1:${t.leg1Delta!==null?(t.leg1Delta>=0?'+':'')+t.leg1Delta?.toFixed(6):'n/a'}  leg2:${t.leg2Delta!==null?(t.leg2Delta>=0?'+':'')+t.leg2Delta?.toFixed(6):'n/a'}  net:${t.totalDelta>=0?'+':''}${t.totalDelta.toFixed(6)}`);
      if (t.sig1) { console.log(`       LEG1: https://solscan.io/tx/${t.sig1}`); }
      if (t.sig2) { console.log(`       LEG2: https://solscan.io/tx/${t.sig2}`); }
    });
  } else {
    console.log('\n  ⚠️  No arb above threshold. Market very efficient this window.');
    console.log(`  Best spread: +${bestGross.toFixed(6)} SOL on ${bestToken} (threshold: +${MIN_PROFIT} SOL)`);
  }
  console.log('\n' + '═'.repeat(70) + '\n');
  fs.writeFileSync('./arb5min_v3_result.json', JSON.stringify({ trades, oppsFound, stats:{scanTotal, txPnl, actualPnl, bestGross, bestToken}}, null, 2));
  console.log('  📄 arb5min_v3_result.json');
}

main().catch(e => { console.error('\n❌ FATAL:', e.message); process.exit(1); });
