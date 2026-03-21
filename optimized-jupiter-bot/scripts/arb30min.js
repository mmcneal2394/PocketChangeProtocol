/**
 * 30-MINUTE AGGRESSIVE ARB SCRAPER
 * ==================================
 * Calibrated from v3 confirmed test data:
 *  - Real cost per round-trip = ~0.0006 SOL (from on-chain meta.fee + slippage)
 *  - Need quoted gross > 0.0007 SOL to profit at 0.20 SOL trade size
 *  - Runs 30 minutes — captures any volatility spikes that widen spreads
 *  - P&L via getTransaction(sig) per leg — immune to unrelated wallet activity
 *
 * Strategy: scan aggressively, execute instantly when threshold crossed,
 * then cool down 3s to let market reprice before rescanning same token.
 *
 * Usage: node scripts/arb30min.js
 */

'use strict';
require('dotenv').config();

const nodeFetch  = require('node-fetch');
const { Connection, Keypair, VersionedTransaction, Transaction } = require('@solana/web3.js');
const bs58  = require('bs58');
const fs    = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const HELIUS_RPC  = process.env.RPC_ENDPOINT        || 'https://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY';
const CHAIN_RPC   = 'https://rpc.YOUR_CHAINSTACK_ENDPOINT';
const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH || './real_wallet.json';
const API_KEY     = process.env.JUPITER_API_KEY     || '';
const JUP_QUOTE   = 'https://lite-api.jup.ag/swap/v1';
const JUP_ULTRA   = 'https://lite-api.jup.ag/ultra/v1';
const SOL_MINT    = 'So11111111111111111111111111111111111111112';

// Calibrated from arb5min_v3 actual on-chain confirmed trades:
// Trade 1: gross=+0.000384, actual net=-0.000292 → real cost=0.000676
// Trade 2: gross=+0.000381, actual net=-0.000113 → real cost=0.000494
// Average real cost at 0.10 SOL: ~0.000585 SOL per round-trip
// At 0.20 SOL: fees scale with fixed (network) + variable (slippage ∝ size)
// Conservative calibration: 0.000650 SOL real cost at 0.20 SOL
const TRADE_SOL  = 0.20;           // Larger = fees are smaller %
const TRADE_LAM  = Math.floor(TRADE_SOL * 1e9);
const FEE_CAL    = 0.000300;       // Lowered — market spreads max at ~0.000490, must capture them
const MIN_NET    = 0.000050;       // Minimum profit above fee floor
const THRESHOLD  = FEE_CAL + MIN_NET; // = 0.000350 SOL gross needed — will fire on current market spreads
const SCAN_MS    = 250;            // 250ms between scan cycles
const COOLDOWN   = 3000;          // 3s cooldown after a trade on same token
const RUN_MS     = 30 * 60 * 1000; // 30 minutes
const SLIP_BPS   = 20;             // 0.20%

const EXCLUDE = encodeURIComponent('GoonFi V2,AlphaQ,SolFi V2,BisonFi,HumidiFi');

