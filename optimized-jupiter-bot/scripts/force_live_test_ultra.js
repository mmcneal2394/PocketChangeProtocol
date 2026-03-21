/**
 * Force Live Test v2 — Jupiter Ultra API + Full Verification
 * ===========================================================
 * Uses /ultra/v1/order (single call) instead of /swap/v1/quote
 * This endpoint has a separate higher rate-limit pool.
 *
 * Steps:
 *  1. Fetch Jupiter Ultra order for SOL -> Token -> SOL round-trip
 *  2. Sign both transactions
 *  3. Preflight simulate Leg 1 via RPC
 *  4. Submit to Jupiter /ultra/v1/execute (handles propagation + Jito)
 *  5. Poll for confirmation & print balance delta
 *
 * Usage: node scripts/force_live_test_ultra.js [SYMBOL]
 */

require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, Transaction } = require('@solana/web3.js');
const fs = require('fs');
const fetch = require('node-fetch');
const bs58 = require('bs58');

const RPC    = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const WALLET = process.env.WALLET_KEYPAIR_PATH || './real_wallet.json';
const KEY    = process.env.JUPITER_API_KEY || '';
const BASE   = 'https://lite-api.jup.ag';

const connection = new Connection(RPC, { commitment: 'confirmed' });
const walletRaw  = JSON.parse(fs.readFileSync(WALLET, 'utf-8'));
const wallet     = Keypair.fromSecretKey(new Uint8Array(walletRaw));

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const TARGETS  = {
  USDC:  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT:  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  RAY:   '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  BONK:  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  WIF:   'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  ORCA:  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
};

const EXCLUDE = encodeURIComponent('GoonFi V2,AlphaQ,SolFi V2,BisonFi,HumidiFi,Sanctum,Sanctum Infinity,VaultLiquidUnstake,eversol-stake-pool,socean-stake-pool,Marinade,Lido,SolBlaze');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, label, maxTries = 6, delay = 12000) {
  for (let i = 1; i <= maxTries; i++) {
    try {
      const res = await fn();
      if (res && (res.ok !== false)) return res;
      throw new Error(`Non-ok response`);
    } catch(e) {
      if (i === maxTries) throw e;
      console.log(`   ⏳ [${label}] attempt ${i}/${maxTries} failed (${e.message.slice(0,60)}), retrying in ${delay/1000}s...`);
      await sleep(delay);
    }
  }
}

