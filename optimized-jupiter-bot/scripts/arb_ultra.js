/**
 * ULTRA ARB SCANNER — Quote Price = Execution Price
 * ==================================================
 * Key insight: /ultra/v1/order returns the ACTUAL price Jupiter Ultra
 * will execute at (including platform fee + DEX routing + slippage).
 * So we use it for BOTH scanning and execution — zero gap between what
 * we see and what lands on-chain.
 *
 * Flow per token per cycle:
 *  1. GET /ultra/v1/order  SOL→TOKEN   → save tx1, requestId1, outAmt1
 *  2. GET /ultra/v1/order  TOKEN→SOL   → save tx2, requestId2, outAmt2
 *  3. If outAmt2 > TRADE_LAM + MIN_PROFIT_LAM:
 *       sign tx1 → POST /execute (with requestId1)
 *       use real outputAmount from exec1 for leg2 amount
 *       sign tx2 → POST /execute (with requestId2)
 *  4. getTxDelta(sig) per leg for true P&L
 *
 * Ultra /order transactions expire after ~30 slots (~13s), so we execute
 * immediately after a positive scan — no stale quotes.
 *
 * Usage: node scripts/arb_ultra.js
 */

'use strict';
require('dotenv').config();

const nodeFetch  = require('node-fetch');
const { Connection, Keypair, VersionedTransaction, Transaction } = require('@solana/web3.js');
const fs    = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const HELIUS_RPC  = process.env.RPC_ENDPOINT        || 'https://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY';
const CHAIN_RPC   = 'https://rpc.YOUR_CHAINSTACK_ENDPOINT';
const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH || './real_wallet.json';
const API_KEY     = process.env.JUPITER_API_KEY     || '';
const ULTRA       = 'https://lite-api.jup.ag/ultra/v1';
const SOL_MINT    = 'So11111111111111111111111111111111111111112';

const TRADE_SOL       = 0.20;                   // trade size
const TRADE_LAM       = Math.floor(TRADE_SOL * 1e9);
const MIN_PROFIT_LAM  = 20_000;                 // 0.00002 SOL min net — any real positive
const SCAN_DELAY_MS   = 800;                    // 800ms between Ultra /order calls — stays under rate limit
const COOLDOWN_MS     = 5_000;                  // per-token cooldown after trade
const RUN_MS          = 30 * 60 * 1000;         // 30 minutes
const SLIP_BPS        = 20;                     // 0.20%

const EXCLUDE = encodeURIComponent('GoonFi V2,AlphaQ,SolFi V2,BisonFi,HumidiFi');

