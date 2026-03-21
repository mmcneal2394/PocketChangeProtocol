/**
 * JUPITER ULTRA ARB ENGINE
 * ═══════════════════════════════════════════════════════════════════
 *  Both legs through api.jup.ag (paid tier, ~600 req/min)
 *  Fee: ~0.1–0.3% per leg vs Bags 1% → breakeven at 0.3% spread
 *  Profit gate: gross > 0.0003 SOL (net ~+0.0001 after fees+gas)
 *  wSOL throughout, 90s multi-RPC confirm
 *  Concurrent LEG1/LEG2 scan (both quoted simultaneously per token)
 * ═══════════════════════════════════════════════════════════════════
 */
'use strict';
require('dotenv').config();
const nodeFetch = require('node-fetch');
const WebSocket = require('ws');
const bs58      = require('bs58');
const { Connection, Keypair, VersionedTransaction, Transaction } = require('@solana/web3.js');
const fs = require('fs');

// ── Config ────────────────────────────────────────────────────────────────────
const HELIUS_RPC  = process.env.RPC_ENDPOINT  || 'https://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY';
const HELIUS_WS   = (process.env.RPC_WEBSOCKET || 'wss://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY').replace(/\/$/, '');
const CHAIN_RPC   = 'https://rpc.YOUR_CHAINSTACK_ENDPOINT';
const JUP_KEY     = process.env.JUPITER_API_KEY || 'YOUR_JUPITER_API_KEY';
const JUP_BASE    = 'https://api.jup.ag/swap/v1';
const wSOL        = 'So11111111111111111111111111111111111111112';
const USDC        = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const LOG_FILE    = './arb_jup_trades.json';

// ── Platform fee (referral revenue) ──────────────────────────────────────────
const PLATFORM_FEE_BPS  = parseInt(process.env.PLATFORM_FEE_BPS || '20');   // 0.2%
const FEE_ACCT_WSOL     = process.env.PLATFORM_FEE_ACCOUNT_WSOL || '';       // wSOL ATA
const FEE_ACCT_USDC     = process.env.PLATFORM_FEE_ACCOUNT_USDC || '';       // USDC ATA
// Map outputMint → fee account
const feeAccountFor = (mint) => mint === USDC ? FEE_ACCT_USDC : FEE_ACCT_WSOL;

// ── Tuning ────────────────────────────────────────────────────────────────────
// Jupiter paid tier ~600 req/min. Each scan: 20 tokens × 2 = 40 calls.
// 40/600 = 6.7% per scan. Scan every 12s = 5/min = 200 calls/min → fine.
const MIN_GROSS    = 300_000;       // 0.0003 SOL — must cover slippage + fees
const SLIP_BPS     = 200;           // 2% fallback if dynamicSlippage can't compute
const CU_PRICE     = 300_000;       // priority fee
const SCAN_MS      = 12_000;
const WS_DEB_MS    = 5_000;
const CEX_POLL_MS  = 10_000;
const CEX_THRESH   = 0.002;
const CONFIRM_MS   = 90_000;
const TOKEN_REF_MS = 5 * 60_000;
const MAX_TOKENS   = 20;
// Compounding: use 10% of wallet balance per trade, clamped 0.02–0.15 SOL
const COMPOUND_PCT = 0.10;
const TRADE_MIN    = 20_000_000;    // 0.02 SOL floor
const TRADE_MAX    = 150_000_000;   // 0.15 SOL ceiling
let   tradeLam     = 50_000_000;    // initial 0.05 SOL, updates each scan

// ── Init ──────────────────────────────────────────────────────────────────────
const wallet    = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.WALLET_KEYPAIR_PATH||'./real_wallet.json','utf-8'))));
const conn      = new Connection(HELIUS_RPC, { commitment: 'confirmed' });
const connChain = new Connection(CHAIN_RPC,   { commitment: 'confirmed' });
const JUP_H     = { 'Content-Type': 'application/json', 'x-api-key': JUP_KEY };

let scanCount = 0, execCount = 0, profitCount = 0, totalNet = 0;
let scanning  = false, lastScan = 0, lastRefresh = 0;
let walletBal = 0; // updated before each scan for compounding trade size

async function updateTradeLam() {
  try {
    walletBal = await conn.getBalance(wallet.publicKey);
    // Reserve 0.05 SOL for gas, compound the rest
    const avail = Math.max(0, walletBal - 50_000_000);
    tradeLam = Math.min(TRADE_MAX, Math.max(TRADE_MIN, Math.floor(avail * COMPOUND_PCT)));
  } catch(_) {}
}

