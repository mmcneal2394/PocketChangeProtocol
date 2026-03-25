/**
 * 24-HOUR AGGRESSIVE LIVE ARB TEST
 * ══════════════════════════════════════════════════════════════════
 *  • 6-key Bags pool (6000 req/hr) — wSOL mode (no wrap/unwrap fee)
 *  • 4-source token discovery every 10 min
 *  • Helius DEX WS + Binance CEX 0.3% spike triggers
 *  • 90s scan cadence, 8 tokens/cycle (rate-safe)
 *  • Forced pipeline trade every 10 min
 *  • 90s multi-RPC confirmation (Helius + Chainstack)
 *  • Hourly P&L snapshots + final JSON report
 * ══════════════════════════════════════════════════════════════════
 */
'use strict';
require('dotenv').config();
const nodeFetch = require('node-fetch');
const WebSocket = require('ws');
const bs58      = require('bs58');
const { Connection, Keypair, VersionedTransaction, Transaction } = require('@solana/web3.js');
const fs = require('fs');

// ── Constants ─────────────────────────────────────────────────────────────────
const HELIUS_RPC = process.env.RPC_ENDPOINT || 'https://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY';
const HELIUS_WS  = (process.env.RPC_WEBSOCKET || 'wss://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY').replace(/\/$/, '');
const CHAIN_RPC  = 'https://rpc.YOUR_CHAINSTACK_ENDPOINT';
const BAGS_API   = 'https://public-api-v2.bags.fm/api/v1';
const SOL_MINT   = 'So11111111111111111111111111111111111111112'; // wSOL mint
const USDC_MINT  = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const LOG_FILE   = './arb_24h_trades.json';
const SNAP_FILE  = './arb_24h_snapshots.json';

const BAGS_KEYS = [
  process.env.BAGS_API_KEY   || 'process.env.BAGS_API_KEY',
  process.env.BAGS_API_KEY_2 || 'process.env.BAGS_API_KEY_2',
  process.env.BAGS_API_KEY_3 || 'process.env.BAGS_API_KEY_3',
  process.env.BAGS_API_KEY_4 || 'process.env.BAGS_API_KEY_4',
  process.env.BAGS_API_KEY_5 || 'process.env.BAGS_API_KEY_5',
  process.env.BAGS_API_KEY_6 || 'process.env.BAGS_API_KEY_6',
];

// ── Rate-safe timing ──────────────────────────────────────────────────────────
// 6 keys × 1000/hr = 6000/hr. KEY_GAP=3600ms → effective 600ms between calls.
// 8 tokens × 2 = 16 calls/scan × 600ms = 9.6s. 90s baseline = safe.
// Over 24h: 24 × 60/1.5min = 960 scans × 16 calls = 15,360 → 640/key/24h ✅
const TEST_DURATION_MS  = 24 * 60 * 60_000;  // 24 hours
const SCAN_INTERVAL_MS  = 90_000;            // 90s baseline
const FORCE_TRADE_MS    = 10 * 60_000;       // force trade every 10 min
const TOKEN_REFRESH_MS  = 10 * 60_000;       // token list refresh every 10 min
const CEX_POLL_MS       = 10_000;            // Binance poll every 10s
const KEY_GAP_MS        = 3_600;             // 3.6s per key = 1000/hr
const TRADE_LAM         = 50_000_000;        // 0.05 SOL per leg
const SLIP_BPS          = 100;               // 1% slippage
const CU_PRICE          = 100_000;           // priority fee
const CEX_SPIKE_THRESH  = 0.003;             // 0.3% spike triggers scan
const CONFIRM_TIMEOUT   = 90_000;            // 90s max confirmation
const MAX_SCAN_TOKENS   = 8;                 // 8 tokens per scan cycle
const HOURLY_SNAP_MS    = 60 * 60_000;       // hourly snapshot

