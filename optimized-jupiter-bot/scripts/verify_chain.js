/**
 * Chain Verifier — checks a tx signature and current wallet state
 */
require('dotenv').config();
const { Connection, PublicKey } = require('@solana/web3.js');
const fs = require('fs');
const fetch = require('node-fetch');
const bs58 = require('bs58');

const RPC = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC, { commitment: 'confirmed' });

// ─── Wallet from config ────────────────────────────────────────────
const walletPath = process.env.WALLET_KEYPAIR_PATH;
const walletRaw = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
const { Keypair } = require('@solana/web3.js');
const wallet = Keypair.fromSecretKey(new Uint8Array(walletRaw));

// ─── Known TX sigs from this session ──────────────────────────────
const SIGS_TO_CHECK = [
  '2wLzPTTu7snmHZjUe8Fw7NnFuAZMotTD8BiXRgo9KZ9Z7tW13BnyzEfRNJKHB7W5KLJFoiHWg7UmZ39oBBh3cQSF', // force live test
  '3FML55FkJmoc2fK3DgPct6G581BPivJiSDygK7ZRUpV4Rf5TE6pUAJG1uP1uE4c7FYrQ8a3jURvfSyV6FXL5BoiV', // first diagnostic test
];

async function main() {
  console.log('\n========================================');
  console.log('  🔍 ON-CHAIN VERIFICATION REPORT');
  console.log('========================================');
  console.log(`  RPC:    ${RPC}`);
  console.log(`  Wallet: ${wallet.publicKey.toBase58()}`);

  // ─── Current balance ───────────────────────────────────────────
  const balance = await connection.getBalance(wallet.publicKey);
  console.log(`\n  💳 Current Balance: ${(balance / 1e9).toFixed(6)} SOL (${balance.toLocaleString()} lamports)`);

  // ─── Recent transactions from wallet ──────────────────────────
  console.log(`\n  📋 Last 5 transactions from this wallet:`);
  try {
    const sigs = await connection.getSignaturesForAddress(wallet.publicKey, { limit: 5 });
    if (sigs.length === 0) {
      console.log('     ⚠️  No transactions found for this wallet on the confirmed commitment.');
    } else {
      for (const s of sigs) {
        const status = s.err ? '❌ FAILED' : '✅ SUCCESS';
        const ts = s.blockTime ? new Date(s.blockTime * 1000).toISOString() : 'unknown time';
        console.log(`     ${status}  ${ts}  https://solscan.io/tx/${s.signature}`);
      }
    }
  } catch (e) {
    console.log('     Error fetching signatures:', e.message);
  }

  // ─── Check specific sigs ───────────────────────────────────────
  console.log(`\n  🔎 Checking specific session transactions:`);
  for (const sig of SIGS_TO_CHECK) {
    try {
      const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
      if (!tx) {
        console.log(`\n     SIG: ${sig.slice(0, 30)}...`);
        console.log(`     STATUS: ❌ NOT FOUND — Was NOT included in any block`);
        console.log(`     → Jito accepted the bundle format but the validator did not include it (tip too low or stale blockhash)`);
      } else {
        const delta = tx.meta.postBalances[0] - tx.meta.preBalances[0];
        console.log(`\n     SIG: ${sig.slice(0, 30)}...`);
        console.log(`     STATUS: ✅ CONFIRMED on slot ${tx.slot}`);
        console.log(`     Error: ${tx.meta.err ? JSON.stringify(tx.meta.err) : 'NONE'}`);
        console.log(`     Fee: ${tx.meta.fee.toLocaleString()} lamports`);
        console.log(`     Wallet delta: ${delta >= 0 ? '+' : ''}${(delta / 1e9).toFixed(8)} SOL`);
        console.log(`     Solscan: https://solscan.io/tx/${sig}`);
      }
    } catch (e) {
      console.log(`     ERROR checking ${sig.slice(0, 20)}...: ${e.message}`);
    }
  }

  // ─── PM2 env var issue check ────────────────────────────────────
  console.log(`\n  ⚙️  ENV VAR STATUS CHECK:`);
  const envVars = ['RPC_ENDPOINT', 'WALLET_KEYPAIR_PATH', 'MIN_PROFIT_SOL', 'MAX_TRADE_SIZE_SOL', 'TRADE_PERCENTAGE', 'POLL_INTERVAL_MS', 'SLIPPAGE_BPS', 'JUPITER_API_KEY'];
  for (const v of envVars) {
    const val = process.env[v];
    console.log(`     ${v}: ${val ? ('✅ ' + (v.includes('KEY') || v.includes('PATH') ? '[set]' : val)) : '❌ MISSING'}`);
  }

  console.log('\n========================================\n');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