// ── Jupiter quote (platformFeeBps goes here per API docs) ───────────────────
async function jupQuote(inMint, outMint, amount) {
  const feeAcct = feeAccountFor(outMint);
  let url = `${JUP_BASE}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${SLIP_BPS}&restrictIntermediateTokens=true`;
  if (feeAcct && PLATFORM_FEE_BPS > 0) url += `&platformFeeBps=${PLATFORM_FEE_BPS}`;
  const r = await nodeFetch(url, { headers: JUP_H });
  if (r.status === 429) throw new Error('jup 429');
  if (!r.ok) throw new Error(`jup ${r.status}`);
  const j = await r.json();
  if (!j.outAmount) throw new Error(`jup no out: ${JSON.stringify(j).slice(0,60)}`);
  return j; // full quoteResponse object
}

// ── Jupiter swap tx (feeAccount in body, platformFeeBps in quote) ─────────────
async function jupSwapTx(quoteResponse) {
  const feeAccount = feeAccountFor(quoteResponse.outputMint);
  const body = {
    quoteResponse,
    userPublicKey:                wallet.publicKey.toBase58(),
    wrapAndUnwrapSol:              true,
    computeUnitPriceMicroLamports: CU_PRICE,
    dynamicComputeUnitLimit:       true,
    dynamicSlippage:         { maxBps: 300 }, // 3% max — eliminates 6014 on fast-moving pairs
  };
  // Attach platform fee if account configured
  if (feeAccount) body.feeAccount = feeAccount; // platformFeeBps is in the quoteResponse
  const r = await nodeFetch(`${JUP_BASE}/swap`, { method:'POST', headers:JUP_H, body:JSON.stringify(body) });
  if (!r.ok) throw new Error(`jup swap ${r.status}: ${(await r.text()).slice(0,80)}`);
  const j = await r.json();
  if (!j.swapTransaction) throw new Error(`jup no swapTx: ${JSON.stringify(j).slice(0,80)}`);
  return j.swapTransaction;
}

