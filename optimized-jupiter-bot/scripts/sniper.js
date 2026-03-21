/**
 * PUMP.FUN TOKEN SNIPER
 * ═══════════════════════════════════════════════════════════════════
 *  Monitors DexScreener for new pump.fun / pumpswap tokens < 45 min
 *  Entry criteria:
 *   - Token age: 5–45 minutes (past rug risk window, momentum forming)
 *   - h1 volume > $8,000 (real trading activity)
 *   - Liquidity $2,000–$400,000 (tradeable but not whaled out)
 *   - Price change h1 > +5% (momentum confirmed)
 *   - Not seen before (first detection = entry signal)
 *  Exit:
 *   - Take profit: +15% from entry
 *   - Stop loss:   -8% from entry
 *   - Timeout:     20 minutes max hold
 *  Execution: Jupiter paid tier both sides
 * ═══════════════════════════════════════════════════════════════════
 */
'use strict';
require('dotenv').config();
const nodeFetch = require('node-fetch');
const bs58      = require('bs58');
const { Connection, Keypair, VersionedTransaction, Transaction } = require('@solana/web3.js');
const fs = require('fs');

const HELIUS_RPC = process.env.RPC_ENDPOINT || 'https://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY';
const CHAIN_RPC  = 'https://rpc.YOUR_CHAINSTACK_ENDPOINT';
const JUP_KEY    = process.env.JUPITER_API_KEY || 'YOUR_JUPITER_API_KEY';
const JUP_BASE   = 'https://api.jup.ag/swap/v1';
const wSOL       = 'So11111111111111111111111111111111111111112';
const LOG_FILE   = './sniper_trades.json';

// Platform fee
const PLATFORM_FEE_BPS = parseInt(process.env.PLATFORM_FEE_BPS || '20');
const FEE_ACCT_WSOL    = process.env.PLATFORM_FEE_ACCOUNT_WSOL || '';

// ── Sniper config ─────────────────────────────────────────────────────────────
const SNIPE_LAM      = 30_000_000;   // 0.03 SOL per snipe (conservative)
const TAKE_PROFIT    = 0.15;         // +15% exit
const STOP_LOSS      = -0.08;        // -8% exit
const MAX_HOLD_MS    = 20 * 60_000;  // 20 min max hold
const SCAN_MS        = 30_000;       // poll DexScreener every 30s
const MIN_AGE_MIN    = 5;            // min 5 min old (past initial dump)
const MAX_AGE_MIN    = 45;           // max 45 min (still early)
const MIN_VOL_H1     = 8_000;        // $8k h1 volume
const MIN_LIQ        = 2_000;        // $2k min liquidity
const MAX_LIQ        = 400_000;      // $400k max (not too established)
const MIN_PRICE_CHG  = 5;            // h1 price change > +5%
const CU_PRICE       = 200_000;      // aggressive priority for snipes
const CONFIRM_MS     = 60_000;       // 60s confirm window
const SLIP_BPS       = 200;          // 2% slippage on volatile tokens

const wallet    = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(process.env.WALLET_KEYPAIR_PATH||'./real_wallet.json','utf-8'))));
const conn      = new Connection(HELIUS_RPC, { commitment: 'confirmed' });
const connChain = new Connection(CHAIN_RPC,   { commitment: 'confirmed' });
const JUP_H     = { 'Content-Type':'application/json', 'x-api-key': JUP_KEY };

const seenTokens = new Set();   // dedupe — only snipe each token once
const openPos    = new Map();   // tokenMint → { entryPrice, entryLam, entryTime, sig }
let sniped = 0, wins = 0, losses = 0, totalPnL = 0;

// ── Jupiter helpers ───────────────────────────────────────────────────────────
async function jupQuote(inMint, outMint, amount) {
  const r = await nodeFetch(
    `${JUP_BASE}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${SLIP_BPS}&restrictIntermediateTokens=true`,
    { headers: JUP_H }
  );
  if (!r.ok) throw new Error(`jup quote ${r.status}`);
  const j = await r.json();
  if (!j.outAmount) throw new Error('jup no out');
  return j;
}

async function jupSwapTx(quoteResponse) {
  const body = { quoteResponse, userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true, computeUnitPriceMicroLamports: CU_PRICE, dynamicComputeUnitLimit: true };
  if (FEE_ACCT_WSOL && PLATFORM_FEE_BPS > 0) { body.platformFeeBps = PLATFORM_FEE_BPS; body.feeAccount = FEE_ACCT_WSOL; }
  const r = await nodeFetch(`${JUP_BASE}/swap`, { method:'POST', headers: JUP_H, body: JSON.stringify(body) });
  const j = await r.json();
  if (!j.swapTransaction) throw new Error(`jup swap no tx: ${JSON.stringify(j).slice(0,80)}`);
  return j.swapTransaction;
}

