/**
 * ARB PROFIT ENGINE — Aggressive Profit-First Strategy
 * ═══════════════════════════════════════════════════════════════════
 *  RULES:
 *   1. NEVER execute when gross spread ≤ 0 after fee estimate
 *   2. Quote TOKEN→SOL on BOTH Bags AND Jupiter, use best exit
 *   3. Trigger scan instantly on DEX WS event or CEX 0.3% spike
 *   4. Focus rotating set of volatile tokens (pump.fun + Bags natives)
 *   5. wSOL throughout — no native wrap/unwrap overhead
 *
 *  PROFIT MATH (0.05 SOL trade):
 *   Bags fee:  ~0.5–1% per leg × 2 = 0.0005–0.001 SOL
 *   Gas:       ~0.0001 SOL × 2 = 0.0002 SOL
 *   Breakeven: gross > 0.0007–0.0012 SOL
 *   Floor set: MIN_GROSS_LAM = 800_000 (0.0008 SOL above zero)
 *   Execute when: best_leg2_out - TRADE_LAM > MIN_GROSS_LAM
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
const HELIUS_RPC = process.env.RPC_ENDPOINT || 'https://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY';
const HELIUS_WS  = (process.env.RPC_WEBSOCKET || 'wss://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY').replace(/\/$/, '');
const CHAIN_RPC  = 'https://rpc.YOUR_CHAINSTACK_ENDPOINT';
const BAGS_API   = 'https://public-api-v2.bags.fm/api/v1';
const JUP_API    = 'https://lite-api.jup.ag/swap/v1';
const wSOL       = 'So11111111111111111111111111111111111111112';
const USDC       = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const LOG_FILE   = './arb_profit_trades.json';

const BAGS_KEYS = [
  process.env.BAGS_API_KEY   || 'bags_prod_bhNWKWR4_HAseNYlrmgpJX4NklFdCzAbDdYpx9UIIgg',
  process.env.BAGS_API_KEY_2 || 'bags_prod_kfsnkMqQ4NJW16_BknWl1ox31Ysr1kZL1MA2mGSlt5c',
  process.env.BAGS_API_KEY_3 || 'bags_prod_QJ3a_QsV3R8FEg9kbxWZ7yMOqVD7OnAu2mxLHNfkia8',
  process.env.BAGS_API_KEY_4 || 'bags_prod_a64DNgP7fs2O9DcqT0JIIva4Qsy_XEPmdgLtP67jbSU',
  process.env.BAGS_API_KEY_5 || 'bags_prod_pIHo6k8F6k7W_5q0N4kVCzodVgPqMBQ_tj0G0S2Mn9o',
  process.env.BAGS_API_KEY_6 || 'bags_prod_b5Aeygaqa1vb5JGdwm5hsRoBCyVKMBCK12p-DCIodlU',
];

// ── Rate-safe timing ─────────────────────────────────────────────────────────
// 6 keys × 1000/hr = 6000/hr. KEY_GAP = 3600ms/key, effective 600ms between calls.
// 10 tokens × 3 quotes (leg1 + bags_leg2 + jup_leg2) = 30 calls/scan.
// 30 × 600ms = 18s scan time. Baseline 60s = comfortable headroom.
const TRADE_LAM      = 50_000_000;   // 0.05 SOL
const MIN_GROSS_LAM  = 800_000;      // must beat this to execute (0.0008 SOL above zero)
const SLIP_BPS       = 100;          // 1% slippage tolerance
const CU_PRICE       = 150_000;      // elevated priority on time-sensitive swaps
const KEY_GAP_MS     = 3_600;        // 3.6s/key = 1000/hr ceiling
const SCAN_MS        = 60_000;       // 60s baseline scan (WS/CEX override sooner)
const WS_DEBOUNCE_MS = 8_000;        // 8s debounce on WS events
const CEX_POLL_MS    = 10_000;       // Binance poll every 10s
const CEX_THRESH     = 0.003;        // 0.3% CEX spike triggers scan
const CONFIRM_MS     = 90_000;       // 90s confirm window
const TOKEN_REFRESH  = 10 * 60_000;  // token list refresh every 10 min
const MAX_TOKENS     = 10;           // tokens per scan

// ── Init ──────────────────────────────────────────────────────────────────────
const wallet    = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.WALLET_KEYPAIR_PATH||'./real_wallet.json','utf-8'))));
const conn      = new Connection(HELIUS_RPC, { commitment: 'confirmed' });
const connChain = new Connection(CHAIN_RPC,   { commitment: 'confirmed' });

const keyLast  = BAGS_KEYS.map(() => 0);
const keyCalls = BAGS_KEYS.map(() => 0);
let scanCount = 0, execCount = 0, profitCount = 0, totalNet = 0;
let scanning  = false, lastScan = 0, lastRefresh = 0;

// ── Key rotation ──────────────────────────────────────────────────────────────
async function nextKey() {
  let best = 0, bestAvail = Infinity;
  for (let i = 0; i < BAGS_KEYS.length; i++) {
    const a = keyLast[i] + KEY_GAP_MS;
    if (a < bestAvail) { bestAvail = a; best = i; }
  }
  const w = bestAvail - Date.now();
  if (w > 0) await new Promise(r => setTimeout(r, w));
  keyLast[best] = Date.now();
  keyCalls[best]++;
  return { key: BAGS_KEYS[best], idx: best };
}

// ── Bags quote ─────────────────────────────────────────────────────────────────
async function bagsQuote(inMint, outMint, amount) {
  const { key, idx } = await nextKey();
  const r = await nodeFetch(
    `${BAGS_API}/trade/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageMode=auto&slippageBps=${SLIP_BPS}`,
    { headers: { 'x-api-key': key } }
  );
  const rl = r.headers.get('x-ratelimit-remaining');
  if (r.status === 429) {
    const reset = r.headers.get('x-ratelimit-reset');
    const wait  = reset ? Math.max(0, Number(reset)*1000 - Date.now()) + 500 : 4000;
    keyLast[idx] = Date.now() + wait;
    throw new Error(`429 k${idx+1}`);
  }
  const j = await r.json();
  if (!j.success || !j.response?.outAmount) throw new Error(`bags quote fail`);
  return { q: j.response, rl: parseInt(rl)||0, router: 'bags' };
}

// ── Jupiter lite quote (free, no auth, generous limits) ───────────────────────
async function jupQuote(inMint, outMint, amount) {
  const r = await nodeFetch(
    `${JUP_API}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${SLIP_BPS}&restrictIntermediateTokens=true`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!r.ok) throw new Error(`jup ${r.status}`);
  const j = await r.json();
  if (!j.outAmount) throw new Error('jup no outAmount');
  return { outAmount: j.outAmount, quoteData: j, router: 'jup' };
}

// ── Bags swap tx ──────────────────────────────────────────────────────────────
async function bagsSwapTx(quoteObj) {
  const { key } = await nextKey();
  const r = await nodeFetch(`${BAGS_API}/trade/swap`, { method:'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quoteObj,
      userPublicKey: wallet.publicKey.toBase58(),
      computeUnitPriceMicroLamports: CU_PRICE,
      wrapAndUnwrapSol: false,
    }),
  });
  const j = await r.json();
  const tx = j.response?.swapTransaction || j.swapTransaction;
  if (!tx) throw new Error(`bags no tx: ${JSON.stringify(j).slice(0,80)}`);
  return tx;
}

// ── Jupiter swap tx ───────────────────────────────────────────────────────────
async function jupSwapTx(quoteData) {
  const r = await nodeFetch(`${JUP_API}/swap`, { method:'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quoteData,
      userPublicKey: wallet.publicKey.toBase58(),
      computeUnitPriceMicroLamports: CU_PRICE,
      wrapAndUnwrapSol: false,
      dynamicComputeUnitLimit: true,
    }),
  });
  const j = await r.json();
  if (!j.swapTransaction) throw new Error(`jup no tx: ${JSON.stringify(j).slice(0,80)}`);
  return j.swapTransaction;
}

// ── Send & confirm ────────────────────────────────────────────────────────────
async function sendAndConfirm(txStr, label) {
  const buf = Buffer.from(bs58.decode(txStr));
  let tx; try { tx = VersionedTransaction.deserialize(buf); } catch(_) { tx = Transaction.from(buf); }
  tx.sign([wallet]);
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
  console.log(`     🔗 ${label}: https://solscan.io/tx/${sig}`);
  const deadline = Date.now() + CONFIRM_MS;
  let lastSend   = Date.now();
  while (Date.now() < deadline) {
    const [h,c] = await Promise.allSettled([
      conn.getSignatureStatus(sig,      { searchTransactionHistory: true }),
      connChain.getSignatureStatus(sig, { searchTransactionHistory: true }),
    ]);
    for (const res of [h,c]) {
      if (res.status !== 'fulfilled') continue;
      const st = res.value?.value;
      if (st?.err) throw new Error(`${label} on-chain err: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') {
        console.log(`     ✅ ${label} confirmed`);
        return sig;
      }
    }
    if (Date.now() - lastSend > 20_000) {
      conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(()=>{});
      lastSend = Date.now();
    }
    await new Promise(r => setTimeout(r, 2_000));
  }
  throw new Error(`${label} not confirmed in 90s — ${sig}`);
}

// ── Token discovery ───────────────────────────────────────────────────────────
async function discoverTokens() {
  const [bagsRes, pumpRes, boostRes] = await Promise.allSettled([
    bagsQuote(wSOL, USDC, TRADE_LAM).then(async () => {
      const { key } = await nextKey();
      const r = await nodeFetch(`${BAGS_API}/token-launch/top-tokens/lifetime-fees`, { headers: { 'x-api-key': key } });
      const j = await r.json();
      return j.success ? j.response.slice(0,8).map(t=>({ symbol: t.tokenInfo?.symbol||t.token.slice(0,6), mint: t.token, src:'bags' })) : [];
    }).catch(()=>[]),
    nodeFetch('https://api.dexscreener.com/latest/dex/search?q=pump', { headers: {'User-Agent':'Mozilla/5.0'} })
      .then(r=>r.json()).then(j=>(j.pairs||[])
        .filter(p=>p.chainId==='solana'&&(p.dexId==='pumpswap'||p.dexId==='raydium')
          &&p.quoteToken?.address===wSOL&&(p.volume?.h1||0)>10_000&&(p.liquidity?.usd||0)>2_000&&(p.liquidity?.usd||0)<300_000)
        .sort((a,b)=>(b.volume?.h1||0)-(a.volume?.h1||0)).slice(0,6)
        .map(p=>({ symbol:p.baseToken.symbol, mint:p.baseToken.address, src:'pump' }))).catch(()=>[]),
    nodeFetch('https://api.dexscreener.com/token-boosts/top/v1', { headers: {'User-Agent':'Mozilla/5.0'} })
      .then(r=>r.json()).then(j=>(Array.isArray(j)?j:[]).filter(t=>t.chainId==='solana').slice(0,4)
        .map(t=>({ symbol: t.tokenAddress.slice(0,6)+'…', mint: t.tokenAddress, src:'boost' }))).catch(()=>[]),
  ]);
  const seen = new Set([wSOL]);
  const merged = [];
  // Volatile first — pump.fun tokens have wider spreads
  const priority = [
    ...(pumpRes.status==='fulfilled' ? pumpRes.value : []),
    ...(boostRes.status==='fulfilled' ? boostRes.value : []),
    ...(bagsRes.status==='fulfilled' ? bagsRes.value : []),
    { symbol:'BONK', mint:'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', src:'stable' },
    { symbol:'WIF',  mint:'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', src:'stable' },
    { symbol:'USDC', mint: USDC, src:'stable' },
  ];
  for (const t of priority) if (t.mint&&!seen.has(t.mint)){seen.add(t.mint);merged.push(t);}
  return merged.slice(0, 20);
}

// ── CORE SCAN — find best cross-router opportunity ────────────────────────────
async function findBestOpportunity(tokens) {
  const opps = [];
  const ts = new Date().toISOString().slice(11,19);
  console.log(`\n  [${ts}] 🔍 Scan #${++scanCount} | ${tokens.slice(0,MAX_TOKENS).map(t=>t.symbol).join(' ')}`);
  console.log(`       ${keyCalls.map((c,i)=>`k${i+1}:${c}`).join(' ')} | trades:${execCount}(${profitCount}✅) | net:${totalNet>=0?'+':''}${totalNet.toFixed(5)}`);

  for (const t of tokens.slice(0, MAX_TOKENS)) {
    try {
      // LEG1: Bags quote SOL → TOKEN
      const { q: leg1q, rl } = await bagsQuote(wSOL, t.mint, TRADE_LAM);
      const tokenOut = Number(leg1q.outAmount);
      if (!tokenOut) continue;

      // LEG2: Quote TOKEN → SOL on BOTH Bags and Jupiter simultaneously
      const [bagsLeg2, jupLeg2] = await Promise.allSettled([
        bagsQuote(t.mint, wSOL, tokenOut),
        jupQuote(t.mint, wSOL, tokenOut),
      ]);

      let bestOut = 0, bestRouter = 'none', bestLeg2Data = null;

      if (bagsLeg2.status === 'fulfilled') {
        const out = Number(bagsLeg2.value.q.outAmount);
        if (out > bestOut) { bestOut = out; bestRouter = 'bags'; bestLeg2Data = bagsLeg2.value.q; }
      }
      if (jupLeg2.status === 'fulfilled') {
        const out = Number(jupLeg2.value.outAmount);
        if (out > bestOut) { bestOut = out; bestRouter = 'jup'; bestLeg2Data = jupLeg2.value.quoteData; }
      }
      if (!bestOut) continue;

      const gross = bestOut - TRADE_LAM;
      const bagsOut = bagsLeg2.status==='fulfilled' ? Number(bagsLeg2.value.q.outAmount)||0 : 0;
      const jupOut  = jupLeg2.status==='fulfilled'  ? Number(jupLeg2.value.outAmount)||0    : 0;
      const bagsStr = bagsOut ? (bagsOut/1e9).toFixed(5) : 'ERR';
      const jupStr  = jupOut  ? (jupOut/1e9).toFixed(5)  : 'ERR';

      const flag = gross > MIN_GROSS_LAM ? '🟢' : gross > 0 ? '🟡' : '🔴';
      console.log(`       ${flag} ${t.symbol.padEnd(8)} gross:${(gross/1e9).toFixed(5)} | bags:${bagsStr} jup:${jupStr} exit:${bestRouter} [rl:${rl}]`);

      if (gross > MIN_GROSS_LAM) {
        opps.push({ token: t, gross, leg1q, leg2Data: bestLeg2Data, leg2Router: bestRouter });
      }
    } catch(e) {
      if (!e.message.includes('429')) console.log(`       ⚠️  ${t.symbol}: ${e.message.slice(0,50)}`);
    }
  }
  return opps.sort((a,b) => b.gross - a.gross);
}

// ── Execute ───────────────────────────────────────────────────────────────────
async function execute(opp) {
  const ts = new Date().toISOString().slice(11,19);
  console.log(`\n  [${ts}] ⚡ EXECUTING ${opp.token.symbol} | gross:+${(opp.gross/1e9).toFixed(5)} | exit:${opp.leg2Router}`);
  let balBefore; try { balBefore = await conn.getBalance(wallet.publicKey); } catch(_){}

  // LEG1: always Bags
  const tx1Str = await bagsSwapTx(opp.leg1q);
  const sig1   = await sendAndConfirm(tx1Str, 'LEG1(bags)');

  // LEG2: best router
  let sig2;
  if (opp.leg2Router === 'jup') {
    // Re-quote Jupiter fresh (output amount may have changed)
    const freshJup = await jupQuote(opp.token.mint, wSOL, Number(opp.leg1q.outAmount));
    const tx2Str   = await jupSwapTx(freshJup.quoteData);
    sig2 = await sendAndConfirm(tx2Str, 'LEG2(jup)');
  } else {
    // Re-quote Bags fresh (requestId expires)
    const { q: freshBags } = await bagsQuote(opp.token.mint, wSOL, Number(opp.leg1q.outAmount));
    const tx2Str = await bagsSwapTx(freshBags);
    sig2 = await sendAndConfirm(tx2Str, 'LEG2(bags)');
  }

  await new Promise(r => setTimeout(r, 2000));
  let trueNet = null;
  try {
    const balAfter = await conn.getBalance(wallet.publicKey);
    trueNet = (balAfter - (balBefore||balAfter)) / 1e9;
  } catch(_) {}

  execCount++;
  if ((trueNet||0) > 0) profitCount++;
  totalNet += (trueNet||0);

  const icon = trueNet > 0 ? '✅ PROFIT' : trueNet === 0 ? '➖ BREAK' : '📉 LOSS';
  console.log(`  ${icon}: ${trueNet!==null?(trueNet>=0?'+':'')+trueNet.toFixed(6)+' SOL':' unknown'} | total:${execCount} wins:${profitCount} net:${totalNet>=0?'+':''}${totalNet.toFixed(5)}`);

  const trade = {
    ts, symbol: opp.token.symbol, src: opp.token.src,
    grossQuoted: (opp.gross/1e9).toFixed(6), trueNet: trueNet?.toFixed(6),
    leg2Router: opp.leg2Router, sig1, sig2,
  };
  const existing = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE,'utf-8')) : [];
  existing.push(trade);
  fs.writeFileSync(LOG_FILE, JSON.stringify(existing, null, 2));
  return trade;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  let tokens = [];

  const balStart = await conn.getBalance(wallet.publicKey);
  console.log('\n' + '═'.repeat(68));
  console.log('  💹 ARB PROFIT ENGINE — Cross-Router, Profit-Gated');
  console.log('═'.repeat(68));
  console.log(`  Wallet:     ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance:    ${(balStart/1e9).toFixed(6)} SOL`);
  console.log(`  Trade size: ${TRADE_LAM/1e9} SOL | Slip: ${SLIP_BPS}bps`);
  console.log(`  Profit gate:+${MIN_GROSS_LAM/1e9} SOL gross min`);
  console.log(`  Exit router: BAGS vs JUPITER — best price wins`);
  console.log(`  Triggers:   DEX WS (instant) + CEX 0.3% + 60s baseline`);
  console.log(`  Keys:       ${BAGS_KEYS.length} Bags (${BAGS_KEYS.length*1000}/hr) + Jupiter lite (unlimited)`);
  console.log('═'.repeat(68) + '\n');

  console.log('  📡 Discovering tokens (pump-first)...');
  tokens = await discoverTokens();
  lastRefresh = Date.now();
  const src = {}; tokens.forEach(t=>{src[t.src]=(src[t.src]||0)+1;});
  console.log(`  🔄 ${tokens.length} tokens: ${Object.entries(src).map(([k,v])=>`${k}:${v}`).join(' ')}`);

  // ── WS trigger ────────────────────────────────────────────────────────────
  let wsDebTimer = null;
  let wsTrigger  = false;
  const triggerScan = () => {
    if (wsTrigger) return;
    wsTrigger = true;
    clearTimeout(wsDebTimer);
    wsDebTimer = setTimeout(() => { wsTrigger = false; }, WS_DEBOUNCE_MS);
  };
  const ws = new WebSocket(HELIUS_WS);
  ws.on('open', () => {
    console.log('  🔌 Helius DEX WS connected');
    ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
     'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
     'LBUZKhRxPF3XUpBCjp4YzTKgLe4qqiGMdtYBe5Cteam',
    ].forEach((p,i) => ws.send(JSON.stringify({ jsonrpc:'2.0', id:i+1,
      method:'logsSubscribe', params:[{mentions:[p]},{commitment:'processed'}] })));
  });
  ws.on('message', d => { try { if (JSON.parse(d.toString()).method==='logsNotification') triggerScan(); } catch(_){} });
  ws.on('close', () => setTimeout(() => { ws.emit('reconnect'); }, 10_000));
  ws.on('error', ()=>{});

  // ── Binance CEX monitor ───────────────────────────────────────────────────
  const cexLast = {};
  let cexTriggers = 0;
  setInterval(async () => {
    try {
      const r = await nodeFetch('https://api.binance.com/api/v3/ticker/price?symbols=["SOLUSDT","BONKUSDT","WIFUSDT","POPCATUSDT"]');
      const tickers = await r.json();
      for (const t of tickers) {
        const price = parseFloat(t.price);
        const prev  = cexLast[t.symbol];
        cexLast[t.symbol] = price;
        if (!prev) continue;
        const delta = Math.abs(price-prev)/prev;
        if (delta >= CEX_THRESH) {
          const dir = price > prev ? '📈' : '📉';
          console.log(`\n  ${dir} CEX ${t.symbol} +${(delta*100).toFixed(2)}% — triggering IMMEDIATE scan`);
          cexTriggers++;
          lastScan = 0; // force immediate scan on next loop tick
        }
      }
    } catch(_){}
  }, CEX_POLL_MS);
  console.log('  📈 Binance CEX monitor started (SOL/BONK/WIF/POPCAT)\n');
  console.log('  ⏳ Profit gate: only 🟢 trades execute. Monitoring...\n');

  // ── Main loop ─────────────────────────────────────────────────────────────
  // WS fires constantly on Helius (~every 12s). We honour at most 1 WS-triggered
  // scan per SCAN_MS window so the baseline timer effectively gates both paths.
  while (true) {
    // Token refresh
    if (Date.now() - lastRefresh > TOKEN_REFRESH) {
      try { tokens = await discoverTokens(); lastRefresh = Date.now(); } catch(_){}
    }

    const elapsed    = Date.now() - lastScan;
    const baselineDue = elapsed > SCAN_MS;
    const wsDue      = wsTrigger && elapsed > WS_DEBOUNCE_MS; // honour WS only after debounce gap
    const shouldScan = !scanning && (baselineDue || wsDue);

    if (shouldScan) {
      scanning  = true;
      wsTrigger = false;
      lastScan  = Date.now(); // reset timer for both paths
      try {
        const opps = await findBestOpportunity(tokens);
        if (opps.length > 0) {
          console.log(`\n  🟢 ${opps.length} profitable opp(s) found — executing best: ${opps[0].token.symbol}`);
          await execute(opps[0]);
        } else {
          console.log('  ⏸  No profitable spread this cycle — holding');
        }
      } catch(e) {
        console.log(`  ❌ Scan error: ${e.message.slice(0,100)}`);
      }
      scanning = false;
    }
    await new Promise(r => setTimeout(r, 1_000));
  }
}
main().catch(e => { console.error('\n❌ FATAL:', e.message); process.exit(1); });