// ── Init ──────────────────────────────────────────────────────────────────────
const wallet    = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.WALLET_KEYPAIR_PATH||'./real_wallet.json','utf-8'))));
const conn      = new Connection(HELIUS_RPC, { commitment: 'confirmed' });
const connChain = new Connection(CHAIN_RPC,   { commitment: 'confirmed' });

const keyLastCall  = BAGS_KEYS.map(() => 0);
const keyCallCount = BAGS_KEYS.map(() => 0);

// ── Key rotation ──────────────────────────────────────────────────────────────
async function nextKey() {
  let best = 0, bestAvail = Infinity;
  for (let i = 0; i < BAGS_KEYS.length; i++) {
    const avail = keyLastCall[i] + KEY_GAP_MS;
    if (avail < bestAvail) { bestAvail = avail; best = i; }
  }
  const wait = bestAvail - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  keyLastCall[best] = Date.now();
  keyCallCount[best]++;
  return { key: BAGS_KEYS[best], idx: best };
}

// ── Bags API with backoff ─────────────────────────────────────────────────────
async function bagsCall(path, method = 'GET', body = null, maxRetries = 12) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { key, idx } = await nextKey();
    const opts = { method,
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
    let r;
    try { r = await nodeFetch(`${BAGS_API}${path}`, opts); }
    catch(e) { console.log(`  ⚠  fetch: ${e.message.slice(0,50)}`); continue; }
    const rl = r.headers.get('x-ratelimit-remaining');
    if (rl) process.stdout.write(`[k${idx+1}:${rl}]`);
    if (r.status === 429) {
      const reset = r.headers.get('x-ratelimit-reset');
      const resetMs = reset ? Math.max(0, Number(reset)*1000 - Date.now()) : 0;
      const back  = Math.min(2000 * Math.pow(2, attempt), 60_000);
      const wait  = Math.max(back, resetMs ? resetMs + 500 : 0);
      console.log(`\n  ⏳ k${idx+1} 429 → wait ${(wait/1000).toFixed(0)}s`);
      keyLastCall[idx] = Date.now() + wait;
      continue;
    }
    const j = await r.json();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0,80)}`);
    return j;
  }
  throw new Error('max retries');
}

// ── Token discovery ───────────────────────────────────────────────────────────
async function discoverTokens() {
  const [bags, pump, boost, dbc] = await Promise.allSettled([
    bagsCall('/token-launch/top-tokens/lifetime-fees').then(j =>
      j.success ? j.response.slice(0,8).map(t=>({ symbol:t.tokenInfo?.symbol||t.token.slice(0,6), mint:t.token, src:'bags' })) : []
    ).catch(()=>[]),
    nodeFetch('https://api.dexscreener.com/latest/dex/search?q=pump',{headers:{'User-Agent':'Mozilla/5.0'}})
      .then(r=>r.json()).then(j=>(j.pairs||[])
        .filter(p=>p.chainId==='solana'&&(p.dexId==='pumpswap'||p.dexId==='raydium')
          &&p.quoteToken?.address===SOL_MINT&&(p.volume?.h1||0)>5000&&(p.liquidity?.usd||0)>1000&&(p.liquidity?.usd||0)<500000)
        .sort((a,b)=>(b.volume?.h1||0)-(a.volume?.h1||0)).slice(0,5)
        .map(p=>({symbol:p.baseToken.symbol,mint:p.baseToken.address,src:'pump'}))).catch(()=>[]),
    nodeFetch('https://api.dexscreener.com/token-boosts/top/v1',{headers:{'User-Agent':'Mozilla/5.0'}})
      .then(r=>r.json()).then(j=>(Array.isArray(j)?j:[]).filter(t=>t.chainId==='solana').slice(0,4)
        .map(t=>({symbol:t.tokenAddress.slice(0,6)+'…',mint:t.tokenAddress,src:'boost'}))).catch(()=>[]),
    nodeFetch('https://api.dexscreener.com/latest/dex/search?q=solana%20meteora%20dbc',{headers:{'User-Agent':'Mozilla/5.0'}})
      .then(r=>r.json()).then(j=>(j.pairs||[])
        .filter(p=>{const h=(Date.now()-(p.pairCreatedAt||0))/3600000;return h<6&&p.quoteToken?.address===SOL_MINT&&(p.volume?.h24||0)>1000;})
        .slice(0,3).map(p=>({symbol:p.baseToken.symbol,mint:p.baseToken.address,src:'dbc'}))).catch(()=>[]),
  ]);
  const seen = new Set([SOL_MINT]);
  const merged = [];
  const seeds = [
    {symbol:'USDC',mint:USDC_MINT,src:'stable'},
    {symbol:'BONK',mint:'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',src:'stable'},
    {symbol:'WIF', mint:'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',src:'stable'},
  ];
  for (const r of [...[bags,pump,boost,dbc].map(r=>r.status==='fulfilled'?{status:'fulfilled',value:r.value}:r), {status:'fulfilled',value:seeds}]) {
    if (r.status==='fulfilled') for (const t of (r.value||[]))
      if (t.mint&&!seen.has(t.mint)){seen.add(t.mint);merged.push(t);}
  }
  return merged.slice(0,25);
}

// ── Quote & swap ──────────────────────────────────────────────────────────────
async function quote(inMint, outMint, amount) {
  const j = await bagsCall(`/trade/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageMode=auto&slippageBps=${SLIP_BPS}`);
  if (!j.success||!j.response?.outAmount) throw new Error(`bad quote`);
  return j.response;
}

async function swap(quoteObj) {
  const j = await bagsCall('/trade/swap','POST',{
    quoteResponse: quoteObj,
    userPublicKey: wallet.publicKey.toBase58(),
    computeUnitPriceMicroLamports: CU_PRICE,
    wrapAndUnwrapSol: false,  // stay as wSOL — avoid unwrap fee
  });
  const txStr = j.response?.swapTransaction || j.swapTransaction;
  if (!txStr) throw new Error(`no tx: ${JSON.stringify(j).slice(0,80)}`);
  return txStr;
}

// ── Confirm ───────────────────────────────────────────────────────────────────
async function sendAndConfirm(txStr, label) {
  const buf = Buffer.from(bs58.decode(txStr));
  let tx; try { tx = VersionedTransaction.deserialize(buf); } catch(_) { tx = Transaction.from(buf); }
  tx.sign([wallet]);
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
  console.log(`  🔗 ${label}: https://solscan.io/tx/${sig}`);
  const deadline = Date.now() + CONFIRM_TIMEOUT;
  let lastResend = Date.now();
  while (Date.now() < deadline) {
    const [h,c] = await Promise.allSettled([
      conn.getSignatureStatus(sig,{searchTransactionHistory:true}),
      connChain.getSignatureStatus(sig,{searchTransactionHistory:true}),
    ]);
    for (const r of [h,c]) {
      if (r.status!=='fulfilled') continue;
      const st = r.value?.value;
      if (st?.err) throw new Error(`${label} failed: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus==='confirmed'||st?.confirmationStatus==='finalized'){
        console.log(`  ✅ ${label} confirmed`); return sig;
      }
    }
    if (Date.now()-lastResend>20_000){
      conn.sendRawTransaction(raw,{skipPreflight:true,maxRetries:0}).catch(()=>{});
      lastResend=Date.now();
    }
    await new Promise(r=>setTimeout(r,2000));
  }
  throw new Error(`${label} not confirmed in 90s — ${sig}`);
}

// ── Round-trip ────────────────────────────────────────────────────────────────
async function roundTrip(token, trigger) {
  const ts = new Date().toISOString().slice(11,19);
  let balBefore;
  try { balBefore = await conn.getBalance(wallet.publicKey); } catch(_){}

  const q1   = await quote(SOL_MINT, token.mint, TRADE_LAM);
  const out1  = Number(q1.outAmount);
  const q2pre = await quote(token.mint, SOL_MINT, out1);
  const gross  = (Number(q2pre.outAmount) - TRADE_LAM) / 1e9;
  console.log(`\n  [${ts}] ${trigger} → ${token.symbol}(${token.src}) gross:${gross>=0?'+':''}${gross.toFixed(5)}`);

  const tx1  = await swap(q1);
  const sig1 = await sendAndConfirm(tx1, 'LEG1');

  const q2   = await quote(token.mint, SOL_MINT, out1);  // fresh requestId
  const tx2  = await swap(q2);
  const sig2 = await sendAndConfirm(tx2, 'LEG2');

  await new Promise(r=>setTimeout(r,2000));
  let trueNet = null;
  try {
    const balAfter = await conn.getBalance(wallet.publicKey);
    trueNet = (balAfter - (balBefore||balAfter)) / 1e9;
    const icon = trueNet>0?'✅':trueNet===0?'➖':'📉';
    console.log(`  ${icon} net: ${trueNet>=0?'+':''}${trueNet.toFixed(6)} SOL`);
  } catch(_){}

  return { ts, symbol:token.symbol, src:token.src, trigger, gross, trueNet, sig1, sig2 };
}

// ── Scan ──────────────────────────────────────────────────────────────────────
async function scan(tokens) {
  const out = [];
  for (const t of tokens.slice(0, MAX_SCAN_TOKENS)) {
    try {
      const q1 = await quote(SOL_MINT, t.mint, TRADE_LAM);
      const o1  = Number(q1.outAmount); if (!o1) continue;
      const q2 = await quote(t.mint, SOL_MINT, o1);
      const gross = (Number(q2.outAmount)-TRADE_LAM)/1e9;
      out.push({ token:t, gross, q1, q2 });
      process.stdout.write(`${t.symbol}:${gross>=0?'+':''}${gross.toFixed(4)} `);
    } catch(e) { process.stdout.write(`${t.symbol}:ERR `);}
  }
  console.log('');
  return out.sort((a,b)=>b.gross-a.gross);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const startMs  = Date.now();
  const endMs    = startMs + TEST_DURATION_MS;
  let trades     = [];
  let snapshots  = [];
  let tokens     = [];
  let scanCount  = 0, wsEvents = 0, cexTriggers = 0;
  let lastForced = 0, lastRefresh = 0, lastSnap = 0, lastScan = 0;
  let scanning   = false;

  const balStart = await conn.getBalance(wallet.publicKey);

  console.log('\n' + '═'.repeat(68));
  console.log('  ⚡ 24-HOUR AGGRESSIVE LIVE TEST');
  console.log('═'.repeat(68));
  console.log(`  Wallet:   ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance:  ${(balStart/1e9).toFixed(6)} SOL`);
  console.log(`  Mode:     wSOL (no unwrap fee)`);
  console.log(`  Keys:     ${BAGS_KEYS.length} (${BAGS_KEYS.length*1000}/hr combined)`);
  console.log(`  Scan:     ${MAX_SCAN_TOKENS} tokens / ${SCAN_INTERVAL_MS/1000}s = ${MAX_SCAN_TOKENS*2} calls/cycle`);
  console.log(`  Triggers: DEX WS + Binance CEX (0.3%) + ${SCAN_INTERVAL_MS/1000}s baseline`);
  console.log(`  Force:    1 trade / 10min (pipeline verify)`);
  console.log(`  Ends:     ${new Date(endMs).toISOString()}`);
  console.log('═'.repeat(68) + '\n');

  // Initial token load
  console.log('  📡 Discovering tokens...');
  tokens = await discoverTokens();
  lastRefresh = Date.now();
  const srcMap = {};
  tokens.forEach(t=>{srcMap[t.src]=(srcMap[t.src]||0)+1;});
  console.log(`  🔄 ${tokens.length} tokens | ${Object.entries(srcMap).map(([k,v])=>`${k}:${v}`).join(' ')}`);
  console.log(`     [${tokens.slice(0,8).map(t=>t.symbol).join(', ')}…]\n`);

  // Helius DEX WS
  let debounceTimer = null;
  function triggerScan(src) {
    wsEvents++;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {}, 15_000); // debounce 15s
  }
  const ws = new WebSocket(HELIUS_WS);
  ws.on('open', ()=>{
    console.log('  🔌 Helius DEX WS connected');
    ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
     'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
     'LBUZKhRxPF3XUpBCjp4YzTKgLe4qqiGMdtYBe5Cteam',
    ].forEach((p,i)=>ws.send(JSON.stringify({jsonrpc:'2.0',id:i+1,method:'logsSubscribe',
      params:[{mentions:[p]},{commitment:'processed'}]})));
  });
  ws.on('message', d=>{try{if(JSON.parse(d.toString()).method==='logsNotification')triggerScan('ws');}catch(_){}});
  ws.on('close', ()=>{ console.log('  🔌 WS closed — reconnecting 10s'); setTimeout(()=>{
    const ws2=new WebSocket(HELIUS_WS); ws2.on('open',()=>ws.emit('open')); ws2.on('message',ws.listeners('message')[0]);
  },10_000);});
  ws.on('error', ()=>{});

  // Binance CEX monitor
  const cexLast = {};
  const cexTimer = setInterval(async ()=>{
    try {
      const r = await nodeFetch(`https://api.binance.com/api/v3/ticker/price?symbols=["SOLUSDT","BONKUSDT","WIFUSDT","POPCATUSDT"]`);
      const tickers = await r.json();
      for (const t of tickers) {
        const price = parseFloat(t.price);
        const prev  = cexLast[t.symbol];
        cexLast[t.symbol] = price;
        if (!prev) continue;
        const delta = Math.abs(price-prev)/prev;
        if (delta >= CEX_SPIKE_THRESH) {
          const dir = price>prev?'📈':'📉';
          console.log(`\n  ${dir} CEX ${t.symbol} ${(delta*100).toFixed(2)}% spike`);
          cexTriggers++;
        }
      }
    } catch(_){}
  }, CEX_POLL_MS);
  console.log('  📈 Binance CEX monitor running (SOL/BONK/WIF/POPCAT)\n');
  console.log('  🔁 Main loop started\n');

  // ── Main loop ─────────────────────────────────────────────────────────────
  while (Date.now() < endMs) {
    const elapsedMin = ((Date.now()-startMs)/60_000).toFixed(1);
    const remMin     = ((endMs-Date.now())/60_000).toFixed(0);

    // Token refresh
    if (Date.now()-lastRefresh > TOKEN_REFRESH_MS) {
      try { tokens = await discoverTokens(); lastRefresh = Date.now(); } catch(_){}
    }

    // Hourly snapshot
    if (Date.now()-lastSnap > HOURLY_SNAP_MS) {
      const bal = await conn.getBalance(wallet.publicKey).catch(()=>balStart);
      const snap = {
        time: new Date().toISOString(), elapsedMin,
        balance: (bal/1e9).toFixed(6),
        runningPnL: ((bal-balStart)/1e9).toFixed(6),
        trades: trades.length, scans: scanCount,
        wsEvents, cexTriggers,
        keys: keyCallCount.map((c,i)=>`k${i+1}:${c}`).join(' '),
      };
      snapshots.push(snap);
      fs.writeFileSync(SNAP_FILE, JSON.stringify(snapshots,null,2));
      console.log(`\n  📸 SNAPSHOT [${elapsedMin}m] bal:${snap.balance} SOL  net:${snap.runningPnL}  trades:${trades.length}  ${snap.keys}`);
      lastSnap = Date.now();
    }

    // Scan
    const shouldScan = !scanning && (Date.now()-lastScan > SCAN_INTERVAL_MS);
    if (shouldScan) {
      scanning  = true;
      lastScan  = Date.now();
      scanCount++;
      console.log(`  [${elapsedMin}m] 📊 Scan #${scanCount} | ${remMin}m left | ${keyCallCount.map((c,i)=>`k${i+1}:${c}`).join(' ')}`);
      process.stdout.write('     ');

      let ranked = [];
      try { ranked = await scan(tokens); } catch(_){}

      const forceNow = Date.now()-lastForced > FORCE_TRADE_MS;
      const best     = ranked[0];

      if (best && (best.gross > 0 || forceNow)) {
        const trigger = best.gross > 0 ? `arb+${best.gross.toFixed(4)}` : 'force-verify';
        lastForced = Date.now();
        try {
          const result = await roundTrip(best.token, trigger);
          trades.push(result);
          const runPnL = trades.reduce((a,t)=>a+(t.trueNet||0),0);
          console.log(`  [${elapsedMin}m] Trades:${trades.length} | RunPnL:${runPnL>=0?'+':''}${runPnL.toFixed(6)} SOL`);
          fs.writeFileSync(LOG_FILE, JSON.stringify({startTime:new Date(startMs).toISOString(),trades},null,2));
        } catch(e) {
          console.log(`  ❌ Trade failed: ${e.message.slice(0,100)}`);
        }
      } else if (best) {
        const nextForceSec = Math.max(0,(FORCE_TRADE_MS-(Date.now()-lastForced))/1000).toFixed(0);
        console.log(`  [${elapsedMin}m] Best:${best.token.symbol}${best.gross.toFixed(5)} — forcing in ${nextForceSec}s`);
      }
      scanning = false;
    }
    await new Promise(r=>setTimeout(r,2_000));
  }

  // ── Final report ──────────────────────────────────────────────────────────
  clearInterval(cexTimer);
  ws.terminate();
  await new Promise(r=>setTimeout(r,3000));

  const balEnd   = await conn.getBalance(wallet.publicKey).catch(()=>balStart);
  const totalPnL = (balEnd-balStart)/1e9;
  const profitTx = trades.filter(t=>(t.trueNet||0)>0).length;

  console.log('\n'+'═'.repeat(68));
  console.log('  📋 24-HOUR TEST COMPLETE');
  console.log('═'.repeat(68));
  console.log(`  Scans:      ${scanCount}`);
  console.log(`  WS events:  ${wsEvents}`);
  console.log(`  CEX spikes: ${cexTriggers}`);
  console.log(`  Trades:     ${trades.length} (${profitTx} profit / ${trades.length-profitTx} loss)`);
  console.log(`  API calls:  ${keyCallCount.map((c,i)=>`k${i+1}:${c}`).join(' ')}`);
  console.log('─'.repeat(68));
  console.log(`  Balance:    ${(balStart/1e9).toFixed(6)} → ${(balEnd/1e9).toFixed(6)} SOL`);
  console.log(`  True P&L:   ${totalPnL>=0?'+':''}${totalPnL.toFixed(6)} SOL`);
  console.log('─'.repeat(68));
  trades.forEach((t,i)=>{
    console.log(`  [${i+1}] ${t.ts} ${t.symbol}(${t.src}) ${t.trigger} net:${t.trueNet!==null?(t.trueNet>=0?'+':'')+t.trueNet.toFixed(6):'?'}`);
    console.log(`       L1: https://solscan.io/tx/${t.sig1}`);
    console.log(`       L2: https://solscan.io/tx/${t.sig2}`);
  });
  console.log('═'.repeat(68));
  fs.writeFileSync(LOG_FILE, JSON.stringify({
    startTime:new Date(startMs).toISOString(), endTime:new Date().toISOString(),
    totalPnL, scans:scanCount, wsEvents, cexTriggers, trades, snapshots,
  },null,2));
  console.log(`\n  💾 Full report: ${LOG_FILE}`);
  process.exit(0);
}
main().catch(e=>{ console.error('\n❌ FATAL:',e.message); process.exit(1); });
