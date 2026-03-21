/**
 * PLATFORM FEE DEPOSIT VERIFICATION — Fixed base64 tx decode
 */
'use strict';
require('dotenv').config();
const nodeFetch = require('node-fetch');
const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const fs = require('fs');

const HELIUS_RPC = process.env.RPC_ENDPOINT;
const CHAIN_RPC  = 'https://rpc.YOUR_CHAINSTACK_ENDPOINT';
const JUP_KEY    = process.env.JUPITER_API_KEY;
const JUP_BASE   = 'https://api.jup.ag/swap/v1';
const wSOL       = 'So11111111111111111111111111111111111111112';
const USDC       = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FEE_BPS    = parseInt(process.env.PLATFORM_FEE_BPS || '20');
const FEE_WSOL   = process.env.PLATFORM_FEE_ACCOUNT_WSOL;
const FEE_USDC   = process.env.PLATFORM_FEE_ACCOUNT_USDC;
const TRADE_LAM  = 20_000_000;
const JUP_H      = { 'Content-Type': 'application/json', 'x-api-key': JUP_KEY };

const wallet  = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync('./real_wallet.json'))));
const conn    = new Connection(HELIUS_RPC, 'confirmed');
const connC   = new Connection(CHAIN_RPC,  'confirmed');

async function getTokenBal(ata) {
  try { return Number((await conn.getTokenAccountBalance(new PublicKey(ata))).value.amount); }
  catch(_) { return 0; }
}

async function jupQuote(inM, outM, amt, feesBps) {
  let url = `${JUP_BASE}/quote?inputMint=${inM}&outputMint=${outM}&amount=${amt}&slippageBps=100`;
  if (feesBps) url += `&platformFeeBps=${feesBps}`;
  const r = await nodeFetch(url, { headers: JUP_H });
  const j = await r.json();
  if (!j.outAmount) throw new Error('quote fail: ' + JSON.stringify(j).slice(0,80));
  return j;
}

async function jupSwap(q, feeAcct) {
  const body = { quoteResponse: q, userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
 computeUnitPriceMicroLamports: 200000, dynamicComputeUnitLimit: true };
  if (feeAcct) body.feeAccount = feeAcct;
  const r  = await nodeFetch(`${JUP_BASE}/swap`, { method: 'POST', headers: JUP_H, body: JSON.stringify(body) });
  const sj = await r.json();
  if (!sj.swapTransaction) throw new Error('swap fail: ' + JSON.stringify(sj).slice(0,100));
  return sj.swapTransaction; // base64
}

async function sendAndConfirm(txStr, label) {
  // Jupiter returns base64
  const buf = Buffer.from(txStr, 'base64');
  const tx  = VersionedTransaction.deserialize(buf);
  tx.sign([wallet]);
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 3 });
  console.log(`  🔗 ${label}: https://solscan.io/tx/${sig}`);
  const deadline = Date.now() + 90_000;
  let lastResend = Date.now();
  while (Date.now() < deadline) {
    const [h,c] = await Promise.allSettled([
      conn.getSignatureStatus(sig, { searchTransactionHistory: true }),
      connC.getSignatureStatus(sig, { searchTransactionHistory: true }),
    ]);
    for (const res of [h,c]) {
      if (res.status !== 'fulfilled') continue;
      const st = res.value?.value;
      if (st?.err) throw new Error(`${label} err: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') {
        console.log(`  ✅ ${label} confirmed`); return sig;
      }
    }
    if (Date.now() - lastResend > 20_000) {
      conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      lastResend = Date.now();
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`${label} timeout`);
}

async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log('  🧪 PLATFORM FEE DEPOSIT VERIFICATION');
  console.log('═'.repeat(60));
  console.log(`  Wallet:    ${wallet.publicKey.toBase58()}`);
  console.log(`  wSOL ATA:  ${FEE_WSOL}`);
  console.log(`  USDC ATA:  ${FEE_USDC}`);
  console.log(`  Fee rate:  ${FEE_BPS} bps (${FEE_BPS/100}%)`);
  console.log(`  Trade:     ${TRADE_LAM/1e9} SOL`);
  console.log('═'.repeat(60) + '\n');

  const walletBefore = await conn.getBalance(wallet.publicKey);
  const wsolBefore   = await getTokenBal(FEE_WSOL);
  const usdcBefore   = await getTokenBal(FEE_USDC);
  console.log(`  Wallet before:   ${(walletBefore/1e9).toFixed(6)} SOL`);
  console.log(`  wSOL ATA before: ${wsolBefore} lam`);
  console.log(`  USDC ATA before: ${usdcBefore} μUSDC\n`);

  // LEG1: SOL → USDC with platform fee (fee lands in USDC ATA)
  console.log('  [LEG1] SOL → USDC with fee...');
  const q1   = await jupQuote(wSOL, USDC, TRADE_LAM, FEE_BPS);
  console.log(`    platForm fee in quote: ${JSON.stringify(q1.platformFee)}`);
  const tx1  = await jupSwap(q1, FEE_USDC);
  const sig1 = await sendAndConfirm(tx1, 'LEG1');

  // LEG2: USDC → wSOL with platform fee (fee lands in wSOL ATA)
  console.log('\n  [LEG2] USDC → wSOL with fee...');
  const q2   = await jupQuote(USDC, wSOL, Number(q1.outAmount), FEE_BPS);
  console.log(`    platForm fee in quote: ${JSON.stringify(q2.platformFee)}`);
  const tx2  = await jupSwap(q2, FEE_WSOL);
  const sig2 = await sendAndConfirm(tx2, 'LEG2');

  await new Promise(r => setTimeout(r, 3000));
  const walletAfter = await conn.getBalance(wallet.publicKey);
  const wsolAfter   = await getTokenBal(FEE_WSOL);
  const usdcAfter   = await getTokenBal(FEE_USDC);

  console.log('\n' + '═'.repeat(60));
  console.log('  📋 RESULT');
  console.log('═'.repeat(60));
  console.log(`  Wallet delta:    ${(walletAfter-walletBefore)>=0?'+':''}${((walletAfter-walletBefore)/1e9).toFixed(6)} SOL`);
  console.log(`  wSOL ATA delta:  ${wsolAfter-wsolBefore>=0?'+':''}${wsolAfter-wsolBefore} lam (+${((wsolAfter-wsolBefore)/1e9).toFixed(6)} wSOL)`);
  console.log(`  USDC ATA delta:  ${usdcAfter-usdcBefore>=0?'+':''}${usdcAfter-usdcBefore} μUSDC`);

  if (wsolAfter > wsolBefore || usdcAfter > usdcBefore) {
    console.log('\n  ✅ FEE DEPOSITS CONFIRMED!');
    console.log(`     wSOL ATA: https://solscan.io/account/${FEE_WSOL}`);
    console.log(`     USDC ATA: https://solscan.io/account/${FEE_USDC}`);
  } else {
    console.log('\n  ⚠️  No ATA balance change detected — check Solscan manually');
    console.log(`     LEG2 may route fee differently. Check tx on Solscan.`);
  }
  console.log(`  LEG1: https://solscan.io/tx/${sig1}`);
  console.log(`  LEG2: https://solscan.io/tx/${sig2}`);
  console.log('═'.repeat(60) + '\n');
}
main().catch(e => { console.error('\n❌', e.message); process.exit(1); });