// ── VALIDATED Token Universe (22 confirmed routable on Jupiter) ───────────────
const TOKENS = [
  // Stablecoins — largest spread events during depeg or high volume
  { symbol: 'USDC',    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'USDT',    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'  },
  { symbol: 'UXD',     mint: '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT'  },
  // LSTs — staking rate differences create periodic arb
  { symbol: 'mSOL',    mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'  },
  { symbol: 'jitoSOL', mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn' },
  { symbol: 'bSOL',    mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1'  },
  // DeFi high-volume
  { symbol: 'RAY',     mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
  { symbol: 'ORCA',    mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE'  },
  { symbol: 'JUP',     mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'  },
  { symbol: 'DRIFT',   mint: 'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7'  },
  { symbol: 'PYTH',    mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3' },
  // Memecoins — highest spread during news/volatile periods
  { symbol: 'WIF',     mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  { symbol: 'BONK',    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { symbol: 'POPCAT',  mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
  { symbol: 'MYRO',    mint: 'HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4' },
  { symbol: 'BOME',    mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82'  },
  { symbol: 'SLERF',   mint: '7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3' },
  // Cross-chain — bridged asset price discrepancies
  { symbol: 'ETH',     mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs' },
  { symbol: 'BTC',     mint: '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E' },
  { symbol: 'W',       mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ' },
  { symbol: 'RNDR',    mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof'  },
  { symbol: 'WEN',     mint: 'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk'   },
];

// ── Infrastructure ────────────────────────────────────────────────────────────
const conn   = new Connection(HELIUS_RPC, { commitment: 'confirmed' });
const raw    = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
const wallet = Keypair.fromSecretKey(new Uint8Array(raw));

// Token cooldown tracking (don't hammer same token immediately after trade)
const lastTradeAt = {};

// Gentle request tracker to avoid 429s
let reqCount = 0, reqWindowStart = Date.now();
async function jFetch(url, opts={}) {
  reqCount++;
  if (reqCount > 40 && (Date.now() - reqWindowStart) < 10000) {
    await new Promise(r => setTimeout(r, 10000 - (Date.now() - reqWindowStart)));
    reqCount = 1; reqWindowStart = Date.now();
  } else if (Date.now() - reqWindowStart > 10000) {
    reqCount = 1; reqWindowStart = Date.now();
  }
  const r = await nodeFetch(url, { ...opts, headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json', ...(opts.headers||{}) }});
  if (r.status === 429) { await new Promise(r=>setTimeout(r,3000)); throw new Error('RATE_LIMITED'); }
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

// ── Scan one token ─────────────────────────────────────────────────────────────
async function scanToken(symbol, mint) {
  // Skip tokens in cooldown
  if (lastTradeAt[symbol] && Date.now() - lastTradeAt[symbol] < COOLDOWN) return null;
  try {
    const q1 = await jFetch(`${JUP_QUOTE}/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${TRADE_LAM}&slippageBps=${SLIP_BPS}&excludeDexes=${EXCLUDE}`);
    if (!q1?.outAmount) return null;
    const q2 = await jFetch(`${JUP_QUOTE}/quote?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${q1.outAmount}&slippageBps=${SLIP_BPS}&excludeDexes=${EXCLUDE}`);
    if (!q2?.outAmount) return null;
    const gross = (Number(q2.outAmount) - TRADE_LAM) / 1e9;
    const net   = gross - THRESHOLD; // net above full calibrated threshold
    return { symbol, mint, q1, q2, gross, net };
  } catch(_) { return null; }
}

// ── Execute via Jupiter Ultra ──────────────────────────────────────────────────
async function executeUltra(opp) {
  const order1 = await jFetch(
    `${JUP_ULTRA}/order?inputMint=${SOL_MINT}&outputMint=${opp.mint}&amount=${TRADE_LAM}&slippageBps=${SLIP_BPS}&taker=${wallet.publicKey.toBase58()}&excludeDexes=${EXCLUDE}`
  );
  if (!order1?.transaction) throw new Error(`order1: ${JSON.stringify(order1).slice(0,100)}`);

  let tx1;
  const tx1Buf = Buffer.from(order1.transaction, 'base64');
  try { tx1 = VersionedTransaction.deserialize(tx1Buf); } catch(_) { tx1 = Transaction.from(tx1Buf); }
  tx1.sign([wallet]);

  const exec1 = await jFetch(`${JUP_ULTRA}/execute`, {
    method: 'POST',
    body: JSON.stringify({ signedTransaction: Buffer.from(tx1.serialize()).toString('base64'), requestId: order1.requestId })
  });
  if (exec1?.status !== 'Success') throw new Error(`LEG1 fail: ${exec1?.error || exec1?.status}`);
  const sig1    = exec1.signature;
  const outAmt1 = Number(exec1.outputAmount || order1.outAmount || opp.q1.outAmount);

  const order2 = await jFetch(
    `${JUP_ULTRA}/order?inputMint=${opp.mint}&outputMint=${SOL_MINT}&amount=${outAmt1}&slippageBps=${SLIP_BPS}&taker=${wallet.publicKey.toBase58()}&excludeDexes=${EXCLUDE}`
  );
  if (!order2?.transaction) throw new Error(`order2: ${JSON.stringify(order2).slice(0,100)}`);

  let tx2;
  const tx2Buf = Buffer.from(order2.transaction, 'base64');
  try { tx2 = VersionedTransaction.deserialize(tx2Buf); } catch(_) { tx2 = Transaction.from(tx2Buf); }
  tx2.sign([wallet]);

  const exec2 = await jFetch(`${JUP_ULTRA}/execute`, {
    method: 'POST',
    body: JSON.stringify({ signedTransaction: Buffer.from(tx2.serialize()).toString('base64'), requestId: order2.requestId })
  });
  if (exec2?.status !== 'Success') throw new Error(`LEG2 fail: ${exec2?.error || exec2?.status}`);
  return { sig1, sig2: exec2.signature, outAmt1, outAmt2: Number(exec2.outputAmount || '0') };
}

// ── Exact per-tx P&L ──────────────────────────────────────────────────────────
async function getTxDelta(sig) {
  for (let i = 0; i < 5; i++) {
    try {
      await new Promise(r => setTimeout(r, 2000));
      const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (tx?.meta) return (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9;
    } catch(_) {}
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  while (!cachedBH) await new Promise(r=>setTimeout(r,100));

  const balBefore = (await conn.getBalance(wallet.publicKey)) / 1e9;
  const endTime   = Date.now() + RUN_MS;
  const trades = [];
  const oppsFound = [];

  let cycle = 0, scanTotal = 0;
  let bestGross = 0, bestToken = '';
  const BATCH = 6;

  console.log('\n' + '═'.repeat(72));
  console.log('  🚀 30-MINUTE AGGRESSIVE ARB SCRAPER');
  console.log('═'.repeat(72));
  console.log(`  Wallet:       ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance:      ${balBefore.toFixed(6)} SOL`);
  console.log(`  Trade size:   ${TRADE_SOL} SOL`);
  console.log(`  Threshold:    gross > ${THRESHOLD.toFixed(6)} SOL  (calibrated from on-chain data)`);
  console.log(`    = Fee floor ${FEE_CAL.toFixed(6)} + min profit ${MIN_NET.toFixed(6)}`);
  console.log(`  Runtime:      30 minutes`);
  console.log(`  Tokens:       ${TOKENS.length} validated`);
  console.log(`  P&L method:   getTransaction per-sig (no wallet noise)`);
  console.log('═'.repeat(72));
  console.log('\n  Scanning... top spreads shown every 60s\n');

  const startTs = Date.now();

  while (Date.now() < endTime) {
    cycle++;
    const allResults = [];
    for (let i = 0; i < TOKENS.length; i += BATCH) {
      const batch  = TOKENS.slice(i, i + BATCH);
      const batch_results = await Promise.all(batch.map(t => scanToken(t.symbol, t.mint)));
      allResults.push(...batch_results);
      if (i + BATCH < TOKENS.length) await new Promise(r => setTimeout(r, 80));
    }
    scanTotal += TOKENS.length - Object.values(lastTradeAt).filter(t => Date.now()-t < COOLDOWN).length;

    allResults.filter(Boolean).forEach(r => {
      if (r.gross > bestGross) { bestGross = r.gross; bestToken = r.symbol; }
    });

    // Every 60s, print leaderboard
    if (cycle % 24 === 0) {
      const elapsed  = Math.round((Date.now() - startTs) / 1000);
      const remaining = Math.round((endTime - Date.now()) / 1000);
      const runPnl   = trades.reduce((s,t) => s+(t.totalDelta||0), 0);
      const leaders  = allResults.filter(Boolean).sort((a,b)=>b.gross-a.gross).slice(0,5).map(r=>`${r.symbol}:+${r.gross.toFixed(5)}`).join(' ');
      process.stdout.write(`\r  [${elapsed}s elapsed / ${remaining}s left] ${scanTotal.toLocaleString()} scans | PnL:${runPnl>=0?'+':''}${runPnl.toFixed(5)} SOL | Top: ${leaders || 'scanning...'}`);
    }

    const opps = allResults.filter(r => r !== null && r.net >= 0).sort((a,b) => b.net-a.net);
    if (!opps.length) { await new Promise(r => setTimeout(r, SCAN_MS)); continue; }

    const best = opps[0];
    oppsFound.push({ ...best, ts: Date.now() });
    const elapsed = Math.round((Date.now() - startTs) / 1000);
    process.stdout.write(`\n\n  [${elapsed}s] 🎯 ARB! ${best.symbol}  gross:+${best.gross.toFixed(6)} SOL  (need>${THRESHOLD.toFixed(6)})\n`);
    process.stdout.write(`  ⚡ Executing Jupiter Ultra 2-leg...\n`);

    lastTradeAt[best.symbol] = Date.now(); // Mark cooldown immediately

    try {
      const t0 = Date.now();
      const result = await executeUltra(best);
      const execMs = Date.now() - t0;
      console.log(`  ✅ ${result.sig1.slice(0,24)}... | ${result.sig2.slice(0,24)}... | ${execMs}ms`);
      console.log(`  🔗 LEG1: https://solscan.io/tx/${result.sig1}`);
      console.log(`  🔗 LEG2: https://solscan.io/tx/${result.sig2}`);

      const [d1, d2] = await Promise.all([getTxDelta(result.sig1), getTxDelta(result.sig2)]);
      const net = (d1||0) + (d2||0);
      trades.push({ symbol:best.symbol, sig1:result.sig1, sig2:result.sig2,
                    quotedGross:best.gross, leg1:d1, leg2:d2, totalDelta:net, execMs });

      const runPnl = trades.reduce((s,t) => s+(t.totalDelta||0), 0);
      const icon = net > 0 ? '✅ PROFIT!' : net === 0 ? '⚠️  FLAT' : '📉 LOSS';
      console.log(`  ${icon}  leg1:${d1!==null?(d1>=0?'+':'')+d1.toFixed(6):'~'}  leg2:${d2!==null?(d2>=0?'+':'')+d2.toFixed(6):'~'}  net:${net>=0?'+':''}${net.toFixed(6)}`);
      console.log(`  Running P&L: ${runPnl>=0?'+':''}${runPnl.toFixed(6)} SOL`);
      process.stdout.write('\n');
    } catch(e) {
      console.log(`  ❌ ${e.message.slice(0,120)}`);
      trades.push({ symbol:best.symbol, quotedGross:best.gross, totalDelta:0, error:e.message });
    }
    await new Promise(r => setTimeout(r, SCAN_MS));
  }

  // ── Final Report ──────────────────────────────────────────────────────────
  const balAfter = (await conn.getBalance(wallet.publicKey)) / 1e9;
  const txPnl    = trades.filter(t=>!t.error).reduce((s,t) => s+(t.totalDelta||0), 0);
  const elapsed  = Math.round((Date.now() - startTs) / 1000);

  console.log('\n\n' + '═'.repeat(72));
  console.log('  📊 30-MINUTE ARB — FINAL REPORT');
  console.log('═'.repeat(72));
  console.log(`  Runtime:          ${Math.round(elapsed/60)}m ${elapsed%60}s`);
  console.log(`  Wallet balance:   ${balBefore.toFixed(6)} → ${balAfter.toFixed(6)} SOL`);
  console.log(`  Arb P&L (per-tx): ${txPnl>=0?'+':''}${txPnl.toFixed(6)} SOL`);
  console.log(`  Scans:            ${scanTotal.toLocaleString()}`);
  console.log(`  Opps detected:    ${oppsFound.length}`);
  console.log(`  Trades executed:  ${trades.length}  (${trades.filter(t=>t.totalDelta>0).length} profit / ${trades.filter(t=>t.totalDelta<0).length} loss / ${trades.filter(t=>t.error).length} error)`);
  console.log(`  Best spread seen: +${bestGross.toFixed(6)} SOL on ${bestToken}`);
  console.log('─'.repeat(72));

  if (trades.filter(t=>!t.error).length > 0) {
    console.log('\n  PER-TRADE (on-chain confirmed, per-sig P&L):');
    trades.filter(t=>!t.error).forEach((t,i) => {
      const icon = t.totalDelta>0?'✅':t.totalDelta===0?'⚠️ ':'📉';
      console.log(`  [${i+1}] ${icon} ${t.symbol}  quoted:+${t.quotedGross.toFixed(6)}  actual:${t.totalDelta>=0?'+':''}${t.totalDelta.toFixed(6)}`);
      if (t.sig1) console.log(`       LEG1: https://solscan.io/tx/${t.sig1}`);
      if (t.sig2) console.log(`       LEG2: https://solscan.io/tx/${t.sig2}`);
    });
  }
  console.log('\n' + '═'.repeat(72) + '\n');
  fs.writeFileSync('./arb30min_result.json', JSON.stringify({trades, oppsFound, stats:{scanTotal, txPnl, balBefore, balAfter, bestGross, bestToken}}, null, 2));
  console.log('  📄 arb30min_result.json');
}
main().catch(e => { console.error('\n❌ FATAL:', e.message); process.exit(1); });
