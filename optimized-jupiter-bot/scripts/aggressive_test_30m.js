/**
 * AGGRESSIVE 30-MINUTE LIVE TEST
 * ════════════════════════════════════════════════════════════════════
 * Tests ALL engine capabilities over 30 minutes:
 *  ✦ Token discovery: Bags top-fees + pump.fun + DexScreener boosted + Meteora DBC
 *  ✦ 6-key Bags API pool (6000 req/hr), exponential backoff on 429
 *  ✦ Helius DEX WebSocket — program log triggers
 *  ✦ Binance CEX REST polling — price spike triggers
 *  ✦ Full quote→swap→sign→send→confirm pipeline (90s multi-RPC confirm)
 *  ✦ Forced trade every 5 min on best available spread (pipeline verify)
 *  ✦ True P&L via before/after balance diff
 *  ✦ All tx links logged to aggressive_test_30m_trades.json
 * ════════════════════════════════════════════════════════════════════
 */
'use strict';
require('dotenv').config();

const nodeFetch = require('node-fetch');
const WebSocket = require('ws');
const bs58      = require('bs58');
const { Connection, Keypair, VersionedTransaction, Transaction } = require('@solana/web3.js');
const fs = require('fs');

// ── Config ───────────────────────────────────────────────────────────────────
const HELIUS_RPC = process.env.RPC_ENDPOINT || 'https://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY';
const HELIUS_WS  = (process.env.RPC_WEBSOCKET || 'wss://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY').replace(/\/$/, '');
const CHAIN_RPC  = 'https://rpc.YOUR_CHAINSTACK_ENDPOINT';
const BAGS_API   = 'https://public-api-v2.bags.fm/api/v1';
const SOL_MINT   = 'So11111111111111111111111111111111111111112';
const USDC_MINT  = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const BAGS_KEYS = [
  process.env.BAGS_API_KEY   || 'process.env.BAGS_API_KEY',
  process.env.BAGS_API_KEY_2 || 'process.env.BAGS_API_KEY_2',
  process.env.BAGS_API_KEY_3 || 'process.env.BAGS_API_KEY_3',
  process.env.BAGS_API_KEY_4 || 'process.env.BAGS_API_KEY_4',
  process.env.BAGS_API_KEY_5 || 'process.env.BAGS_API_KEY_5',
  process.env.BAGS_API_KEY_6 || 'process.env.BAGS_API_KEY_6',
];

// Timing — rate-compliant for 6 keys
const TEST_DURATION_MS  = 30 * 60_000;  // 30 minutes
const SCAN_INTERVAL_MS  = 90_000;       // scan every 90s (rate-safe with 6 keys)
const FORCE_TRADE_MS    = 10 * 60_000;  // force a trade every 10 min
const TOKEN_REFRESH_MS  = 10 * 60_000;  // refresh token list every 10 min
const KEX_POLL_MS       = 10_000;       // Binance price poll every 10s
const KEY_GAP_MS        = 3_600;        // 3.6s per key = 1000/hr each
const TRADE_LAM         = 50_000_000;   // 0.05 SOL per leg
const SLIP_BPS          = 100;          // 1% slippage
const CU_PRICE          = 100_000;      // high priority
const CEX_SPIKE_THRESH  = 0.003;        // 0.3% CEX move triggers scan
const CONFIRM_TIMEOUT   = 90_000;       // 90s confirmation window
const MAX_SCAN_TOKENS   = 8;            // scan top-8 per cycle (16 calls = 19s at 1.2s/call gap)


const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH || './real_wallet.json';
const raw    = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
const wallet = Keypair.fromSecretKey(new Uint8Array(raw));

const conn      = new Connection(HELIUS_RPC, { commitment: 'confirmed' });
const connChain = new Connection(CHAIN_RPC,   { commitment: 'confirmed' });

