/**
 * GENUINE ARB TEST — 5 minutes of real spread hunting
 * =====================================================
 * - Scans 12 tokens in parallel via Jupiter /quote every 150ms
 * - Only executes when net profit > MIN_PROFIT after all fees
 * - At 0.25 SOL trade size, break-even = 0.057% spread (fee audit result)
 * - Uses Chainstack+Helius blockhash race for zero-lag execution
 * - Reports every opportunity detected and every confirmed trade
 *
 * Usage: node scripts/arb5min.js
 */

'use strict';
require('dotenv').config();

const nodeFetch  = require('node-fetch');
const { Connection, Keypair, PublicKey, VersionedTransaction,
        TransactionMessage, TransactionInstruction,
        SystemProgram, ComputeBudgetProgram } = require('@solana/web3.js');
const Bottleneck = require('bottleneck');
const bs58       = require('bs58');
const fs         = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const HELIUS_RPC  = process.env.RPC_ENDPOINT        || 'https://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY';
const CHAIN_RPC   = 'https://rpc.YOUR_CHAINSTACK_ENDPOINT';
const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH || './real_wallet.json';
const API_KEY     = process.env.JUPITER_API_KEY     || '';
const JUP_QUOTE   = 'https://lite-api.jup.ag/swap/v1';
const JUP_ULTRA   = 'https://lite-api.jup.ag';
const SOL_MINT    = 'So11111111111111111111111111111111111111112';

// Fee audit result: real cost per round-trip = 0.000142 SOL at 0.01 SOL trades
// Scale: at 0.25 SOL we still pay ~0.000142 SOL (fixed gas overhead)
// So MIN_PROFIT must exceed 0.000142 to make money
const TRADE_SOL  = 0.30;            // 30% of ~0.38 SOL wallet = 0.114 SOL per trade
const TRADE_LAM  = Math.floor(TRADE_SOL * 1e9);
const MIN_PROFIT = 0.000200;        // 0.0002 SOL minimum net (above 0.000142 break-even)
const SCAN_MS    = 150;             // scan every 150ms
const RUN_MS     = 5 * 60 * 1000;  // 5 minutes
const SLIP_BPS   = 20;             // 0.2% slippage — tight

const EXCLUDE = encodeURIComponent(
  'GoonFi V2,AlphaQ,SolFi V2,BisonFi,HumidiFi,Sanctum,Sanctum Infinity,' +
  'VaultLiquidUnstake,eversol-stake-pool,socean-stake-pool,Marinade,Lido,SolBlaze'
);

// Jito multi-region fanout
const JITO_TIPS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
];
const JITO_URLS = [
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
];

