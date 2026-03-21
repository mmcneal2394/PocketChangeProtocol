/**
 * FORCE TEST v2: SOL → USDC → SOL round trip
 * Uses exact same signing pattern as the working arb_jup_ultra.js
 */
'use strict';
require('dotenv').config();

const nodeFetch  = require('node-fetch');
const { Connection, Keypair, VersionedTransaction, Transaction } = require('@solana/web3.js');
const fs         = require('fs');

const HELIUS_RPC = process.env.RPC_ENDPOINT || 'https://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY';
const CHAIN_RPC  = 'https://rpc.YOUR_CHAINSTACK_ENDPOINT';
const JUP_KEY    = process.env.JUPITER_API_KEY || 'YOUR_JUPITER_API_KEY';
const JUP_BASE   = 'https://api.jup.ag/swap/v1';
const JUP_H      = { 'Content-Type': 'application/json', 'x-api-key': JUP_KEY };
const SOL_MINT   = 'So11111111111111111111111111111111111111112';
const USDC_MINT  = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// 0.03 SOL per leg — enough to verify, well under 1%
const TRADE_SOL    = 30_000_000;  // 0.03 SOL in lamports
const CU_PRICE     = 300_000;
const CONFIRM_MS   = 90_000;

const conn      = new Connection(HELIUS_RPC, { commitment: 'confirmed' });
const connChain = new Connection(CHAIN_RPC,  { commitment: 'confirmed' });

function loadWallet() {
  const p = process.env.WALLET_KEYPAIR_PATH || './real_wallet.json';
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p))));
}
const wallet = loadWallet();
function log(m) { console.log(`[${new Date().toISOString().slice(11,19)}] ${m}`); }

// ── Quote ──────────────────────────────────────────────────────────────────────
async function quote(inMint, outMint, amount) {
  const url = `${JUP_BASE}/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&swapMode=ExactIn&dynamicSlippage=true`;
  const r = await nodeFetch(url, { headers: JUP_H });
  const j = await r.json();
  if (!j.outAmount) throw new Error(`Quote failed: ${JSON.stringify(j).slice(0,120)}`);
  return j;
}

// ── Swap (exact arb_jup_ultra pattern) ────────────────────────────────────────
async function swap(quoteResponse, label) {
  const body = {
    quoteResponse,
    userPublicKey:                wallet.publicKey.toBase58(),
    wrapAndUnwrapSol:             true,
    computeUnitPriceMicroLamports: CU_PRICE,
    dynamicComputeUnitLimit:      true,
    dynamicSlippage:              { maxBps: 300 },
  };
  const r = await nodeFetch(`${JUP_BASE}/swap`, { method: 'POST', headers: JUP_H, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`swap HTTP ${r.status}: ${(await r.text()).slice(0,80)}`);
  const j = await r.json();
  if (!j.swapTransaction) throw new Error(`No swapTx: ${JSON.stringify(j).slice(0,80)}`);

  const buf = Buffer.from(j.swapTransaction, 'base64');
  let tx;
  try { tx = VersionedTransaction.deserialize(buf); } catch(_) { tx = Transaction.from(buf); }
  tx.sign([wallet]);
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
  log(`📤 ${label} → https://solscan.io/tx/${sig}`);

  // Resend loop + dual-RPC confirm (same as arb_jup_ultra)
  const deadline = Date.now() + CONFIRM_MS;
  const resendIv = setInterval(async () => {
    if (Date.now() > deadline) return;
    try { await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }); } catch(_) {}
  }, 5_000);

  try {
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const [h, c] = await Promise.allSettled([
        conn.getSignatureStatus(sig,      { searchTransactionHistory: true }),
        connChain.getSignatureStatus(sig, { searchTransactionHistory: true }),
      ]);
      for (const res of [h, c]) {
        if (res.status !== 'fulfilled') continue;
        const st = res.value?.value;
        if (!st) continue;
        if (st.err) throw new Error(`${label} on-chain err: ${JSON.stringify(st.err)}`);
        if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
          clearInterval(resendIv);
          log(`✅ ${label} CONFIRMED → https://solscan.io/tx/${sig}`);
          return { sig, outAmount: parseInt(quoteResponse.outAmount) };
        }
      }
    }
    throw new Error(`${label} timed out after ${CONFIRM_MS/1000}s`);
  } catch(e) {
    clearInterval(resendIv);
    throw e;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  log('══════════════════════════════════════════');
  log('  CEX/DEX ARB FORCE TEST v2 — ROUND TRIP');
  log(`  Wallet:  ${wallet.publicKey.toString()}`);
  log(`  Trade:   ${(TRADE_SOL/1e9).toFixed(3)} SOL → USDC → SOL`);
  log('══════════════════════════════════════════');

  // LEG 1: SOL → USDC
  log('\n--- LEG 1: SOL → USDC ---');
  const q1 = await quote(SOL_MINT, USDC_MINT, TRADE_SOL);
  log(`Quote: ${(TRADE_SOL/1e9).toFixed(3)} SOL → ${(q1.outAmount/1e6).toFixed(4)} USDC (impact: ${q1.priceImpactPct}%)`);
  const leg1 = await swap(q1, 'LEG1 SOL→USDC');

  log('\n⏸  3s pause...');
  await new Promise(r => setTimeout(r, 3000));

  // LEG 2: USDC → SOL
  log('\n--- LEG 2: USDC → SOL ---');
  const q2 = await quote(USDC_MINT, SOL_MINT, leg1.outAmount);
  log(`Quote: ${(leg1.outAmount/1e6).toFixed(4)} USDC → ${(q2.outAmount/1e9).toFixed(5)} SOL (impact: ${q2.priceImpactPct}%)`);
  const leg2 = await swap(q2, 'LEG2 USDC→SOL');

  // Result
  const pnlSol = (leg2.outAmount - TRADE_SOL) / 1e9;
  log('\n══════════════════════════════════════════');
  log('  ROUND TRIP COMPLETE ✅');
  log(`  In:  ${(TRADE_SOL/1e9).toFixed(3)} SOL`);
  log(`  Out: ${(leg2.outAmount/1e9).toFixed(5)} SOL`);
  log(`  PnL: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(6)} SOL (fees+slippage cost)`);
  log(`  Both legs confirmed on-chain ✅`);
  log('══════════════════════════════════════════');
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