// ── Per-key rate limiting ─────────────────────────────────────────────────────
const keyLastCall  = BAGS_KEYS.map(() => 0);
const keyCallCount = BAGS_KEYS.map(() => 0);

async function nextKey() {
  let best = 0, bestAvail = Infinity;
  for (let i = 0; i < BAGS_KEYS.length; i++) {
    const avail = keyLastCall[i] + KEY_GAP_MS;
    if (avail < bestAvail) { bestAvail = avail; best = i; }
  }
  const wait = bestAvail - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  keyLastCall[best]  = Date.now();
  keyCallCount[best]++;
  return { key: BAGS_KEYS[best], idx: best };
}

// ── Bags API call with exponential backoff ────────────────────────────────────
async function bagsCall(path, method = 'GET', body = null, maxRetries = 12) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { key, idx } = await nextKey();
    const opts = {
      method,
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
    let r;
    try { r = await nodeFetch(`${BAGS_API}${path}`, opts); }
    catch(e) { console.log(`  ⚠️  fetch err: ${e.message.slice(0,50)}`); continue; }
    const remaining = r.headers.get('x-ratelimit-remaining');
    if (remaining) process.stdout.write(`[k${idx+1}:${remaining}] `);
    if (r.status === 429) {
      const reset  = r.headers.get('x-ratelimit-reset');
      const resetMs = reset ? Math.max(0, Number(reset) * 1000 - Date.now()) : 0;
      const backoff = Math.min(2000 * Math.pow(2, attempt), 60_000);
      const wait    = Math.max(backoff, resetMs ? resetMs + 500 : 0);
      console.log(`\n  ⏳ key[${idx}] 429 backoff ${(wait/1000).toFixed(1)}s`);
      keyLastCall[idx] = Date.now() + wait;
      continue;
    }
    const j = await r.json();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0,80)}`);
    return j;
  }
  throw new Error('Bags: max retries exceeded');
}

// ── Token Discovery (4 sources) ────────────────────────────────────────────────
async function discoverTokens() {
  const results = await Promise.allSettled([
    // Source 1: Bags top-fees
    (async () => {
      const j = await bagsCall('/token-launch/top-tokens/lifetime-fees');
      if (!j.success || !Array.isArray(j.response)) return [];
      return j.response.slice(0, 8).map(t => ({
        symbol: t.tokenInfo?.symbol || t.token.slice(0,6), mint: t.token, src: 'bags'
      }));
    })(),
    // Source 2: pump.fun via DexScreener
    (async () => {
      const r = await nodeFetch('https://api.dexscreener.com/latest/dex/search?q=pump', { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const j = await r.json();
      return (j.pairs || [])
        .filter(p => p.chainId === 'solana' && (p.dexId === 'pumpswap' || p.dexId === 'raydium')
          && p.quoteToken?.address === SOL_MINT && (p.volume?.h1||0) > 5_000 && (p.liquidity?.usd||0) > 1_000 && (p.liquidity?.usd||0) < 500_000)
        .sort((a,b) => (b.volume?.h1||0) - (a.volume?.h1||0)).slice(0,6)
        .map(p => ({ symbol: p.baseToken.symbol, mint: p.baseToken.address, src: 'pump' }));
    })(),
    // Source 3: DexScreener boosted
    (async () => {
      const r = await nodeFetch('https://api.dexscreener.com/token-boosts/top/v1', { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const j = await r.json();
      return (Array.isArray(j) ? j : []).filter(t => t.chainId==='solana').slice(0,5)
        .map(t => ({ symbol: t.tokenAddress.slice(0,6)+'…', mint: t.tokenAddress, src: 'boost' }));
    })(),
    // Source 4: Meteora DBC < 6h
    (async () => {
      const r = await nodeFetch('https://api.dexscreener.com/latest/dex/search?q=solana%20meteora%20dbc', { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const j = await r.json();
      return (j.pairs || []).filter(p => {
        const ageH = (Date.now() - (p.pairCreatedAt||0)) / 3_600_000;
        return ageH < 6 && p.quoteToken?.address === SOL_MINT && (p.volume?.h24||0) > 1_000;
      }).slice(0,5).map(p => ({ symbol: p.baseToken.symbol, mint: p.baseToken.address, src: 'dbc' }));
    })(),
  ]);
  const seen = new Set([SOL_MINT]);
  const merged = [];
  // Stable seeds always included
  const seeds = [
    { symbol:'USDC', mint: USDC_MINT, src:'stable' },
    { symbol:'BONK', mint:'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', src:'stable' },
    { symbol:'WIF',  mint:'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', src:'stable' },
  ];
  for (const r of [...results, { status:'fulfilled', value: seeds }]) {
    if (r.status === 'fulfilled') for (const t of r.value)
      if (t.mint && !seen.has(t.mint)) { seen.add(t.mint); merged.push(t); }
  }
  return merged.slice(0, 25);
}

// ── Quote ────────────────────────────────────────────────────────────────────
async function getQuote(inputMint, outputMint, amount) {
  const j = await bagsCall(`/trade/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageMode=auto&slippageBps=${SLIP_BPS}`);
  if (!j.success || !j.response?.outAmount) throw new Error(`bad quote: ${JSON.stringify(j).slice(0,60)}`);
  return j.response;
}

// ── Swap ─────────────────────────────────────────────────────────────────────
async function getSwapTx(quoteObj) {
  const j = await bagsCall('/trade/swap', 'POST', {
    quoteResponse: quoteObj, userPublicKey: wallet.publicKey.toBase58(),
    computeUnitPriceMicroLamports: CU_PRICE, wrapAndUnwrapSol: false,
  });
  const txStr = j.response?.swapTransaction || j.swapTransaction;
  if (!txStr) throw new Error(`no swapTransaction: ${JSON.stringify(j).slice(0,80)}`);
  return txStr;
}

// ── Confirm tx with 90s multi-RPC polling ────────────────────────────────────
async function sendAndConfirm(swapTxStr, label) {
  const buf = Buffer.from(bs58.decode(swapTxStr));
  let tx; try { tx = VersionedTransaction.deserialize(buf); } catch(_) { tx = Transaction.from(buf); }
  tx.sign([wallet]);
  const rawBuf = tx.serialize();
  const sig = await conn.sendRawTransaction(rawBuf, { skipPreflight: true, maxRetries: 3 });
  console.log(`     🔗 ${label}: https://solscan.io/tx/${sig}`);
  const deadline  = Date.now() + CONFIRM_TIMEOUT;
  let lastResend  = Date.now();
  while (Date.now() < deadline) {
    const [h, c] = await Promise.allSettled([
      conn.getSignatureStatus(sig,      { searchTransactionHistory: true }),
      connChain.getSignatureStatus(sig, { searchTransactionHistory: true }),
    ]);
    for (const r of [h, c]) {
      if (r.status !== 'fulfilled') continue;
      const st = r.value?.value;
      if (st?.err) throw new Error(`${label} failed: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') {
        console.log(`     ✅ ${label} confirmed`);
        return sig;
      }
    }
    if (Date.now() - lastResend > 20_000) {
      conn.sendRawTransaction(rawBuf, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      lastResend = Date.now();
    }
    await new Promise(r => setTimeout(r, 2_000));
  }
  throw new Error(`${label} not confirmed in ${CONFIRM_TIMEOUT/1000}s — sig: ${sig}`);
}

// ── Execute one round-trip  ────────────────────────────────────────────────────
async function executeRoundTrip(token, trigger) {
  const ts = new Date().toISOString().slice(11,19);
  console.log(`\n  [${ts}] 🔄 ${trigger} | ${token.symbol} (${token.src})`);
  const balBefore = await conn.getBalance(wallet.publicKey).catch(() => null);

  const q1 = await getQuote(SOL_MINT, token.mint, TRADE_LAM);
  const out1 = Number(q1.outAmount);
  const q2 = await getQuote(token.mint, SOL_MINT, out1);
  const out2 = Number(q2.outAmount);
  const gross = (out2 - TRADE_LAM) / 1e9;
  console.log(`     quote: ${(TRADE_LAM/1e9).toFixed(3)} SOL → ${out1} ${token.symbol} → ${(out2/1e9).toFixed(6)} SOL  gross:${gross>=0?'+':''}${gross.toFixed(6)}`);

  const tx1 = await getSwapTx(q1);
  const sig1 = await sendAndConfirm(tx1, 'LEG1');

  // Re-quote LEG2 fresh (requestId expires)
  const q2fresh = await getQuote(token.mint, SOL_MINT, out1);
  const tx2 = await getSwapTx(q2fresh);
  const sig2 = await sendAndConfirm(tx2, 'LEG2');

  await new Promise(r => setTimeout(r, 2000));
  const balAfter = await conn.getBalance(wallet.publicKey).catch(() => null);
  const trueNet = balBefore && balAfter ? (balAfter - balBefore) / 1e9 : null;
  const icon = trueNet === null ? '❓' : trueNet > 0 ? '✅' : '📉';
  if (trueNet !== null) console.log(`     ${icon} net: ${trueNet>=0?'+':''}${trueNet.toFixed(6)} SOL`);
  return { ts, symbol: token.symbol, src: token.src, trigger, gross, trueNet, sig1, sig2 };
}

// ── Scan for best opportunity ─────────────────────────────────────────────────
async function scanBest(tokens) {
  const results = [];
  for (const t of tokens) {
    try {
      const q1 = await getQuote(SOL_MINT, t.mint, TRADE_LAM);
      const out1 = Number(q1.outAmount);
      if (!out1) continue;
      const q2 = await getQuote(t.mint, SOL_MINT, out1);
      const gross = (Number(q2.outAmount) - TRADE_LAM) / 1e9;
      results.push({ token: t, gross, q1, q2 });
      process.stdout.write(`${t.symbol}:${gross>=0?'+':''}${gross.toFixed(4)} `);
    } catch(e) {
      if (!e.message.includes('429')) process.stdout.write(`${t.symbol}:ERR `);
    }
  }
  console.log('');
  return results.sort((a, b) => b.gross - a.gross);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const startMs = Date.now();
  const endMs   = startMs + TEST_DURATION_MS;
  const trades = [];
  let scanCount = 0, wsEvents = 0;
  let lastForcedTrade = 0, lastTokenRefresh = 0;
  let tokens = [];

  const balStart = await conn.getBalance(wallet.publicKey);

  console.log('\n' + '═'.repeat(68));
  console.log('  ⚡ AGGRESSIVE 30-MINUTE LIVE TEST');
  console.log('═'.repeat(68));
  console.log(`  Wallet:   ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance:  ${(balStart/1e9).toFixed(6)} SOL`);
  console.log(`  Trade:    ${TRADE_LAM/1e9} SOL/leg | ${SLIP_BPS}bps slip | ${CU_PRICE} CU`);
  console.log(`  Keys:     ${BAGS_KEYS.length} Bags keys (${BAGS_KEYS.length*1000}/hr combined)`);
  console.log(`  Triggers: DEX WS + Binance CEX (0.3%) + 40s baseline + 5min force`);
  console.log(`  Runtime:  30 minutes — ends at ${new Date(endMs).toISOString().slice(11,19)} UTC`);
  console.log('═'.repeat(68) + '\n');

  // ── Initial token discovery ─────────────────────────────────────────────────
  console.log('  📡 Discovering tokens (4 sources)...');
  tokens = await discoverTokens();
  lastTokenRefresh = Date.now();
  const bySrc = {};
  tokens.forEach(t => { bySrc[t.src] = (bySrc[t.src]||0)+1; });
  console.log(`  🔄 ${tokens.length} tokens | ${Object.entries(bySrc).map(([k,v])=>`${k}:${v}`).join(' ')}`);
  console.log(`     [${tokens.slice(0,10).map(t=>t.symbol).join(', ')}${tokens.length>10?', …':''}]\n`);

  // ── Helius WS trigger ───────────────────────────────────────────────────────
  let scanQueued = false;
  const debounceScan = () => {
    if (scanQueued) return;
    wsEvents++;
    scanQueued = true;
    setTimeout(() => { scanQueued = false; }, 15_000);
  };
  const ws = new WebSocket(HELIUS_WS);
  ws.on('open', () => {
    console.log('  🔌 Helius DEX WS connected');
    ['675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',  // Raydium
     'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',   // Orca
     'LBUZKhRxPF3XUpBCjp4YzTKgLe4qqiGMdtYBe5Cteam',  // Meteora DBC
    ].forEach((p,i) => ws.send(JSON.stringify({ jsonrpc:'2.0', id:i+1, method:'logsSubscribe',
      params:[{ mentions:[p] },{ commitment:'processed' }] })));
  });
  ws.on('message', (d) => { try { if (JSON.parse(d.toString()).method === 'logsNotification') debounceScan(); } catch(_){} });
  ws.on('close', () => console.log('  🔌 Helius WS closed'));
  ws.on('error', () => {});

  // ── Binance REST CEX monitor ────────────────────────────────────────────────
  const cexPairs = ['SOLUSDT','BONKUSDT','WIFUSDT','POPCATUSDT'];
  const cexLast = {};
  let cexTriggers = 0;
  async function pollCEX() {
    try {
      const r = await nodeFetch(`https://api.binance.com/api/v3/ticker/price?symbols=["${cexPairs.join('","')}"]`);
      const tickers = await r.json();
      for (const t of tickers) {
        const price = parseFloat(t.price);
        const prev  = cexLast[t.symbol];
        cexLast[t.symbol] = price;
        if (!prev) continue;
        const delta = Math.abs(price - prev) / prev;
        if (delta >= CEX_SPIKE_THRESH) {
          const dir = price > prev ? '📈' : '📉';
          console.log(`  ${dir} CEX: ${t.symbol} ${(delta*100).toFixed(2)}% spike`);
          cexTriggers++;
          debounceScan();
        }
      }
    } catch(_){}
  }
  const cexTimer = setInterval(pollCEX, KEX_POLL_MS);
  pollCEX();
  console.log(`  📈 Binance CEX monitor started (${cexPairs.join(', ')})\n`);

  // ── Main scan loop ──────────────────────────────────────────────────────────
  let lastScan = 0;
  console.log('  🔁 Main loop started — scanning every 40s, force trade every 5min\n');

  while (Date.now() < endMs) {
    const elapsed = ((Date.now() - startMs) / 60_000).toFixed(1);
    const remaining = ((endMs - Date.now()) / 60_000).toFixed(1);

    // Refresh token list every 10 min
    if (Date.now() - lastTokenRefresh > TOKEN_REFRESH_MS) {
      console.log(`  [${elapsed}m] 🔄 Refreshing token list...`);
      try { tokens = await discoverTokens(); lastTokenRefresh = Date.now(); } catch(_){}
    }

    // Scan cadence: 40s baseline or WS-debounced
    const shouldScan = (Date.now() - lastScan > SCAN_INTERVAL_MS) || scanQueued;
    if (shouldScan) {
      scanQueued = false;
      lastScan   = Date.now();
      scanCount++;
      console.log(`  [${elapsed}m] 📊 Scan #${scanCount} | keys: ${keyCallCount.map((c,i)=>`k${i+1}:${c}`).join(' ')} | ${remaining}m left`);
      process.stdout.write('     Spreads: ');

      let ranked = [];
      try { ranked = await scanBest(tokens.slice(0, MAX_SCAN_TOKENS)); }
      catch(e) { console.log(`  ⚠️  Scan err: ${e.message.slice(0,60)}`); }

      // Execute if positive spread OR forced every 5 min (pipeline verification)
      const forceTrade = Date.now() - lastForcedTrade > FORCE_TRADE_MS;
      const best = ranked[0];

      if (best && (best.gross > 0 || forceTrade)) {
        const trigger = best.gross > 0 ? `arb(+${best.gross.toFixed(4)})` : 'forced-verify';
        lastForcedTrade = Date.now();
        try {
          const result = await executeRoundTrip(best.token, trigger);
          trades.push(result);
          console.log(`  [${elapsed}m] Total trades: ${trades.length} | Running P&L: ${trades.reduce((a,t)=>a+(t.trueNet||0),0)>=0?'+':''}${trades.reduce((a,t)=>a+(t.trueNet||0),0).toFixed(6)} SOL`);
        } catch(e) {
          console.log(`  ❌ Trade failed: ${e.message.slice(0,100)}`);
        }
      } else if (ranked.length > 0) {
        console.log(`  [${elapsed}m] Best: ${best.token.symbol} ${best.gross.toFixed(5)} SOL — below threshold, skip (next force in ${((FORCE_TRADE_MS-(Date.now()-lastForcedTrade))/60_000).toFixed(1)}m)`);
      }
    }
    await new Promise(r => setTimeout(r, 2_000));
  }

  // ── Final Report ────────────────────────────────────────────────────────────
  clearInterval(cexTimer);
  ws.terminate();
  await new Promise(r => setTimeout(r, 3000));

  const balEnd   = await conn.getBalance(wallet.publicKey).catch(() => balStart);
  const totalPnL = (balEnd - balStart) / 1e9;
  const profitTrades = trades.filter(t => (t.trueNet||0) > 0).length;

  console.log('\n' + '═'.repeat(68));
  console.log('  📋 30-MINUTE TEST COMPLETE');
  console.log('═'.repeat(68));
  console.log(`  Duration:     30 minutes`);
  console.log(`  Scans run:    ${scanCount}`);
  console.log(`  WS events:    ${wsEvents}`);
  console.log(`  CEX triggers: ${cexTriggers}`);
  console.log(`  Trades exec:  ${trades.length} (${profitTrades} profit)`);
  console.log(`  API calls:    ${keyCallCount.map((c,i)=>`k${i+1}:${c}`).join(', ')}`);
  console.log('─'.repeat(68));
  console.log(`  Balance:      ${(balStart/1e9).toFixed(6)} → ${(balEnd/1e9).toFixed(6)} SOL`);
  console.log(`  True P&L:     ${totalPnL>=0?'+':''}${totalPnL.toFixed(6)} SOL`);
  console.log('─'.repeat(68));
  console.log('  Trades:');
  trades.forEach((t, i) => {
    const net = t.trueNet !== null ? `net:${t.trueNet>=0?'+':''}${(t.trueNet||0).toFixed(6)}` : '';
    console.log(`  [${i+1}] ${t.ts} ${t.symbol}(${t.src}) ${t.trigger} gross:${t.gross>=0?'+':''}${t.gross.toFixed(5)} ${net}`);
    console.log(`       LEG1: https://solscan.io/tx/${t.sig1}`);
    console.log(`       LEG2: https://solscan.io/tx/${t.sig2}`);
  });
  console.log('═'.repeat(68));

  // Save trade log
  const logPath = './aggressive_test_30m_trades.json';
  fs.writeFileSync(logPath, JSON.stringify({ startTime: new Date(startMs).toISOString(), endTime: new Date().toISOString(),
    totalPnL, scans: scanCount, trades }, null, 2));
  console.log(`\n  📁 Trade log saved → ${logPath}`);
  process.exit(0);
}

main().catch(e => { console.error('\n❌ FATAL:', e.message); process.exit(1); });
