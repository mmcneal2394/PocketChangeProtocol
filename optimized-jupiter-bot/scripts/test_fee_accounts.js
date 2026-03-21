/**
 * Test each referral token account individually to see which one the
 * Jupiter program accepts for SOL->USDC and USDC->SOL swaps.
 */
'use strict';
require('dotenv').config();
const nodeFetch = require('node-fetch');
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const fs = require('fs');

const HELIUS_RPC = process.env.RPC_ENDPOINT;
const JUP_KEY   = process.env.JUPITER_API_KEY;
const JUP_BASE  = 'https://api.jup.ag/swap/v1';
const wSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FEE_BPS = 20;
const JUP_H = { 'Content-Type': 'application/json', 'x-api-key': JUP_KEY };
const ACCT_A = 'TxW2V7LxCr9HtPW1cCn1gAwmgpP4eKCci9tJVw2rGDQ';
const ACCT_B = 'Dw9FKR5dj2bCoPsp8q7A6KpMmZeN4Rfq4oqsPE4tYdbE';

const wallet = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync('./real_wallet.json'))));
const conn   = new Connection(HELIUS_RPC, 'confirmed');

async function trySwap(inM, outM, amt, feeAcct, label) {
  // Quote with fee
  const qr = await nodeFetch(`${JUP_BASE}/quote?inputMint=${inM}&outputMint=${outM}&amount=${amt}&slippageBps=100&platformFeeBps=${FEE_BPS}`, { headers: JUP_H });
  const q  = await qr.json();
  if (!q.outAmount) { console.log(`  ${label}: quote fail`); return; }

  // Swap
  const sr = await nodeFetch(`${JUP_BASE}/swap`, { method: 'POST', headers: JUP_H,
    body: JSON.stringify({ quoteResponse: q, userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true, feeAccount: feeAcct, computeUnitPriceMicroLamports: 150000, dynamicComputeUnitLimit: true }) });
  const sj = await sr.json();
  if (!sj.swapTransaction) { console.log(`  ${label}: swap fail — ${JSON.stringify(sj).slice(0,80)}`); return; }

  // Send (use simulation only — skipPreflight:false to detect error without spending SOL)
  const buf = Buffer.from(sj.swapTransaction, 'base64');
  const tx  = VersionedTransaction.deserialize(buf);
  tx.sign([wallet]);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false });
  const err = sim.value?.err;
  if (err) {
    console.log(`  ❌ ${label}: SIM FAIL — ${JSON.stringify(err)}`);
  } else {
    console.log(`  ✅ ${label}: SIMULATION PASSED — this is the correct feeAccount!`);
    console.log(`     feeAccount: ${feeAcct}`);
  }
}

async function main() {
  console.log('\nTesting SOL→USDC with feeAccount = A');
  await trySwap(wSOL, USDC, 20000000, ACCT_A, 'SOL→USDC + A');
  console.log('\nTesting SOL→USDC with feeAccount = B');
  await trySwap(wSOL, USDC, 20000000, ACCT_B, 'SOL→USDC + B');
  console.log('\nTesting USDC→wSOL with feeAccount = A');
  await trySwap(USDC, wSOL, 1800000, ACCT_A, 'USDC→wSOL + A');
  console.log('\nTesting USDC→wSOL with feeAccount = B');
  await trySwap(USDC, wSOL, 1800000, ACCT_B, 'USDC→wSOL + B');
}
main().catch(e => console.error('FATAL:', e.message));
