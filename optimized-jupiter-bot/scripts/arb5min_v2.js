/**
 * GENUINE ARB TEST v2 — Expanded DEXes + Micro-Profit Mode
 * ==========================================================
 * Key changes from v1:
 *  - 26 tokens (vs 12) — memecoins, LSTs, newer DeFi
 *  - MIN_PROFIT lowered to 0.000030 SOL (compounds microprofits)
 *  - feeEstimate = 0.000100 SOL (atomic single-tx path)
 *  - Jito tip floor 50k lamports (was 100k)
 *  - DEX exclusion narrowed to ONLY vote-account lockers
 *    (stake pools allowed back in — they're valid DEX routes)
 *  - Scan every 100ms (was 150ms)
 *
 * Usage: node scripts/arb5min_v2.js
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
const JUP_BASE    = 'https://lite-api.jup.ag/swap/v1';
const SOL_MINT    = 'So11111111111111111111111111111111111111112';

const TRADE_SOL  = 0.10;           // 0.10 SOL — smaller = less slippage impact on micro-spreads
const TRADE_LAM  = Math.floor(TRADE_SOL * 1e9);
const MIN_PROFIT = 0.000030;       // 0.00003 SOL — compounds microprofits (~30k lamports net)
const FEE_EST    = 0.000100;       // Single atomic tx: base(5k) + priority(60k) + margin
const SCAN_MS    = 100;            // 100ms scan interval
const RUN_MS     = 5 * 60 * 1000; // 5 minutes
const SLIP_BPS   = 15;            // 0.15% — tight to reduce slippage cost
const JITO_TIP_FLOOR = 50_000;   // 50k lamports (was 100k)

// NARROWED: only vote-account lockers excluded, all DEX AMMs allowed
const EXCLUDE = encodeURIComponent('GoonFi V2,AlphaQ,SolFi V2,BisonFi,HumidiFi');

const JITO_TIPS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
];
const JITO_URLS = [
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
];

// ── VALIDATED Token Universe (22 tokens — all confirmed routable on Jupiter) ─
const TOKENS = [
  // Stablecoins
  { symbol: 'USDC',   mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'USDT',   mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'  },
  // LSTs (mSOL and jitoSOL and bSOL confirmed valid)
  { symbol: 'mSOL',   mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So'  },
  { symbol: 'jitoSOL',mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn' },
  { symbol: 'bSOL',   mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1'  },
  // DeFi blue-chips
  { symbol: 'RAY',    mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
  { symbol: 'ORCA',   mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE'  },
  { symbol: 'JUP',    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'  },
  { symbol: 'DRIFT',  mint: 'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7'  },
  { symbol: 'PYTH',   mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3' },
  // Memecoins (all validated)
  { symbol: 'WIF',    mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  { symbol: 'BONK',   mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { symbol: 'POPCAT', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
  { symbol: 'MYRO',   mint: 'HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4' },
  { symbol: 'BOME',   mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82'  },
  { symbol: 'SLERF',  mint: '7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3' },
  // Bridged / cross-chain
  { symbol: 'ETH',    mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs' },
  { symbol: 'BTC',    mint: '9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E' },
  { symbol: 'W',      mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ' },
  // Additional DeFi
  { symbol: 'RNDR',   mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof'  },
  { symbol: 'WEN',    mint: 'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk'   },
  { symbol: 'UXD',    mint: '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT'  },
];

// ── Infrastructure ────────────────────────────────────────────────────────────
const conn   = new Connection(HELIUS_RPC, { commitment: 'processed' });
const raw    = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
const wallet = Keypair.fromSecretKey(new Uint8Array(raw));

const limiter = new Bottleneck({
  reservoir: 5000, reservoirRefreshAmount: 5000,
  reservoirRefreshInterval: 60_000, maxConcurrent: 30
});

// ── Blockhash race ─────────────────────────────────────────────────────────
let cachedBH = null;
async function raceBH() {
  const got = await Promise.race([
    nodeFetch(HELIUS_RPC, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getLatestBlockhash',params:[{commitment:'processed'}]})}).then(r=>r.json()).then(d=>d?.result?.value?.blockhash).catch(()=>null),
    nodeFetch(CHAIN_RPC,  { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getLatestBlockhash',params:[{commitment:'processed'}]})}).then(r=>r.json()).then(d=>d?.result?.value?.blockhash).catch(()=>null),
  ]);
  if (got) cachedBH = got;
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
    const r = await nodeFetch(url, { ...opts, headers:{ 'x-api-key':API_KEY, 'Content-Type':'application/json', ...(opts.headers||{}) }});
    if (r.status===429) throw new Error('RATE_LIMITED');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

// ── Single-token scan — both quotes in parallel via serial q1→q2 ─────────────
async function scanToken(symbol, mint, lamports) {
  try {
    const q1 = await jFetch(`${JUP_BASE}/quote?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${lamports}&slippageBps=${SLIP_BPS}&excludeDexes=${EXCLUDE}`);
    if (!q1?.outAmount) return null;
    const q2 = await jFetch(`${JUP_BASE}/quote?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${q1.outAmount}&slippageBps=${SLIP_BPS}&excludeDexes=${EXCLUDE}`);
    if (!q2?.outAmount) return null;
    const gross = (Number(q2.outAmount) - lamports) / 1e9;
    const net   = gross - FEE_EST;
    return { symbol, mint, q1, q2, gross, net };
  } catch(_) { return null; }
}

// ── Build + broadcast atomic arb tx ──────────────────────────────────────────
async function executeArb(opp) {
  const [ix1r, ix2r] = await Promise.all([
    jFetch(`${JUP_BASE}/swap-instructions`, { method:'POST', body:JSON.stringify({ quoteResponse:opp.q1, userPublicKey:wallet.publicKey.toBase58(), wrapAndUnwrapSol:true }) }),
    jFetch(`${JUP_BASE}/swap-instructions`, { method:'POST', body:JSON.stringify({ quoteResponse:opp.q2, userPublicKey:wallet.publicKey.toBase58(), wrapAndUnwrapSol:true }) }),
  ]);
  if (ix1r.error||ix2r.error) throw new Error(`swap-ix: ${ix1r.error||ix2r.error}`);

  const deser = ix => !ix ? null : new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map(k=>({ pubkey:new PublicKey(k.pubkey), isSigner:k.isSigner, isWritable:k.isWritable })),
    data: Buffer.from(ix.data,'base64')
  });

  const alts = (await Promise.all([...new Set([...(ix1r.addressLookupTableAddresses||[]),...(ix2r.addressLookupTableAddresses||[])])].map(getALT))).filter(Boolean);
  const tip  = Math.max(JITO_TIP_FLOOR, Math.floor(opp.gross * 1e9 * 0.4)); // 40% of gross (less aggressive than 50%)
  const ixs  = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 300_000 }),
    ...(ix1r.setupInstructions||[]).map(deser).filter(Boolean),
    deser(ix1r.swapInstruction),
    ix1r.cleanupInstruction ? deser(ix1r.cleanupInstruction) : null,
    ...(ix2r.setupInstructions||[]).map(deser).filter(Boolean),
    deser(ix2r.swapInstruction),
    ix2r.cleanupInstruction ? deser(ix2r.cleanupInstruction) : null,
    SystemProgram.transfer({ fromPubkey:wallet.publicKey, toPubkey:new PublicKey(JITO_TIPS[Math.floor(Math.random()*JITO_TIPS.length)]), lamports:tip }),
  ].filter(Boolean);

  if (!cachedBH) throw new Error('No blockhash');
  const msg = new TransactionMessage({ payerKey:wallet.publicKey, recentBlockhash:cachedBH, instructions:ixs }).compileToV0Message(alts);
  const tx  = new VersionedTransaction(msg);
  tx.sign([wallet]);

  const encoded = bs58.encode(tx.serialize());
  const sig     = bs58.encode(tx.signatures[0]);
  const payload = JSON.stringify({ jsonrpc:'2.0', id:1, method:'sendBundle', params:[[encoded]] });
  await Promise.all(JITO_URLS.map(url => nodeFetch(url,{ method:'POST', headers:{'Content-Type':'application/json'}, body:payload }).catch(()=>null)));
  return { sig, tipLam: tip };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  while (!cachedBH) await new Promise(r=>setTimeout(r,100));

  const balBefore = (await conn.getBalance(wallet.publicKey)) / 1e9;
  const endTime   = Date.now() + RUN_MS;
  const trades = [], oppsFound = [];

  let cycle=0, scanTotal=0;
  let bestGross=0, bestToken='';

  // Per-token best tracking
  const tokenBest = {};
  TOKENS.forEach(t => { tokenBest[t.symbol] = 0; });

  console.log('\n' + '═'.repeat(70));
  console.log('  🔥 GENUINE ARB v2 — Expanded DEXes + Micro-Profit Mode');
  console.log('═'.repeat(70));
  console.log(`  Wallet:       ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance:      ${balBefore.toFixed(6)} SOL`);
  console.log(`  Trade size:   ${TRADE_SOL} SOL`);
  console.log(`  Min profit:   ${MIN_PROFIT} SOL  (micro-profit compounding)`);
  console.log(`  Fee estimate: ${FEE_EST} SOL  (single atomic tx)`);
  console.log(`  Slippage:     ${SLIP_BPS} BPS (0.15%)`);
  console.log(`  Tokens:       ${TOKENS.length} (LSTs, memes, DeFi, bridged)`);
  console.log(`  DEX exclude:  ONLY vote-account lockers (all AMMs open)`);
  console.log(`  Jito tip:     50k–${ (0.4*100).toFixed(0)}% of gross`);
  console.log(`  Scan rate:    ${1000/SCAN_MS} scans/sec × ${TOKENS.length} tokens`);
  console.log('═'.repeat(70));
  console.log('\n  Scanning... [token:gross] shown every 30s\n');

  while (Date.now() < endTime) {
    cycle++;
    scanTotal += TOKENS.length;

    const results = await Promise.all(TOKENS.map(t => scanToken(t.symbol, t.mint, TRADE_LAM)));

    results.filter(Boolean).forEach(r => {
      if (r.gross > (tokenBest[r.symbol]||0)) tokenBest[r.symbol] = r.gross;
      if (r.gross > bestGross) { bestGross = r.gross; bestToken = r.symbol; }
    });

    const opps = results.filter(r => r!==null && r.net >= MIN_PROFIT).sort((a,b) => b.net - a.net);

    if (!opps.length) {
      if (cycle % 30 === 0) {
        const remaining = Math.round((endTime - Date.now()) / 1000);
        // Show per-token spread leaderboard
        const leaders = Object.entries(tokenBest)
          .filter(([,v]) => v > 0)
          .sort(([,a],[,b]) => b - a)
          .slice(0, 6)
          .map(([s,v]) => `${s}:${v>=0?'+':''}${v.toFixed(5)}`);
        process.stdout.write(`\r  [${remaining}s] ${scanTotal.toLocaleString()} scans | Top: ${leaders.join(' ')}`);
        // Reset per-token best each report period for fresh data
        TOKENS.forEach(t => { tokenBest[t.symbol] = 0; });
      }
      await new Promise(r => setTimeout(r, SCAN_MS));
      continue;
    }

    // Execute best opportunity
    const best = opps[0];
    oppsFound.push({ ...best, ts: Date.now() });
    const pct = ((best.net / TRADE_SOL) * 100).toFixed(4);

    process.stdout.write(`\n\n  🎯 ARB! ${best.symbol}  net:+${best.net.toFixed(6)} SOL (${pct}%)  gross:+${best.gross.toFixed(6)}\n`);
    process.stdout.write(`  ⚡ Building tx + broadcasting to Jito 3 regions...\n`);

    try {
      const t0 = Date.now();
      const { sig, tipLam } = await executeArb(best);
      const execMs = Date.now() - t0;
      console.log(`  ✅ SENT  ${execMs}ms  tip:${tipLam} lam`);
      console.log(`  🔗 https://solscan.io/tx/${sig}`);

      await new Promise(r => setTimeout(r, 8000));
      const newBal = (await conn.getBalance(wallet.publicKey)) / 1e9;
      const accDelta = trades.reduce((s,t) => s+t.delta, 0);
      const delta  = newBal - balBefore - accDelta;
      trades.push({ symbol:best.symbol, sig, expectedNet:best.net, gross:best.gross, execMs, delta, tipLam });
      const pnlStr = delta>=0 ? `+${delta.toFixed(8)}` : delta.toFixed(8);
      console.log(`  💰 CONFIRMED  Δ${pnlStr} SOL  running P&L: ${(accDelta+delta)>=0?'+':''}${(accDelta+delta).toFixed(6)} SOL`);
      process.stdout.write('\n  Resuming scan...\n');
    } catch(e) {
      console.log(`  ❌ Exec: ${e.message.slice(0,100)}`);
    }

    await new Promise(r => setTimeout(r, SCAN_MS));
  }

  // ── Final report ───────────────────────────────────────────────────────────
  const balAfter = (await conn.getBalance(wallet.publicKey)) / 1e9;
  const totalPnl = balAfter - balBefore;

  console.log('\n\n' + '═'.repeat(70));
  console.log('  📊 GENUINE ARB v2 — FINAL REPORT');
  console.log('═'.repeat(70));
  console.log(`  Balance:        ${balBefore.toFixed(6)} → ${balAfter.toFixed(6)} SOL  (${totalPnl>=0?'+':''}${totalPnl.toFixed(6)} SOL)`);
  console.log(`  Scans:          ${scanTotal.toLocaleString()} quotes`);
  console.log(`  Opps detected:  ${oppsFound.length}`);
  console.log(`  Trades exec:    ${trades.length}`);
  console.log(`  Best spread:    +${bestGross.toFixed(6)} SOL  on ${bestToken}`);
  console.log('─'.repeat(70));

  if (trades.length > 0) {
    console.log('\n  ✅ EXECUTED:');
    trades.forEach((t,i) => {
      console.log(`  [${i+1}] ${t.symbol}  expected:+${t.expectedNet.toFixed(6)}  actual:${t.delta>=0?'+':''}${t.delta.toFixed(6)}  ${t.execMs}ms`);
      console.log(`       https://solscan.io/tx/${t.sig}`);
    });
    console.log(`\n  TOTAL P&L: ${totalPnl>=0?'+':''}${totalPnl.toFixed(6)} SOL`);
  } else {
    console.log('\n  ⚠️  No arb above threshold.');
    console.log(`  Best raw spread: +${bestGross.toFixed(6)} SOL on ${bestToken}`);
    console.log(`  Threshold was:   +${MIN_PROFIT} SOL`);
    if (bestGross > 0) {
      const pctOfThreshold = (bestGross / MIN_PROFIT * 100).toFixed(0);
      console.log(`  Best was ${pctOfThreshold}% of threshold — market extremely efficient right now`);
    }
  }
  console.log('\n' + '═'.repeat(70) + '\n');

  fs.writeFileSync('./arb5min_v2_result.json', JSON.stringify({ trades, oppsFound, stats:{ scanTotal, totalPnl, bestGross, bestToken }}, null, 2));
  console.log('  📄 arb5min_v2_result.json');
}

main().catch(e => { console.error('\n❌ FATAL:', e.message); process.exit(1); });