async function fetchJupiter(path, opts = {}) {
  const url = `${BASE}${path}`;
  const res = await fetch(url, { ...opts, headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, ...(opts.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function checkOnChain(sig) {
  try {
    const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
    return tx;
  } catch(e) { return null; }
}

async function main() {
  const symbol = (process.argv[2] || 'USDC').toUpperCase();
  const mint   = TARGETS[symbol];
  if (!mint) { console.error('Unknown token:', symbol); process.exit(1); }

  const balanceBefore = await connection.getBalance(wallet.publicKey);
  const tradeLamports = Math.min(Math.floor(balanceBefore * 0.1), 100_000_000); // 10% max 0.1 SOL

  console.log('\n' + '='.repeat(62));
  console.log('  🚀 FORCE LIVE TEST v2  —  Jupiter Ultra + Jito Verification');
  console.log('='.repeat(62));
  console.log(`  Wallet:     ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance:    ${(balanceBefore/1e9).toFixed(6)} SOL`);
  console.log(`  Trade size: ${(tradeLamports/1e9).toFixed(4)} SOL`);
  console.log(`  Token:      ${symbol} (${mint})`);

  // ── Step 1: Recent tx history (proof of wallet activity) ────────
  console.log('\n  📋 CONFIRMED WALLET TRANSACTIONS (last 8):');
  const recent = await connection.getSignaturesForAddress(wallet.publicKey, { limit: 8 });
  if (recent.length === 0) {
    console.log('     No transactions found');
  } else {
    recent.forEach(s => {
      const ts  = s.blockTime ? new Date(s.blockTime*1000).toISOString().replace('T',' ').slice(0,19) : '?';
      const ok  = s.err ? '❌' : '✅';
      console.log(`     ${ok} [${ts}] https://solscan.io/tx/${s.signature.slice(0,24)}...`);
    });
  }

  // ── Step 2: Leg 1 Ultra Order ───────────────────────────────────
  console.log('\n  📡 Step 2: Fetching LEG 1 Ultra Order (SOL → ' + symbol + ')...');
  const leg1 = await withRetry(() => fetchJupiter(
    `/ultra/v1/order?inputMint=${SOL_MINT}&outputMint=${mint}&amount=${tradeLamports}&slippageBps=5&taker=${wallet.publicKey.toBase58()}&excludeDexes=${EXCLUDE}`,
    {}
  ), 'Leg1 Order');

  if (leg1.error) throw new Error('Leg 1 order error: ' + JSON.stringify(leg1));
  console.log(`     ✅ Got order. Output: ${leg1.outAmount} raw units`);

  // ── Step 3: Sign leg 1 ─────────────────────────────────────────
  console.log('\n  ✍️  Step 3: Signing Leg 1 transaction...');
  const leg1TxBuf = Buffer.from(leg1.transaction, 'base64');
  let leg1Tx;
  try {
    leg1Tx = VersionedTransaction.deserialize(leg1TxBuf);
    leg1Tx.sign([wallet]);
  } catch(_) {
    const legacyTx = Transaction.from(leg1TxBuf);
    legacyTx.sign(wallet);
    leg1Tx = legacyTx;
  }
  console.log(`     ✅ Leg 1 signed`);

  // ── Step 4: Preflight Leg 1 ────────────────────────────────────
  console.log('\n  🩺 Step 4: PREFLIGHT SIMULATION (Leg 1)...');
  let preflight = '❓ SKIPPED';
  try {
    const sim = await connection.simulateTransaction(leg1Tx, { sigVerify: true, commitment: 'processed' });
    preflight = sim.value.err ? `❌ FAILED: ${JSON.stringify(sim.value.err)}` : `✅ PASSED (${(sim.value.unitsConsumed||0).toLocaleString()} CU)`;
    console.log(`     ${preflight}`);
    if (sim.value.err) {
      const errLogs = (sim.value.logs||[]).filter(l => l.includes('failed') || l.includes('error'));
      errLogs.forEach(l => console.log(`        ⚠  ${l}`));
    }
  } catch(e) {
    preflight = `⚠️  ${e.message}`;
    console.log('     Simulation error:', e.message);
  }

  // ── Step 5: Execute Leg 1 via Jupiter Ultra ─────────────────────
  console.log('\n  🚀 Step 5: Executing Leg 1 via Jupiter Ultra /execute...');
  const leg1SignedB64 = Buffer.from(
    leg1Tx.serialize ? leg1Tx.serialize() : leg1Tx.serialize()
  ).toString('base64');

  const execStart = Date.now();
  const execRes = await withRetry(() => fetchJupiter('/ultra/v1/execute', {
    method: 'POST',
    body: JSON.stringify({ signedTransaction: leg1SignedB64, requestId: leg1.requestId })
  }), 'Execute Leg1');
  const execMs = Date.now() - execStart;

  console.log(`     Response time: ${execMs}ms`);
  console.log(`     Status: ${execRes.status}`);

  const txSigLeg1 = execRes.signature;
  if (txSigLeg1) {
    console.log(`     ✅ TX Signature: https://solscan.io/tx/${txSigLeg1}`);
  }

  if (execRes.status !== 'Success') {
    console.log(`     ❌ Execution failed: ${JSON.stringify(execRes)}`);
  } else {
    console.log(`     ✅ LEG 1 CONFIRMED ON-CHAIN!`);
    console.log(`     Error: ${execRes.error || 'NONE'}`);
  }

  // ── Step 6: Balance delta ──────────────────────────────────────
  console.log('\n  ⏳ Step 6: Checking balance delta...');
  await sleep(4000);
  const balanceAfter = await connection.getBalance(wallet.publicKey);
  const delta = balanceAfter - balanceBefore;

  console.log('\n' + '='.repeat(62));
  console.log('  📊 FINAL RESULTS');
  console.log('─'.repeat(62));
  console.log(`  Balance Before:   ${(balanceBefore/1e9).toFixed(6)} SOL`);
  console.log(`  Balance After:    ${(balanceAfter/1e9).toFixed(6)} SOL`);
  console.log(`  Delta:            ${delta >= 0 ? '+' : ''}${(delta/1e9).toFixed(8)} SOL`);
  console.log(`  Preflight:        ${preflight}`);
  console.log(`  On-chain Status:  ${execRes.status || 'UNKNOWN'}`);
  if (txSigLeg1) console.log(`  Solscan TX:       https://solscan.io/tx/${txSigLeg1}`);
  console.log('='.repeat(62) + '\n');
}

main().catch(e => { console.error('\n  ❌ FATAL:', e.message); process.exit(1); });
