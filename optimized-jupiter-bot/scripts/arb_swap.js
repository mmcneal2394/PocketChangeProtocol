/**
 * ARB ENGINE — Bags Long-Tail Token Scanner
 * ==========================================
 * Targets Bags-native tokens (DBC launches) where spreads can reach 2-10%+
 * due to low liquidity and high volatility — necessary to overcome Bags' 100bps fee.
 *
 * Token discovery:
 *   1. Bags /token-launch/top-tokens/lifetime-fees  (top Bags tokens by volume)
 *   2. DexScreener /latest/dex/pairs/solana (filter Meteora DBC pairs < 24h old)
 *
 * Rate budget (dual keys):
 *   2 keys × 1000/hr = 2000/hr. Token pool refresh: 12 calls (all tokens).
 *   Scan: N tokens × 2 legs. Rotates keys → stays within limits.
 *
 * Break-even math:
 *   Bags fee: 100bps = 1% per swap. Round trip: 2%. Gas: ~0.00002 SOL.
 *   At 0.05 SOL: fee = 0.001 SOL per leg × 2 = 0.002 SOL total.
 *   Need GROSS spread > 0.002 SOL. Long-tail tokens regularly have 2-20% slippage.
 *
 * Usage:  node scripts/arb_swap.js
 * PM2:    pm2 start scripts/arb_swap.js --name arb-swap
 */

'use strict';
require('dotenv').config();

const nodeFetch  = require('node-fetch');
const WebSocket  = require('ws');
const bs58       = require('bs58');
const { Connection, Keypair, VersionedTransaction, Transaction } = require('@solana/web3.js');
const fs = require('fs');

// ── Config ─────────────────────────────────────────────────────────────────────
const HELIUS_RPC = process.env.RPC_ENDPOINT  || 'https://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY';
const CHAIN_RPC  = 'https://rpc.YOUR_CHAINSTACK_ENDPOINT';
const HELIUS_WS  = (process.env.RPC_WEBSOCKET || 'wss://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY').replace(/\/$/, '');
const CHAIN_WS   = 'wss://solana-mainnet.core.chainstack.com/YOUR_CHAINSTACK_KEY';
const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH || './real_wallet.json';

// ── Bags API Key Pool (6 keys → 6000 req/hr combined) ──────────────────────────
const BAGS_KEY_POOL = [
  process.env.BAGS_API_KEY   || 'bags_prod_bhNWKWR4_HAseNYlrmgpJX4NklFdCzAbDdYpx9UIIgg',
  process.env.BAGS_API_KEY_2 || 'bags_prod_kfsnkMqQ4NJW16_BknWl1ox31Ysr1kZL1MA2mGSlt5c',
  process.env.BAGS_API_KEY_3 || 'bags_prod_QJ3a_QsV3R8FEg9kbxWZ7yMOqVD7OnAu2mxLHNfkia8',
  process.env.BAGS_API_KEY_4 || 'bags_prod_a64DNgP7fs2O9DcqT0JIIva4Qsy_XEPmdgLtP67jbSU',
  process.env.BAGS_API_KEY_5 || 'bags_prod_pIHo6k8F6k7W_5q0N4kVCzodVgPqMBQ_tj0G0S2Mn9o',
  process.env.BAGS_API_KEY_6 || 'bags_prod_b5Aeygaqa1vb5JGdwm5hsRoBCyVKMBCK12p-DCIodlU',
];
const BAGS_API = 'https://public-api-v2.bags.fm/api/v1';

// Jupiter swap fallback (if Bags swap fails)
const JUP_KEY = process.env.JUPITER_API_KEY || '';
const JUP_API = 'https://lite-api.jup.ag/swap/v1';