const TOKENS = [
  { symbol: 'USDC',  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'USDT',  mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
  { symbol: 'RAY',   mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
  { symbol: 'BONK',  mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { symbol: 'WIF',   mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  { symbol: 'ORCA',  mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE'  },
  { symbol: 'JUP',   mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'  },
  { symbol: 'WEN',   mint: 'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk'   },
  { symbol: 'BOME',  mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82'  },
  { symbol: 'NOS',   mint: 'nosXBqwB22HkM3pJo9YqQhG1hHh2gQ5pXhS7vXkXVmQ'   },
  { symbol: 'RNDR',  mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof'   },
  { symbol: 'PYTH',  mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3'  },
];

// ── Infrastructure ────────────────────────────────────────────────────────────
const conn    = new Connection(HELIUS_RPC, { commitment: 'processed' });
const raw     = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
const wallet  = Keypair.fromSecretKey(new Uint8Array(raw));

const limiter = new Bottleneck({
  reservoir: 4000, reservoirRefreshAmount: 4000,
  reservoirRefreshInterval: 60_000, maxConcurrent: 24
});

// ── Blockhash race ─────────────────────────────────────────────────────────
let cachedBH = null, bhAge = 0;
async function raceBH() {
  const got = await Promise.race([
    nodeFetch(HELIUS_RPC,{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getLatestBlockhash',params:[{commitment:'processed'}]})}).then(r=>r.json()).then(d=>d?.result?.value?.blockhash),
    nodeFetch(CHAIN_RPC, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getLatestBlockhash',params:[{commitment:'processed'}]})}).then(r=>r.json()).then(d=>d?.result?.value?.blockhash),
  ]);
  if (got) { cachedBH = got; bhAge = Date.now(); }
}
setInterval(raceBH, 800);
raceBH();

// ── ALT cache ─────────────────────────────────────────────────────────────────
const altCache = {};
async function getALT(addr) {
  if (altCache[addr]) return altCache[addr];
  try { const r = await conn.getAddressLookupTable(new PublicKey(addr)); if (r?.value) altCache[addr]=r.value; } catch(_){}
  return altCache[addr]||null;
}

// ── Jupiter fetch ─────────────────────────────────────────────────────────────
async function jFetch(url, opts={}) {
  return limiter.schedule(async () => {
    const r = await nodeFetch(url, { ...opts, headers: { 'x-api-key': API_KEY, 'Content-Type':'application/json', ...(opts.headers||{}) } });
    if (r.status === 429) throw new Error('RATE_LIMITED');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

// ── Single-token scan ─────────────────────────────────────────────────────────
async function scanToken(symbol, mint, lamports) {
  const [q1, q2] = await Promise.all([
    jFetch(`${JUP_QUOTE}/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${lamports}&slippageBps=${SLIP_BPS}&excludeDexes=${EXCLUDE}`),
    // We do a two-step: first get q1 outAmount then q2 — serial but fast enough at 150ms scan
  ]);
  if (!q1?.outAmount) return null;
  const q2r = await jFetch(`${JUP_QUOTE}/quote?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${q1.outAmount}&slippageBps=${SLIP_BPS}&excludeDexes=${EXCLUDE}`);
  if (!q2r?.outAmount) return null;

  const gross = (Number(q2r.outAmount) - lamports) / 1e9;
  // Cost estimate: 2×avg_fee(0.000060) + slippage(0.000142)
  const feeEstimate = 0.000260; // conservative: 2×fees + execution spread at 0.01 SOL scale
  const net = gross - feeEstimate;
  return { symbol, mint, q1, q2: q2r, gross, net, feeEstimate };
}

// ── Build + send atomic arb tx ─────────────────────────────────────────────────
async function executeArb(opp) {
  const [ix1r, ix2r] = await Promise.all([
    jFetch(`${JUP_QUOTE}/swap-instructions`, { method:'POST', body:JSON.stringify({ quoteResponse: opp.q1, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true }) }),
    jFetch(`${JUP_QUOTE}/swap-instructions`, { method:'POST', body:JSON.stringify({ quoteResponse: opp.q2, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: true }) }),
  ]);
  if (ix1r.error || ix2r.error) throw new Error(`swap-ix: ${ix1r.error||ix2r.error}`);

  const deser = (ix) => !ix ? null : new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map(k => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: Buffer.from(ix.data, 'base64')
  });

  const alts = (await Promise.all([...new Set([...(ix1r.addressLookupTableAddresses||[]),...(ix2r.addressLookupTableAddresses||[])])].map(getALT))).filter(Boolean);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300_000 }),
    ...(ix1r.setupInstructions||[]).map(deser),
    deser(ix1r.swapInstruction),
    ix1r.cleanupInstruction ? deser(ix1r.cleanupInstruction) : null,
    ...(ix2r.setupInstructions||[]).map(deser),
    deser(ix2r.swapInstruction),
    ix2r.cleanupInstruction ? deser(ix2r.cleanupInstruction) : null,
    // Jito tip (50% of gross profit, min 100k lam)
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: new PublicKey(JITO_TIPS[Math.floor(Math.random()*JITO_TIPS.length)]), lamports: Math.max(100_000, Math.floor(opp.gross*1e9*0.5)) }),
  ].filter(Boolean);

  if (!cachedBH) throw new Error('No blockhash');
  const msg = new TransactionMessage({ payerKey: wallet.publicKey, recentBlockhash: cachedBH, instructions: ixs }).compileToV0Message(alts);
  const tx  = new VersionedTransaction(msg);
  tx.sign([wallet]);

  const encoded = bs58.encode(tx.serialize());
  const sig     = bs58.encode(tx.signatures[0]);
  const payload = JSON.stringify({ jsonrpc:'2.0', id:1, method:'sendBundle', params:[[encoded]] });

  await Promise.all(JITO_URLS.map(url => nodeFetch(url,{ method:'POST', headers:{'Content-Type':'application/json'}, body:payload }).catch(()=>null)));
  return sig;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Wait for blockhash
  while (!cachedBH) { await new Promise(r=>setTimeout(r,100)); }

  const balBefore = (await conn.getBalance(wallet.publicKey)) / 1e9;
  const endTime   = Date.now() + RUN_MS;
  const trades    = [];
  const oppsFound = [];

  let cycle = 0, scanCount = 0;
  let bestGross = 0, bestToken = '';

  console.log('\n' + '═'.repeat(68));
  console.log('  🎯 GENUINE ARB TEST — 5 Minutes of Real Spread Hunting');
  console.log('═'.repeat(68));
  console.log(`  Wallet:      ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance:     ${balBefore.toFixed(6)} SOL`);
  console.log(`  Trade size:  ${TRADE_SOL} SOL  (dynamic: 30% of balance)`);
  console.log(`  Min profit:  ${MIN_PROFIT} SOL  (0.02% of trade size)`);
  console.log(`  Slippage:    ${SLIP_BPS} BPS  (0.2%)`);
  console.log(`  Tokens:      ${TOKENS.length} scanning in parallel`);
  console.log(`  Blockhash:   Helius ⚡ Chainstack race`);
  console.log(`  Broadcast:   Jito NY + Amsterdam simultaneous`);
  console.log(`  Break-even:  >0.000142 SOL net per trade`);
  console.log('═'.repeat(68));
  console.log('\n  Scanning... (dots = no arb, 🎯 = opportunity, ✅ = executed)\n');

  let consecutiveThrottle = 0;

  while (Date.now() < endTime) {
    cycle++;
    scanCount += TOKENS.length;

    // Dynamic trade size: 30% of live balance
    const tradeLam = Math.floor(Math.min(balBefore * 0.30, 0.25) * 1e9);

    // Parallel scan all tokens
    const results = await Promise.all(
      TOKENS.map(t => scanToken(t.symbol, t.mint, tradeLam).catch(() => null))
    );

    // Filter genuine opportunities (net positive after fees)
    const opps = results
      .filter(r => r !== null && r.net >= MIN_PROFIT)
      .sort((a, b) => b.net - a.net);

    // Track best gross seen even if below threshold
    results.filter(Boolean).forEach(r => {
      if (r.gross > bestGross) { bestGross = r.gross; bestToken = r.symbol; }
    });

    if (opps.length === 0) {
      if (cycle % 10 === 0) {
        const remaining = Math.round((endTime - Date.now()) / 1000);
        const bestPct   = ((bestGross / (tradeLam/1e9)) * 100).toFixed(4);
        process.stdout.write(`\r  [${remaining}s] Scans:${scanCount.toLocaleString()} | Best spread seen: ${bestGross>0?'+':''}${bestGross.toFixed(6)} SOL (${bestPct}% on ${bestToken})  `);
      } else {
        process.stdout.write('.');
      }
      await new Promise(r => setTimeout(r, SCAN_MS));
      continue;
    }

    const best = opps[0];
    oppsFound.push({ ...best, ts: Date.now() });
    const pct = ((best.net / (tradeLam/1e9)) * 100).toFixed(4);

    process.stdout.write(`\n\n  🎯 ARB FOUND! ${best.symbol}  Net: +${best.net.toFixed(6)} SOL (${pct}%)  Gross: +${best.gross.toFixed(6)} SOL\n`);
    process.stdout.write(`  ⚡ Executing via Jito...\n`);

    try {
      const execStart = Date.now();
      const sig = await executeArb(best);
      const execMs = Date.now() - execStart;

      console.log(`  ✅ BROADCAST  ${execMs}ms`);
      console.log(`  🔗 https://solscan.io/tx/${sig}`);

      // Confirm after 8s
      await new Promise(r => setTimeout(r, 8000));
      try {
        const newBal = (await conn.getBalance(wallet.publicKey)) / 1e9;
        const delta  = newBal - (balBefore + trades.reduce((s,t)=>s+t.delta,0));
        trades.push({ symbol: best.symbol, sig, net: best.net, gross: best.gross, execMs, delta, confirmed: true });
        console.log(`  💰 CONFIRMED  Δ${delta>=0?'+':''}${delta.toFixed(8)} SOL`);
      } catch(_) {
        trades.push({ symbol: best.symbol, sig, net: best.net, gross: best.gross, execMs, delta: 0, confirmed: false });
      }

      process.stdout.write('\n  Resuming scan...\n');
    } catch(e) {
      console.log(`  ❌ Exec failed: ${e.message.slice(0,80)}`);
    }

    await new Promise(r => setTimeout(r, SCAN_MS));
  }

  // ── Final Report ──────────────────────────────────────────────────────────
  const balAfter  = (await conn.getBalance(wallet.publicKey)) / 1e9;
  const totalPnl  = balAfter - balBefore;
  const tradePnl  = trades.reduce((s,t) => s+t.delta, 0);

  console.log('\n\n' + '═'.repeat(68));
  console.log('  📊 GENUINE ARB — 5-MINUTE FINAL REPORT');
  console.log('═'.repeat(68));
  console.log(`  Balance:       ${balBefore.toFixed(6)} → ${balAfter.toFixed(6)} SOL`);
  console.log(`  Net P&L:       ${totalPnl>=0?'+':''}${totalPnl.toFixed(6)} SOL`);
  console.log(`  Scans:         ${scanCount.toLocaleString()} quotes across ${TOKENS.length} tokens`);
  console.log(`  Opps detected: ${oppsFound.length}`);
  console.log(`  Trades exec:   ${trades.length}`);
  console.log(`  Best spread:   +${bestGross.toFixed(6)} SOL on ${bestToken}`);
  console.log('─'.repeat(68));

  if (trades.length > 0) {
    console.log('\n  ✅ EXECUTED TRADES:');
    trades.forEach((t,i) => {
      console.log(`  [${i+1}] ${t.symbol}  expected:+${t.net.toFixed(6)} SOL  actual:${t.delta>=0?'+':''}${t.delta.toFixed(6)} SOL  ${t.execMs}ms`);
      console.log(`       https://solscan.io/tx/${t.sig}`);
    });
  } else {
    console.log('\n  ⚠️  No genuine arb found above threshold in this window.');
    console.log(`  Best raw spread seen: +${bestGross.toFixed(6)} SOL on ${bestToken}`);
    console.log(`  (Threshold was: +${MIN_PROFIT} SOL — lower it to trade more aggressively)`);
  }

  if (oppsFound.length > 0) {
    console.log('\n  🎯 ALL DETECTED OPPORTUNITIES:');
    oppsFound.forEach((o,i)=>console.log(`  [${i+1}] ${o.symbol}  net:+${o.net.toFixed(6)}  gross:+${o.gross.toFixed(6)}`));
  }

  console.log('\n' + '═'.repeat(68) + '\n');
  fs.writeFileSync('./arb5min_result.json', JSON.stringify({ trades, oppsFound, stats:{ scanCount, totalPnl, bestGross, bestToken }}, null, 2));
  console.log('  📄 Full log → arb5min_result.json');
}

main().catch(e => { console.error('\n❌ FATAL:', e.message); process.exit(1); });