// ── Top 12 Tokens (highest spread observed from /quote scans) ─────────────────
const TOKENS = [
  { symbol: 'USDC',    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'USDT',    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'  },
  { symbol: 'jitoSOL', mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn' },
  { symbol: 'mSOL',    mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'  },
  { symbol: 'bSOL',    mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1'  },
  { symbol: 'JUP',     mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'  },
  { symbol: 'WIF',     mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  { symbol: 'BONK',    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { symbol: 'RAY',     mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
  { symbol: 'ETH',     mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs' },
  { symbol: 'POPCAT',  mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
  { symbol: 'MYRO',    mint: 'HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4' },
];

// ── Infrastructure ────────────────────────────────────────────────────────────
const conn   = new Connection(HELIUS_RPC, { commitment: 'confirmed' });
const raw    = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
const wallet = Keypair.fromSecretKey(new Uint8Array(raw));

const lastTradeAt = {};

// Request throttle — Ultra has separate rate limits from /swap, keep gentle
let reqTs = [];
async function uFetch(url, opts={}) {
  // Sliding window: max 30 requests per 10 seconds
  const now = Date.now();
  reqTs = reqTs.filter(t => now - t < 10000);
  if (reqTs.length >= 30) {
    await new Promise(r => setTimeout(r, 10000 - (now - reqTs[0]) + 50));
  }
  reqTs.push(Date.now());
  const r = await nodeFetch(url, { ...opts, headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json', ...(opts.headers||{}) }});
  if (r.status === 429) {
    await new Promise(r => setTimeout(r, 2000));
    throw new Error('RATE_LIMITED');
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── Exact per-tx P&L ─────────────────────────────────────────────────────────
async function getTxDelta(sig) {
  for (let i = 0; i < 6; i++) {
    try {
      await new Promise(r => setTimeout(r, 2000));
      const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (tx?.meta) return (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9;
    } catch(_) {}
  }
  return null;
}

// ── Scan one token via Ultra /order (real execution price) ────────────────────
async function scanToken(symbol, mint) {
  if (lastTradeAt[symbol] && Date.now() - lastTradeAt[symbol] < COOLDOWN_MS) return null;
  try {
    // LEG 1 quote: SOL → TOKEN
    const o1 = await uFetch(
      `${ULTRA}/order?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${TRADE_LAM}&slippageBps=${SLIP_BPS}&taker=${wallet.publicKey.toBase58()}&excludeDexes=${EXCLUDE}`
    );
    if (!o1?.transaction || !o1?.outAmount) return null;

    // LEG 2 quote using o1's exact output as input: TOKEN → SOL
    const outAmt1 = Number(o1.outAmount);
    const o2 = await uFetch(
      `${ULTRA}/order?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${outAmt1}&slippageBps=${SLIP_BPS}&taker=${wallet.publicKey.toBase58()}&excludeDexes=${EXCLUDE}`
    );
    if (!o2?.transaction || !o2?.outAmount) return null;

    const outAmt2  = Number(o2.outAmount);
    const netLam   = outAmt2 - TRADE_LAM;  // positive = profitable at Ultra pricing
    const netSol   = netLam / 1e9;

    return { symbol, mint, o1, o2, outAmt1, outAmt2, netLam, netSol };
  } catch(_) { return null; }
}

// ── Execute immediately using the orders from the scan ────────────────────────
async function executeOrders(opp) {
  // Sign LEG 1 (use o1 transaction from scan — still fresh within ~13s)
  let tx1;
  const tx1Buf = Buffer.from(opp.o1.transaction, 'base64');
  try { tx1 = VersionedTransaction.deserialize(tx1Buf); } catch(_) { tx1 = Transaction.from(tx1Buf); }
  tx1.sign([wallet]);

  const exec1 = await uFetch(`${ULTRA}/execute`, {
    method: 'POST',
    body: JSON.stringify({ signedTransaction: Buffer.from(tx1.serialize()).toString('base64'), requestId: opp.o1.requestId })
  });
  if (exec1?.status !== 'Success') throw new Error(`LEG1: ${exec1?.error || exec1?.status}`);
  const sig1    = exec1.signature;
  const realOut1 = Number(exec1.outputAmount || opp.outAmt1);

  // Re-quote LEG 2 fresh with the real output amount (avoids stale o2 if > a few seconds)
  const o2fresh = await uFetch(
    `${ULTRA}/order?inputMint=${opp.mint}&outputMint=${SOL_MINT}&amount=${realOut1}&slippageBps=${SLIP_BPS}&taker=${wallet.publicKey.toBase58()}&excludeDexes=${EXCLUDE}`
  );
  if (!o2fresh?.transaction) throw new Error(`LEG2 re-quote failed: ${JSON.stringify(o2fresh).slice(0,100)}`);

  let tx2;
  const tx2Buf = Buffer.from(o2fresh.transaction, 'base64');
  try { tx2 = VersionedTransaction.deserialize(tx2Buf); } catch(_) { tx2 = Transaction.from(tx2Buf); }
  tx2.sign([wallet]);

  const exec2 = await uFetch(`${ULTRA}/execute`, {
    method: 'POST',
    body: JSON.stringify({ signedTransaction: Buffer.from(tx2.serialize()).toString('base64'), requestId: o2fresh.requestId })
  });
  if (exec2?.status !== 'Success') throw new Error(`LEG2: ${exec2?.error || exec2?.status}`);
  return { sig1, sig2: exec2.signature, realOut1, realOut2: Number(exec2.outputAmount || '0') };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const balBefore = (await conn.getBalance(wallet.publicKey)) / 1e9;
  const endTime   = Date.now() + RUN_MS;
  const trades = [], oppsFound = [];
  let cycle = 0, scanTotal = 0;
  let bestNetSol = -999, bestToken = '';

  console.log('\n' + '═'.repeat(72));
  console.log('  ⚡ ULTRA ARB SCANNER — Quote Price = Execution Price');
  console.log('═'.repeat(72));
  console.log(`  Wallet:        ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance:       ${balBefore.toFixed(6)} SOL`);
  console.log(`  Trade size:    ${TRADE_SOL} SOL`);
  console.log(`  Min profit:    +${(MIN_PROFIT_LAM/1e9).toFixed(6)} SOL  (post-all-fees)`);
  console.log(`  Scan method:   /ultra/v1/order (real execution price)`);
  console.log(`  Execute:       Same order tx, immediate sign & submit`);
  console.log(`  Runtime:       30 minutes`);
  console.log(`  Tokens:        ${TOKENS.length} validated`);
  console.log('═'.repeat(72));
  console.log('\n  Scanning... [Ultra-priced net shown — negative = Ultra would lose us money]\n');

  while (Date.now() < endTime) {
    cycle++;

    // Sequential scan — one token at a time, 800ms between calls
    // = 12 tokens × 2 calls × 800ms = ~19 seconds per full sweep
    for (const token of TOKENS) {
      if (Date.now() >= endTime) break;

      const result = await scanToken(token.symbol, token.mint);
      if (result !== null) {
        scanTotal++;
        if (result.netSol > bestNetSol) { bestNetSol = result.netSol; bestToken = result.symbol; }
      }

      // Status every 12 token scans
      if (scanTotal > 0 && scanTotal % 12 === 0) {
        const remaining = Math.round((endTime - Date.now()) / 1000);
        const elapsed   = Math.round((Date.now() - (endTime - RUN_MS)) / 1000);
        const runPnl    = trades.reduce((s,t) => s+(t.totalDelta||0), 0);
        process.stdout.write(`\r  [${elapsed}s/${remaining}s left] ${scanTotal} scans | P&L:${runPnl>=0?'+':''}${runPnl.toFixed(5)} | Best Ultra-net: ${bestNetSol>=0?'+':''}${bestNetSol.toFixed(5)} on ${bestToken||'?'}`);
      }

      // Profitable opportunity — execute immediately while quote is still fresh
      if (result && result.netLam >= MIN_PROFIT_LAM) {
        const elapsed = Math.round((Date.now() - (endTime - RUN_MS)) / 1000);
        oppsFound.push({ ...result, ts: Date.now() });
        process.stdout.write(`\n\n  [${elapsed}s] 🎯 ULTRA ARB! ${result.symbol}  Ultra-net: +${result.netSol.toFixed(6)} SOL\n`);
        process.stdout.write(`  ⚡ Executing immediately...\n`);
        lastTradeAt[result.symbol] = Date.now();
        try {
          const t0     = Date.now();
          const res    = await executeOrders(result);
          const execMs = Date.now() - t0;
          console.log(`  ✅ SIG1: https://solscan.io/tx/${res.sig1}`);
          console.log(`  ✅ SIG2: https://solscan.io/tx/${res.sig2}`);
          const [d1, d2] = await Promise.all([getTxDelta(res.sig1), getTxDelta(res.sig2)]);
          const net = (d1||0) + (d2||0);
          trades.push({ symbol:result.symbol, sig1:res.sig1, sig2:res.sig2,
                        ultraNet:result.netSol, leg1:d1, leg2:d2, totalDelta:net, execMs });
          const runPnl = trades.reduce((s,t)=>s+(t.totalDelta||0), 0);
          const icon   = net>0?'✅ PROFIT!':net===0?'⚠️  FLAT':'📉 LOSS';
          console.log(`  ${icon}  leg1:${d1!==null?(d1>=0?'+':'')+d1.toFixed(6):'~'}  leg2:${d2!==null?(d2>=0?'+':'')+d2.toFixed(6):'~'}  net:${net>=0?'+':''}${net.toFixed(6)}`);
          console.log(`  Running P&L: ${runPnl>=0?'+':''}${runPnl.toFixed(6)} SOL\n`);
        } catch(e) {
          console.log(`  ❌ ${e.message.slice(0,140)}`);
          trades.push({ symbol:result.symbol, ultraNet:result.netSol, totalDelta:0, error:e.message });
        }
      }

      await new Promise(r => setTimeout(r, SCAN_DELAY_MS));
    }
  }

  // ── Final ─────────────────────────────────────────────────────────────────
  const balAfter  = (await conn.getBalance(wallet.publicKey)) / 1e9;
  const txPnl     = trades.filter(t=>!t.error).reduce((s,t)=>s+(t.totalDelta||0), 0);

  console.log('\n\n' + '═'.repeat(72));
  console.log('  📊 ULTRA ARB — 30-MINUTE FINAL REPORT');
  console.log('═'.repeat(72));
  console.log(`  Balance:          ${balBefore.toFixed(6)} → ${balAfter.toFixed(6)} SOL`);
  console.log(`  Arb P&L (per-tx): ${txPnl>=0?'+':''}${txPnl.toFixed(6)} SOL`);
  console.log(`  Scans:            ${scanTotal}`);
  console.log(`  Opps detected:    ${oppsFound.length}`);
  console.log(`  Trades:           ${trades.length} (${trades.filter(t=>t.totalDelta>0).length}✅ ${trades.filter(t=>t.totalDelta<0&&!t.error).length}📉 ${trades.filter(t=>t.error).length}❌)`);
  console.log(`  Best Ultra-net:   ${bestNetSol>=0?'+':''}${bestNetSol.toFixed(6)} SOL on ${bestToken}`);
  console.log('─'.repeat(72));
  if (trades.length > 0) {
    console.log('\n  PER-TRADE:');
    trades.forEach((t,i) => {
      const icon = t.error?'❌':t.totalDelta>0?'✅':t.totalDelta===0?'⚠️ ':'📉';
      console.log(`  [${i+1}] ${icon} ${t.symbol}  expected:+${t.ultraNet?.toFixed(6)||'?'}  actual:${t.totalDelta>=0?'+':''}${t.totalDelta?.toFixed(6)||'err'}`);
      if (t.sig1) console.log(`       🔗 ${t.sig1}`);
      if (t.sig2) console.log(`       🔗 ${t.sig2}`);
    });
  } else {
    console.log(`\n  No profitable opps found at Ultra pricing in this window.`);
    console.log(`  Best Ultra-net seen: ${bestNetSol>=0?'+':''}${bestNetSol.toFixed(6)} SOL on ${bestToken}`);
    console.log(`  (Negative means Ultra's own fee > DEX spread — market too efficient for arb right now)`);
  }
  console.log('\n' + '═'.repeat(72) + '\n');
  fs.writeFileSync('./arb_ultra_result.json', JSON.stringify({trades, oppsFound, stats:{scanTotal, txPnl, balBefore, balAfter, bestNetSol, bestToken}}, null, 2));
  console.log('  📄 arb_ultra_result.json');
}
main().catch(e => { console.error('\n❌ FATAL:', e.message); process.exit(1); });