const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ── Rate / Trade Parameters ────────────────────────────────────────────────────
// Bags fee: 100bps per swap. At 0.05 SOL: 0.0005 SOL/leg × 2 = 0.001 SOL total fee.
// Need gross > 0.001 SOL + gas (~0.00002). Set bar at 0.0015 SOL (50% buffer).
const TRADE_SOL      = 0.05;               // 0.05 SOL per leg
const TRADE_LAM      = Math.floor(TRADE_SOL * 1e9);
const MIN_PROFIT_LAM = 150_000;            // 0.00015 SOL minimum gross after fee
const SLIP_BPS       = 50;                 // 0.5% slippage (more forgiving for volatile tokens)
const CU_PRICE       = 50_000;             // 50k microLam/CU priority

// ── Rate-limit-safe timing ──────────────────────────────────────────────────
// Bags API: 1000 req/hr per key × 6 keys = 6000/hr combined
// KEY_GAP_MS = 3600ms/key. 6 keys rotating: effective 1 call / 600ms
// 25 tokens × 2 legs = 50 calls × 600ms = 30s/scan → BASELINE 40s
const KEY_GAP_MS     = 3_600;              // ms between reuse of SAME key (= 1000/hr)
const BASELINE_MS    = 40_000;            // 40s baseline (30s scan + 10s buffer)
const WS_DEBOUNCE_MS = 15_000;            // debounce WS scan triggers
const COOLDOWN_MS    = 60_000;            // per-token cooldown between trades
const LOG_INTERVAL   = 60_000;            // stats every 60s
const TOKEN_REFRESH  = 10 * 60_000;       // token list refresh every 10 min
// Helius WS: 20s ping | DexScreener: 4 calls/10min | Binance CEX: 1 batch/10s


// ── DEX Programs ───────────────────────────────────────────────────────────────
const DEX_PROGRAMS = [
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora DLMM
  'LanMV9sAd7wArD4vJFi3xDEWhMFoN7D2j1CRGK3RBJG',  // Meteora DBC (Bags launches)
];

// ── Infrastructure ─────────────────────────────────────────────────────────────
const conn      = new Connection(HELIUS_RPC, { commitment: 'confirmed' });
const connChain = new Connection(CHAIN_RPC,  { commitment: 'confirmed' });
const connPub   = new Connection('https://api.mainnet-beta.solana.com', { commitment: 'confirmed' });
const raw    = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
const wallet = Keypair.fromSecretKey(new Uint8Array(raw));

async function getBalanceSafe() {
  for (const c of [connChain, conn, connPub]) {
    try { return await c.getBalance(wallet.publicKey); } catch(_) {}
  }
  throw new Error('All RPCs failed for getBalance');
}

// ── State ─────────────────────────────────────────────────────────────────────
let scanCount = 0, execCount = 0, profitCount = 0, totalPnl = 0, wsEvents = 0;
let lastScan = 0, scanning = false;
const lastTradeAt = {};
const bestSeen = {};
let hotTokens = [];           // dynamically refreshed
let lastTokenRefresh = 0;

// ── Dual-key rotation ─────────────────────────────────────────────────────────
const keyLastCall  = BAGS_KEY_POOL.map(() => 0);
const keyCallCount = BAGS_KEY_POOL.map(() => 0);

async function nextKey() {
  let best = 0, bestAvail = Infinity;
  for (let i = 0; i < BAGS_KEY_POOL.length; i++) {
    const avail = keyLastCall[i] + KEY_GAP_MS;
    if (avail < bestAvail) { bestAvail = avail; best = i; }
  }
  const wait = bestAvail - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  keyLastCall[best] = Date.now();
  keyCallCount[best]++;
  return { key: BAGS_KEY_POOL[best], idx: best };
}

// ── Token Discovery — Multi-Platform (4 sources) ─────────────────────────────

// Source 1: Bags /token-launch/top-tokens/lifetime-fees
async function fetchBagsTopTokens() {
  try {
    const { key } = await nextKey();
    const r = await nodeFetch(`${BAGS_API}/token-launch/top-tokens/lifetime-fees`,
      { headers: { 'x-api-key': key } });
    if (!r.ok) return [];
    const j = await r.json();
    if (!j.success || !Array.isArray(j.response)) return [];
    return j.response.slice(0, 10).map(t => ({
      symbol: t.tokenInfo?.symbol || t.token.slice(0,6),
      mint:   t.token,
      src:    'bags',
    }));
  } catch(_) { return []; }
}