// ── Send & confirm (90s multi-RPC) ───────────────────────────────────────────
async function sendAndConfirm(txStr, label) {
  const buf = Buffer.from(txStr, 'base64');
  let tx; try { tx = VersionedTransaction.deserialize(buf); } catch(_) { tx = Transaction.from(buf); }
  tx.sign([wallet]);
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
  console.log(`     🔗 ${label}: https://solscan.io/tx/${sig}`);
  const deadline = Date.now() + CONFIRM_MS;
  let lastResend  = Date.now();
  while (Date.now() < deadline) {
    const [h, c] = await Promise.allSettled([
      conn.getSignatureStatus(sig,      { searchTransactionHistory: true }),
      connChain.getSignatureStatus(sig, { searchTransactionHistory: true }),
    ]);
    for (const res of [h,c]) {
      if (res.status !== 'fulfilled') continue;
      const st = res.value?.value;
      if (st?.err) throw new Error(`${label} err: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') {
        console.log(`     ✅ ${label} confirmed`); return sig;
      }
    }
    if (Date.now() - lastResend > 20_000) {
      conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(()=>{});
      lastResend = Date.now();
    }
    await new Promise(r => setTimeout(r, 2_000));
  }
  throw new Error(`${label} not confirmed 90s — ${sig}`);
}

// ── Token discovery ───────────────────────────────────────────────────────────
async function discoverTokens() {
  const H = { 'User-Agent': 'Mozilla/5.0' };
  const [pump, boost, trending] = await Promise.allSettled([
    // 1. High-volume pump.fun / Raydium SOL pairs (lowered thresholds)
    nodeFetch('https://api.dexscreener.com/latest/dex/search?q=pump', { headers: H })
      .then(r=>r.json()).then(j=>(j.pairs||[])
        .filter(p=>p.chainId==='solana'&&(p.dexId==='pumpswap'||p.dexId==='raydium')
          &&p.quoteToken?.address===wSOL&&(p.volume?.h1||0)>3_000
          &&(p.liquidity?.usd||0)>800&&(p.liquidity?.usd||0)<800_000)
        .sort((a,b)=>(b.volume?.h1||0)-(a.volume?.h1||0)).slice(0,12)
        .map(p=>({symbol:p.baseToken.symbol.slice(0,8),mint:p.baseToken.address,src:'pump'}))).catch(()=>[]),
    // 2. Boosted tokens (high ad spend = high volume)
    nodeFetch('https://api.dexscreener.com/token-boosts/top/v1', { headers: H })
      .then(r=>r.json()).then(j=>(Array.isArray(j)?j:[]).filter(t=>t.chainId==='solana').slice(0,6)
        .map(t=>({symbol:t.tokenAddress.slice(0,6)+'…',mint:t.tokenAddress,src:'boost'}))).catch(()=>[]),
    // 3. Trending — big price moves in last hour
    nodeFetch('https://api.dexscreener.com/latest/dex/search?q=sol', { headers: H })
      .then(r=>r.json()).then(j=>(j.pairs||[])
        .filter(p=>p.chainId==='solana'&&p.quoteToken?.address===wSOL
          &&Math.abs(p.priceChange?.h1||0)>5&&(p.volume?.h1||0)>5_000&&(p.liquidity?.usd||0)>1_000)
        .sort((a,b)=>Math.abs(b.priceChange?.h1||0)-Math.abs(a.priceChange?.h1||0)).slice(0,8)
        .map(p=>({symbol:p.baseToken.symbol.slice(0,8),mint:p.baseToken.address,src:'trend'}))).catch(()=>[]),
  ]);
  const seen = new Set([wSOL]);
  const merged = [
    ...(pump.status==='fulfilled'     ? pump.value     : []),
    ...(trending.status==='fulfilled' ? trending.value : []),
    ...(boost.status==='fulfilled'    ? boost.value    : []),
    {symbol:'BONK',  mint:'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',src:'stable'},
    {symbol:'WIF',   mint:'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',src:'stable'},
    {symbol:'USDC',  mint:USDC,src:'stable'},
    {symbol:'JUP',   mint:'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',src:'stable'},
    {symbol:'BOME',  mint:'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',src:'stable'},
    {symbol:'POPCAT',mint:'7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',src:'stable'},
    {symbol:'RNDR',  mint:'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof',src:'stable'},
  ];
  const out = [];
  for (const t of merged) if(t.mint&&!seen.has(t.mint)){seen.add(t.mint);out.push(t);}
  console.log(`  🔄 Tokens: ${out.length} [pump:${(pump.value||[]).length} trend:${(trending.value||[]).length} boost:${(boost.value||[]).length} stable]`);
  return out.slice(0,30);
}

// ── Scan — quote both legs concurrently per token ─────────────────────────────
async function scan(tokens) {
  await updateTradeLam(); // refresh wallet balance + compound trade size
  const ts = new Date().toISOString().slice(11,19);
  const list = tokens.slice(0, MAX_TOKENS);
  console.log(`\n  [${ts}] 🔍 Scan #${++scanCount} | trades:${execCount}(${profitCount}✅) net:${totalNet>=0?'+':''}${totalNet.toFixed(5)} | size:${(tradeLam/1e9).toFixed(3)}SOL | ${list.map(t=>t.symbol).join(' ')}`);

  const opps = [];
  // Quote all tokens in parallel batches of 4 to avoid rate limit spikes
  for (let i = 0; i < list.length; i += 4) {
    const batch = list.slice(i, i+4);
    const results = await Promise.allSettled(batch.map(async t => {
      const q1 = await jupQuote(wSOL, t.mint, tradeLam);
      const out1 = Number(q1.outAmount);
      if (!out1) throw new Error('no out1');
      const q2 = await jupQuote(t.mint, wSOL, out1);
      const gross = Number(q2.outAmount) - tradeLam;
      return { token: t, gross, q1, q2 };
    }));
    for (let j = 0; j < results.length; j++) {
      const r = results[j]; const t = batch[j];
      if (r.status === 'rejected') {
        if (!r.reason.message.includes('429')) console.log(`       ⚠️  ${t.symbol}: ${r.reason.message.slice(0,40)}`);
        continue;
      }
      const { gross, q1, q2 } = r.value;
      const flag = gross > MIN_GROSS ? '🟢' : gross > 0 ? '🟡' : '🔴';
      console.log(`       ${flag} ${t.symbol.padEnd(8)} gross:${(gross/1e9).toFixed(5)} SOL  out1:${Number(q1.outAmount).toLocaleString()}`);
      if (gross > MIN_GROSS) opps.push(r.value);
    }
    if (i + 4 < list.length) await new Promise(r => setTimeout(r, 200)); // tiny gap between batches
  }
  return opps.sort((a,b) => b.gross - a.gross);
}

// ── Execute ───────────────────────────────────────────────────────────────────
async function execute(opp) {
  const ts = new Date().toISOString().slice(11,19);
  console.log(`\n  [${ts}] ⚡ ${opp.token.symbol} | gross:+${(opp.gross/1e9).toFixed(5)} | both legs Jupiter`);
  let balBefore; try { balBefore = await conn.getBalance(wallet.publicKey); } catch(_){}

  const tx1 = await jupSwapTx(opp.q1);
  const sig1 = await sendAndConfirm(tx1, 'LEG1');

  // Re-quote fresh — prices move fast
  const q2fresh = await jupQuote(opp.token.mint, wSOL, Number(opp.q1.outAmount));
  const tx2 = await jupSwapTx(q2fresh);
  const sig2 = await sendAndConfirm(tx2, 'LEG2');

  await new Promise(r => setTimeout(r, 2000));
  let trueNet = null;
  try {
    const balAfter = await conn.getBalance(wallet.publicKey);
    trueNet = (balAfter - (balBefore||balAfter)) / 1e9;
  } catch(_){}

  execCount++;
  if ((trueNet||0) > 0) profitCount++;
  totalNet += (trueNet||0);

  const icon = (trueNet||0) > 0 ? '✅ PROFIT' : '📉 LOSS';
  console.log(`  ${icon}: ${trueNet!==null?(trueNet>=0?'+':'')+trueNet.toFixed(6)+' SOL':'?'} | wins:${profitCount}/${execCount} net:${totalNet>=0?'+':''}${totalNet.toFixed(5)}`);

  try {
    const log = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE,'utf-8')) : [];
    log.push({ ts, symbol:opp.token.symbol, src:opp.token.src, grossQuoted:(opp.gross/1e9).toFixed(6), trueNet:trueNet?.toFixed(6), sig1, sig2 });
    fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
  } catch(_){}
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  let tokens = [];
  const balStart = await conn.getBalance(wallet.publicKey);
  console.log('\n' + '═'.repeat(68));
  console.log('  💹 JUPITER ULTRA ARB — Both Legs Paid Tier');
  console.log('═'.repeat(68));
  console.log(`  Wallet:  ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance: ${(balStart/1e9).toFixed(6)} SOL`);
  console.log(`  Trade:   ${tradeLam/1e9} SOL (compounding 10% of balance) | ${SLIP_BPS}bps slip | gate:+${MIN_GROSS} lam gross`);
  console.log(`  Fee est: ~0.3% round-trip (vs 2% Bags) — breakeven at 0.3% spread`);
  console.log(`  Scan:    ${SCAN_MS/1000}s baseline, instant on WS/CEX trigger`);
  console.log(`  Key:     api.jup.ag paid (${JUP_KEY.slice(0,8)}...) ~600 req/min`);
  console.log('═'.repeat(68) + '\n');

  tokens = await discoverTokens();
  lastRefresh = Date.now();
  const src = {}; tokens.forEach(t=>{src[t.src]=(src[t.src]||0)+1;});
  console.log(`  📡 ${tokens.length} tokens: ${Object.entries(src).map(([k,v])=>`${k}:${v}`).join(' ')}`);

  // WS debounce
  let wsT = false, wsTimer = null;
  const trigWS = () => { wsT = true; clearTimeout(wsTimer); wsTimer = setTimeout(()=>{wsT=false;}, WS_DEB_MS); };
  const ws = new WebSocket(HELIUS_WS);
  ws.on('open', ()=>{
    console.log('  🔌 Helius WS connected');
    ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8','whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc','LBUZKhRxPF3XUpBCjp4YzTKgLe4qqiGMdtYBe5Cteam']
      .forEach((p,i)=>ws.send(JSON.stringify({jsonrpc:'2.0',id:i+1,method:'logsSubscribe',params:[{mentions:[p]},{commitment:'processed'}]})));
  });
  ws.on('message',d=>{try{if(JSON.parse(d.toString()).method==='logsNotification')trigWS();}catch(_){}});
  ws.on('error',()=>{}); ws.on('close',()=>{});

  // CEX monitor
  const cexLast = {};
  setInterval(async()=>{
    try {
      const r = await nodeFetch('https://api.binance.com/api/v3/ticker/price?symbols=["SOLUSDT","BONKUSDT","WIFUSDT","POPCATUSDT"]');
      for(const t of await r.json()){
        const price=parseFloat(t.price), prev=cexLast[t.symbol]; cexLast[t.symbol]=price;
        if(!prev)continue;
        const d=Math.abs(price-prev)/prev;
        if(d>=CEX_THRESH){console.log(`\n  ${price>prev?'📈':'📉'} CEX ${t.symbol} +${(d*100).toFixed(2)}%`); lastScan=0;}
      }
    }catch(_){}
  }, CEX_POLL_MS);
  console.log('  📈 Binance CEX monitor running\n  ⏳ Profit gate: only 🟢 fires. Scanning...\n');

  while (true) {
    if (Date.now()-lastRefresh > TOKEN_REF_MS) { try{tokens=await discoverTokens();lastRefresh=Date.now();}catch(_){} }
    const elapsed = Date.now() - lastScan;
    const due = !scanning && (elapsed > SCAN_MS || (wsT && elapsed > WS_DEB_MS));
    if (due) {
      scanning=true; wsT=false; lastScan=Date.now();
      try {
        const opps = await scan(tokens);
        if (opps.length) { console.log(`\n  🟢 ${opps.length} opp(s) — executing ${opps[0].token.symbol}`); await execute(opps[0]); }
        else console.log('  ⏸  Holding — no profitable spread');
      } catch(e) { console.log(`  ❌ ${e.message.slice(0,100)}`); }
      scanning=false;
    }
    await new Promise(r=>setTimeout(r,500));
  }
}
main().catch(e=>{console.error('\n❌ FATAL:',e.message);process.exit(1);});