async function sendAndConfirm(txStr, label) {
  const buf = Buffer.from(txStr, 'base64');
  let tx; try { tx = VersionedTransaction.deserialize(buf); } catch(_) { tx = Transaction.from(buf); }
  tx.sign([wallet]);
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
  console.log(`     🔗 ${label}: https://solscan.io/tx/${sig}`);
  const deadline = Date.now() + CONFIRM_MS;
  let lastResend = Date.now();
  while (Date.now() < deadline) {
    const [h,c] = await Promise.allSettled([
      conn.getSignatureStatus(sig,{searchTransactionHistory:true}),
      connChain.getSignatureStatus(sig,{searchTransactionHistory:true}),
    ]);
    for (const res of [h,c]) {
      if (res.status!=='fulfilled') continue;
      const st=res.value?.value;
      if (st?.err) throw new Error(`${label} err: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus==='confirmed'||st?.confirmationStatus==='finalized') { console.log(`     ✅ ${label}`); return sig; }
    }
    if (Date.now()-lastResend>15_000) { conn.sendRawTransaction(raw,{skipPreflight:true,maxRetries:0}).catch(()=>{}); lastResend=Date.now(); }
    await new Promise(r=>setTimeout(r,2_000));
  }
  throw new Error(`${label} timeout — ${sig}`);
}

// ── Snipe a token ─────────────────────────────────────────────────────────────
async function snipe(token) {
  const ts = new Date().toISOString().slice(11,19);
  console.log(`\n  [${ts}] 🎯 SNIPING ${token.symbol} (${token.src})`);
  console.log(`     Price: $${token.priceUsd?.toFixed(6)} | Vol h1: $${(token.volH1||0).toLocaleString()} | Liq: $${(token.liqUsd||0).toLocaleString()}`);
  console.log(`     Age: ${token.ageMin}min | h1 chg: +${token.priceChgH1?.toFixed(1)}%`);

  const q = await jupQuote(wSOL, token.mint, SNIPE_LAM);
  const tokenReceived = Number(q.outAmount);
  const pricePerToken = SNIPE_LAM / tokenReceived; // lamports per token unit

  const tx = await jupSwapTx(q);
  const sig = await sendAndConfirm(tx, 'SNIPE-BUY');

  sniped++;
  openPos.set(token.mint, {
    symbol: token.symbol, pricePerToken, tokenReceived: BigInt(tokenReceived),
    entryTime: Date.now(), sig, snipeLam: SNIPE_LAM,
  });
  console.log(`     📦 Holding ${tokenReceived.toLocaleString()} ${token.symbol} | price: ${pricePerToken.toFixed(4)} lam/token`);
  console.log(`     🎯 TP: +${(TAKE_PROFIT*100).toFixed(0)}% | SL: ${(STOP_LOSS*100).toFixed(0)}% | timeout: ${MAX_HOLD_MS/60000}min`);
}

// ── Monitor open positions ────────────────────────────────────────────────────
async function checkPositions() {
  for (const [mint, pos] of openPos) {
    try {
      const q = await jupQuote(mint, wSOL, Number(pos.tokenReceived));
      const currentOut = Number(q.outAmount);
      const pnlPct = (currentOut - pos.snipeLam) / pos.snipeLam;
      const heldMin = ((Date.now() - pos.entryTime) / 60_000).toFixed(1);
      const pnlStr = `${pnlPct>=0?'+':''}${(pnlPct*100).toFixed(2)}%`;

      const shouldTP = pnlPct >= TAKE_PROFIT;
      const shouldSL = pnlPct <= STOP_LOSS;
      const timedOut = Date.now() - pos.entryTime > MAX_HOLD_MS;
      const reason   = shouldTP ? `TP ${pnlStr}` : shouldSL ? `SL ${pnlStr}` : timedOut ? `timeout ${heldMin}min` : null;

      if (reason) {
        console.log(`\n  [${new Date().toISOString().slice(11,19)}] 📤 SELLING ${pos.symbol} — ${reason}`);
        const sellQ  = await jupQuote(mint, wSOL, Number(pos.tokenReceived));
        const sellTx = await jupSwapTx(sellQ);
        const sellSig = await sendAndConfirm(sellTx, 'SNIPE-SELL');
        const netLam = Number(sellQ.outAmount) - pos.snipeLam;
        const netSol = netLam / 1e9;
        const icon  = netLam > 0 ? '✅' : '📉';
        console.log(`  ${icon} ${pos.symbol}: ${netSol>=0?'+':''}${netSol.toFixed(6)} SOL (${pnlStr})`);
        if (netLam > 0) wins++; else losses++;
        totalPnL += netSol;
        openPos.delete(mint);
        try {
          const log = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE,'utf-8')) : [];
          log.push({ ts:new Date().toISOString().slice(11,19), symbol:pos.symbol, reason, pnlPct:(pnlPct*100).toFixed(2), netSol:netSol.toFixed(6), buySig:pos.sig, sellSig });
          fs.writeFileSync(LOG_FILE, JSON.stringify(log,null,2));
        } catch(_){}
        console.log(`  📊 Record: ${sniped} sniped | ${wins}W/${losses}L | net: ${totalPnL>=0?'+':''}${totalPnL.toFixed(5)} SOL`);
      } else {
        process.stdout.write(`  [${pos.symbol}] ${pnlStr} held:${heldMin}min | `);
      }
    } catch(e) { console.log(`  ⚠️  ${pos.symbol} check err: ${e.message.slice(0,60)}`); }
  }
  if (openPos.size > 0) console.log('');
}

// ── Scan for new tokens ───────────────────────────────────────────────────────
async function scanNewTokens() {
  const r = await nodeFetch('https://api.dexscreener.com/latest/dex/search?q=pump', { headers:{'User-Agent':'Mozilla/5.0'} });
  const j = await r.json();
  const now = Date.now();
  const candidates = (j.pairs||[]).filter(p => {
    if (p.chainId !== 'solana') return false;
    if (p.dexId !== 'pumpswap' && p.dexId !== 'raydium') return false;
    if (p.quoteToken?.address !== wSOL) return false;
    const ageMin = (now - (p.pairCreatedAt||0)) / 60_000;
    if (ageMin < MIN_AGE_MIN || ageMin > MAX_AGE_MIN) return false;
    if ((p.volume?.h1||0) < MIN_VOL_H1) return false;
    const liq = p.liquidity?.usd || 0;
    if (liq < MIN_LIQ || liq > MAX_LIQ) return false;
    const chgH1 = parseFloat(p.priceChange?.h1 || '0');
    if (chgH1 < MIN_PRICE_CHG) return false;
    if (seenTokens.has(p.baseToken.address)) return false;
    return true;
  });
  return candidates.sort((a,b) => (b.volume?.h1||0) - (a.volume?.h1||0)).slice(0,3).map(p => ({
    symbol:   p.baseToken.symbol,
    mint:     p.baseToken.address,
    src:      p.dexId,
    priceUsd: parseFloat(p.priceUsd||'0'),
    volH1:    p.volume?.h1||0,
    liqUsd:   p.liquidity?.usd||0,
    priceChgH1: parseFloat(p.priceChange?.h1||'0'),
    ageMin:   ((now - (p.pairCreatedAt||0)) / 60_000).toFixed(1),
  }));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const balStart = await conn.getBalance(wallet.publicKey);
  console.log('\n' + '═'.repeat(68));
  console.log('  🎯 PUMP.FUN SNIPER — Jupiter Paid Tier');
  console.log('═'.repeat(68));
  console.log(`  Wallet:  ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance: ${(balStart/1e9).toFixed(6)} SOL`);
  console.log(`  Snipe:   ${SNIPE_LAM/1e9} SOL per target`);
  console.log(`  Exit:    TP +${TAKE_PROFIT*100}% | SL ${STOP_LOSS*100}% | timeout ${MAX_HOLD_MS/60000}min`);
  console.log(`  Filter:  ${MIN_AGE_MIN}–${MAX_AGE_MIN}min old | vol>$${(MIN_VOL_H1/1000).toFixed(0)}k | liq $${MIN_LIQ/1000}k–${MAX_LIQ/1000}k | h1>+${MIN_PRICE_CHG}%`);
  console.log('═'.repeat(68) + '\n');
  console.log('  👀 Watching for targets...\n');

  while (true) {
    try {
      // Check open positions first
      if (openPos.size > 0) await checkPositions();

      // Scan for new tokens
      const candidates = await scanNewTokens();
      const ts = new Date().toISOString().slice(11,19);
      if (candidates.length === 0) {
        process.stdout.write(`  [${ts}] Scan: no candidates (open:${openPos.size} total:${sniped})\r`);
      } else {
        for (const c of candidates) {
          seenTokens.add(c.mint); // mark seen regardless — only snipe if below max positions
          if (openPos.size >= 3) { console.log(`  [${ts}] ⏸ Max positions (3) open — skipping ${c.symbol}`); continue; }
          console.log(`  [${ts}] 📡 SIGNAL: ${c.symbol} | age:${c.ageMin}min | vol:$${c.volH1.toLocaleString()} | +${c.priceChgH1.toFixed(1)}% h1`);
          await snipe(c);
        }
      }
    } catch(e) { console.log(`\n  ❌ ${e.message.slice(0,100)}`); }
    await new Promise(r => setTimeout(r, SCAN_MS));
  }
}
main().catch(e => { console.error('\n❌ FATAL:', e.message); process.exit(1); });