// Source 2: pump.fun tokens graduated to Raydium/PumpSwap (via DexScreener)
// High h1 volume + shallow liquidity = widest intra-block spreads
async function fetchPumpFunGraduated() {
  try {
    const r = await nodeFetch(
      'https://api.dexscreener.com/latest/dex/search?q=pump',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!r.ok) return [];
    const j = await r.json();
    return (j.pairs || [])
      .filter(p =>
        p.chainId === 'solana' &&
        (p.dexId === 'pumpswap' || p.dexId === 'raydium') &&
        p.quoteToken?.address === SOL_MINT &&
        (p.volume?.h1 || 0) > 5_000 &&
        (p.liquidity?.usd || 0) > 1_000 &&
        (p.liquidity?.usd || 0) < 500_000
      )
      .sort((a, b) => (b.volume?.h1 || 0) - (a.volume?.h1 || 0))
      .slice(0, 8)
      .map(p => ({
        symbol: p.baseToken.symbol,
        mint:   p.baseToken.address,
        src:    'pumpfun',
      }));
  } catch(_) { return []; }
}

// Source 3: DexScreener top-boosted Solana tokens
// Paid promotions signal real money and volume behind the token
async function fetchDexScreenerBoosted() {
  try {
    const r = await nodeFetch('https://api.dexscreener.com/token-boosts/top/v1',
      { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return [];
    const j = await r.json();
    return (Array.isArray(j) ? j : [])
      .filter(t => t.chainId === 'solana' && t.tokenAddress)
      .slice(0, 6)
      .map(t => ({
        symbol: t.tokenAddress.slice(0, 5) + '...',
        mint:   t.tokenAddress,
        src:    'boosted',
      }));
  } catch(_) { return []; }
}

// Source 4: Meteora DBC new pairs < 6h (Bags platform launches)
async function fetchMeteoraNewPairs() {
  try {
    const r = await nodeFetch(
      'https://api.dexscreener.com/latest/dex/search?q=solana%20meteora%20dbc',
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!r.ok) return [];
    const j = await r.json();
    return (j.pairs || [])
      .filter(p => {
        const ageH = (Date.now() - (p.pairCreatedAt || 0)) / 3_600_000;
        return ageH < 6 && p.quoteToken?.address === SOL_MINT &&
               (p.volume?.h24 || 0) > 1_000 && (p.liquidity?.usd || 0) > 500;
      })
      .slice(0, 6)
      .map(p => ({
        symbol: p.baseToken.symbol,
        mint:   p.baseToken.address,
        src:    'meteora',
      }));
  } catch(_) { return []; }
}

// Fallback stable seeds (always included)
const STABLE_SEEDS = [
  { symbol: 'USDC',   mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', src: 'stable' },
  { symbol: 'BONK',   mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', src: 'stable' },
  { symbol: 'WIF',    mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', src: 'stable' },
  { symbol: 'POPCAT', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', src: 'stable' },
];

async function refreshTokenList() {
  try {
    // Fetch all sources in parallel (DexScreener sources are free/unauthenticated)
    const [bags, pump, boosted, meteora] = await Promise.all([
      fetchBagsTopTokens(),
      fetchPumpFunGraduated(),
      fetchDexScreenerBoosted(),
      fetchMeteoraNewPairs(),
    ]);
    const seen = new Set([SOL_MINT]);
    const merged = [];
    // Priority: pump.fun graduated (most volatile) → boosted → meteora → bags → stables
    for (const src of [pump, boosted, meteora, bags, STABLE_SEEDS]) {
      for (const t of src) {
        if (t.mint && !seen.has(t.mint)) { seen.add(t.mint); merged.push(t); }
      }
    }
    hotTokens = merged.slice(0, 25); // max 25 tokens
    lastTokenRefresh = Date.now();
    const bySrc = {};
    hotTokens.forEach(t => { bySrc[t.src] = (bySrc[t.src]||0)+1; });
    console.log(`  🔄 Tokens: ${hotTokens.length} | ${Object.entries(bySrc).map(([k,v])=>`${k}:${v}`).join(' ')}`);
    console.log(`     [${hotTokens.map(t=>t.symbol).join(', ')}]`);
  } catch(e) {
    console.log(`  ⚠️  Token refresh failed: ${e.message.slice(0,60)}`);
    if (!hotTokens.length) hotTokens = STABLE_SEEDS;
  }
}

// ── Bags Quote Fetcher ─────────────────────────────────────────────────────────
async function bagsQuote(inputMint, outputMint, amount) {
  const { key, idx } = await nextKey();
  const url = `${BAGS_API}/trade/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageMode=auto&slippageBps=${SLIP_BPS}`;
  let r;
  try { r = await nodeFetch(url, { headers: { 'x-api-key': key } }); }
  catch(e) { throw new Error(`Bags quote: ${e.message.slice(0,50)}`); }
  if (r.status === 429) {
    keyLastCall[idx] = Date.now() + 60_000;
    throw new Error(`key[${idx}] 429`);
  }
  if (!r.ok) throw new Error(`Bags quote HTTP ${r.status}`);
  const j = await r.json();
  if (!j.success || !j.response) throw new Error(`Bags: ${JSON.stringify(j).slice(0,60)}`);
  return j.response; // { outAmount, priceImpactPct, platformFee, ... }
}

// ── Bags Swap Builder — takes pre-fetched quoteObj that includes requestId ─────
// Bags /trade/swap requires { quoteResponse: <full quote object>, userPublicKey, ... }
async function bagsSwap(quoteObj) {
  const { key } = await nextKey();
  try {
    const r = await nodeFetch(`${BAGS_API}/trade/swap`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quoteObj,         // REQUIRED: full quote response incl. requestId
        userPublicKey: wallet.publicKey.toBase58(),
        computeUnitPriceMicroLamports: CU_PRICE,
        wrapAndUnwrapSol: false,
      }),
    });
    if (!r.ok) throw new Error(`Bags swap HTTP ${r.status}: ${await r.text().then(t=>t.slice(0,100))}`);
    const d = await r.json();
    const swapTx = d.response?.swapTransaction || d.swapTransaction;
    if (!swapTx) throw new Error(`no tx: ${JSON.stringify(d).slice(0,100)}`);
    const buf = Buffer.from(bs58.decode(swapTx));
    let tx; try { tx = VersionedTransaction.deserialize(buf); } catch(_) { tx = Transaction.from(buf); }
    return tx;
  } catch(e) {
    console.log(`  ⚠️  Bags swap failed: ${e.message.slice(0,70)} — Jupiter fallback...`);
    // Jupiter fallback
    const qr = await nodeFetch(`${JUP_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIP_BPS}`,
      { headers: JUP_KEY ? { 'x-api-key': JUP_KEY } : {} });
    if (!qr.ok) throw new Error(`Jupiter quote: HTTP ${qr.status}`);
    const q  = await qr.json();
    const sr = await nodeFetch(`${JUP_API}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(JUP_KEY ? { 'x-api-key': JUP_KEY } : {}) },
      body: JSON.stringify({ quoteResponse: q, userPublicKey: wallet.publicKey.toBase58(), wrapAndUnwrapSol: false, computeUnitPriceMicroLamports: CU_PRICE }),
    });
    const sd = await sr.json();
    if (!sd.swapTransaction) throw new Error(`Jupiter fallback: no tx`);
    const buf2 = Buffer.from(sd.swapTransaction, 'base64');
    let tx2; try { tx2 = VersionedTransaction.deserialize(buf2); } catch(_) { tx2 = Transaction.from(buf2); }
    return tx2;
  }
}

async function buildAndSend(quoteObj) {
  const tx = await bagsSwap(quoteObj);
  tx.sign([wallet]);
  return conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
}

// ── Scan Token for Arb ────────────────────────────────────────────────────────
async function scanToken(symbol, mint) {
  if (lastTradeAt[symbol] && Date.now() - lastTradeAt[symbol] < COOLDOWN_MS) return null;
  try {
    const q1 = await bagsQuote(SOL_MINT, mint, TRADE_LAM);
    if (!q1?.outAmount) return null;
    const out1 = Number(q1.outAmount);
    if (!out1) return null;

    const q2 = await bagsQuote(mint, SOL_MINT, out1);
    if (!q2?.outAmount) return null;
    const out2 = Number(q2.outAmount);

    const grossLam = out2 - TRADE_LAM;
    const grossSol = grossLam / 1e9;
    const priceImpact1 = Math.abs(Number(q1.priceImpactPct || 0));
    const priceImpact2 = Math.abs(Number(q2.priceImpactPct || 0));

    if (grossSol > (bestSeen[symbol] || -999)) bestSeen[symbol] = grossSol;
    return { symbol, mint, out1, out2, grossLam, grossSol, priceImpact1, priceImpact2 };
  } catch(e) {
    if (!e.message.includes('429')) console.log(`  ⚠️  ${symbol}: ${e.message.slice(0,55)}`);
    return null;
  }
}

// ── Execute Arb ───────────────────────────────────────────────────────────────
async function executeArb(opp) {
  const balBefore = await getBalanceSafe();

  // Re-quote LEG1 fresh immediately before executing
  const q1r = await bagsQuote(SOL_MINT, opp.mint, TRADE_LAM);
  if (!q1r?.outAmount) throw new Error('LEG1 re-quote failed');
  const out1 = Number(q1r.outAmount);

  const sig1 = await buildAndSend(SOL_MINT, opp.mint, TRADE_LAM);
  console.log(`  🔗 LEG1: https://solscan.io/tx/${sig1}`);
  await conn.confirmTransaction(sig1, 'confirmed');
  console.log(`  ✅ LEG1 confirmed — got ${(out1/1e9).toFixed(6)} ${opp.symbol}`);

  const sig2 = await buildAndSend(opp.mint, SOL_MINT, out1);
  console.log(`  🔗 LEG2: https://solscan.io/tx/${sig2}`);
  await conn.confirmTransaction(sig2, 'confirmed');
  console.log(`  ✅ LEG2 confirmed`);
  await new Promise(r => setTimeout(r, 2000));

  const balAfter = await getBalanceSafe();
  const trueNet  = (balAfter - balBefore) / 1e9;
  return { sig1, sig2, balBefore, balAfter, trueNet };
}

// ── Core Scan Loop ─────────────────────────────────────────────────────────────
async function runScan(trigger = 'baseline') {
  if (scanning) return;
  scanning = true;
  lastScan = Date.now();
  scanCount++;
  try {
    // Refresh token list periodically
    if (Date.now() - lastTokenRefresh > TOKEN_REFRESH) await refreshTokenList();
    if (!hotTokens.length) return;

    // Sequential scan to respect key gap
    const results = [];
    for (const { symbol, mint } of hotTokens) {
      results.push(await scanToken(symbol, mint));
    }

    const viable = results
      .filter(r => r !== null && r.grossLam >= MIN_PROFIT_LAM)
      .sort((a, b) => b.grossLam - a.grossLam);

    if (!viable.length) return;
    const best = viable[0];
    const ts = new Date().toISOString().slice(11,19);
    console.log(`\n  [${ts}] 🎯 ${trigger} | ${best.symbol}  gross:+${best.grossSol.toFixed(6)} SOL  pi:${best.priceImpact1.toFixed(2)}%/${best.priceImpact2.toFixed(2)}%`);
    lastTradeAt[best.symbol] = Date.now();
    execCount++;

    try {
      const t0  = Date.now();
      const res = await executeArb(best);
      const ms  = Date.now() - t0;
      totalPnl += res.trueNet;
      if (res.trueNet > 0) profitCount++;
      const icon = res.trueNet > 0 ? '✅ PROFIT' : res.trueNet === 0 ? '⚠️  FLAT' : '📉 LOSS';
      console.log(`  ${icon}  ${(res.balBefore/1e9).toFixed(6)} → ${(res.balAfter/1e9).toFixed(6)} SOL  net:${res.trueNet>=0?'+':''}${res.trueNet.toFixed(6)}  (${ms}ms)`);
      console.log(`  Cumulative P&L: ${totalPnl>=0?'+':''}${totalPnl.toFixed(6)} SOL\n`);
      const entry = { ts: new Date().toISOString(), symbol: best.symbol, trigger,
                      grossSol: best.grossSol, trueNet: res.trueNet, sig1: res.sig1, sig2: res.sig2 };
      const logPath = './arb_swap_trades.json';
      const all = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath,'utf-8')) : [];
      all.push(entry);
      fs.writeFileSync(logPath, JSON.stringify(all, null, 2));
    } catch(e) {
      execCount--;
      console.log(`  ❌ executeArb: ${e.message.slice(0,120)}`);
    }
  } finally {
    scanning = false;
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
const wsDebounce = {};
function triggerWScan(key) {
  wsEvents++;
  clearTimeout(wsDebounce[key]);
  wsDebounce[key] = setTimeout(() => runScan('ws:' + key.slice(0,6)), WS_DEBOUNCE_MS);
}

function connectWebSocket(wsUrl) {
  if (!wsUrl) wsUrl = HELIUS_WS;
  const ws = new WebSocket(wsUrl);
  ws.on('open', () => {
    const src = wsUrl.includes('helius') ? 'Helius' : 'Chainstack';
    console.log(`  🔌 WS connected (${src})`);
    DEX_PROGRAMS.forEach((prog, i) => {
      ws.send(JSON.stringify({ jsonrpc:'2.0', id: i+1, method:'logsSubscribe',
        params: [{ mentions: [prog] }, { commitment: 'processed' }] }));
    });
    console.log(`  📡 Subscribed to ${DEX_PROGRAMS.length} DEX programs (incl Meteora DBC)`);
  });
  ws.on('message', (d) => {
    try {
      const msg = JSON.parse(d.toString());
      if (msg.method === 'logsNotification') {
        const logs = msg.params?.result?.value?.logs || [];
        const isSwap = logs.some(l => l.includes('swap') || l.includes('ray_log') ||
          l.includes('Instruction: Swap') || l.includes('Swap successful'));
        if (isSwap) triggerWScan(String(msg.params?.subscription || 'g'));
      }
    } catch(_) {}
  });
  ws.on('error', () => {});
  ws.on('close', (code) => {
    const next = (code === 4401 || code === 1002) && wsUrl === HELIUS_WS ? CHAIN_WS : wsUrl;
    setTimeout(() => connectWebSocket(next), 5000);
  });
  setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 20000);
}

// ── CEX Price Monitor (Binance REST — free, no auth, 1200 req/min) ────────────
// Polls Binance spot prices every 10s for SOL, BONK, WIF, POPCAT.
// When price changes ≥0.3% since last snapshot → triggers immediate scan.
// Binance limit: 1200 req/min weight. This uses weight=4 (4 symbols) every 10s = 24/min. ✅
const CEX_TOKENS = [
  { symbol: 'SOL',    pair: 'SOLUSDT',    mint: SOL_MINT },
  { symbol: 'BONK',   pair: 'BONKUSDT',   mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { symbol: 'WIF',    pair: 'WIFUSDT',    mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  { symbol: 'POPCAT', pair: 'POPCATUSDT', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
];
const CEX_POLL_MS      = 10_000; // 10s between polls (24 req/min for 4 symbols)
const CEX_DIVERGE_THRESH = 0.003; // 0.3% move triggers scan
const cexLastPrice = {};
let cexConnected = false;
let cexEvents = 0;

async function pollCEXPrices() {
  try {
    // Binance batch ticker — single request for all symbols
    const pairs   = CEX_TOKENS.map(t => `"${t.pair}"`).join(',');
    const r = await nodeFetch(
      `https://api.binance.com/api/v3/ticker/price?symbols=[${pairs}]`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    if (!r.ok) { cexConnected = false; return; }
    cexConnected = true;
    const tickers = await r.json(); // [{ symbol, price }, ...]
    for (const t of tickers) {
      const price  = parseFloat(t.price);
      const mapped = CEX_TOKENS.find(c => c.pair === t.symbol);
      if (!mapped) continue;
      const prev  = cexLastPrice[t.symbol];
      cexLastPrice[t.symbol] = price;
      if (!prev) continue; // first tick — no baseline yet
      const delta = Math.abs(price - prev) / prev;
      cexEvents++;
      if (delta >= CEX_DIVERGE_THRESH) {
        const dir = price > prev ? '📈' : '📉';
        console.log(`  ${dir} CEX spike: ${mapped.symbol} ${(delta*100).toFixed(2)}% ($${prev.toFixed(4)}→$${price.toFixed(4)}) → scan`);
        wsEvents++;
        if (!scanning) runScan(`cex:${mapped.symbol}`).catch(() => {});
      }
    }
  } catch(e) {
    cexConnected = false;
  }
}

function connectCEXMonitor() {
  console.log(`  📈 CEX monitor: Binance REST polling SOL/BONK/WIF/POPCAT every ${CEX_POLL_MS/1000}s`);
  pollCEXPrices(); // initial poll
  setInterval(pollCEXPrices, CEX_POLL_MS);
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function printStats() {
  const ts   = new Date().toISOString().slice(11,19);
  const top5 = hotTokens.slice(0,5).map(t =>
    `${t.symbol}:${bestSeen[t.symbol]!==undefined?(bestSeen[t.symbol]>=0?'+':'')+bestSeen[t.symbol].toFixed(4):'?'}`).join(' ');
  const calls = BAGS_KEY_POOL.map((k,i) => `k${i+1}:${keyCallCount[i]}`).join(' ');
  const cexSt  = cexConnected ? `📈 cex:${cexEvents}` : '📈 cex:off';
  console.log(`\n  📊 [${ts}] Scans:${scanCount} | WS:${wsEvents} | Trades:${execCount}(${profitCount}✅) | P&L:${totalPnl>=0?'+':''}${totalPnl.toFixed(5)}`);
  console.log(`       Best: ${top5}`);
  console.log(`       API:  ${calls} | ${cexSt} | tokens:${hotTokens.length}`);
  hotTokens.forEach(t => { bestSeen[t.symbol] = undefined; });
}

// ── Baseline Loop ─────────────────────────────────────────────────────────────

async function baselineLoop() {
  while (true) {
    await new Promise(r => setTimeout(r, BASELINE_MS));
    if (!scanning && Date.now() - lastScan > BASELINE_MS - 2000) await runScan('baseline');
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  const bal = (await getBalanceSafe()) / 1e9;

  console.log('\n' + '═'.repeat(72));
  console.log('  ⚡ ARB ENGINE — Bags Long-Tail Scanner');
  console.log('═'.repeat(72));
  console.log(`  Wallet:      ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance:     ${bal.toFixed(6)} SOL`);
  console.log(`  Trade size:  ${TRADE_SOL} SOL per leg`);
  console.log(`  Bags fee:    100bps/swap × 2 legs`);
  console.log(`  Min gross:   +${(MIN_PROFIT_LAM/1e9).toFixed(6)} SOL`);
  console.log(`  Keys:        ${BAGS_KEY_POOL.length} (round-robin)`);
  console.log(`  Token src:   Bags + pump.fun (DexScreener) + CEX boosted (4 sources)`);
  console.log(`  Triggers:    DEX WebSocket (5 programs) + CoinAPI CEX spikes (0.3%)`);
  console.log(`  Scan rate:   ${BASELINE_MS/1000}s baseline | ${WS_DEBOUNCE_MS/1000}s WS debounce | CEX: instant`);
  console.log('═'.repeat(72) + '\n');

  console.log('  📡 Fetching initial token universe...');
  await refreshTokenList();
  connectWebSocket();
  connectCEXMonitor();
  setInterval(printStats, LOG_INTERVAL);
  baselineLoop().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}

main().catch(e => { console.error('\n❌ FATAL:', e.message); process.exit(1); });
