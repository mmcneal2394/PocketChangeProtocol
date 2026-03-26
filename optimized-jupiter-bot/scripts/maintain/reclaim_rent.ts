/**
 * reclaim_rent.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Closes all zero-balance token accounts owned by the wallet.
 * Each closed ATA returns ~0.00203928 SOL in rent.
 *
 * Run once to reclaim free SOL, then occasionally after active trading
 * (each swap on a new token creates an ATA that can be closed after selling).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createCloseAccountInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import fs   from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const RPC         = process.env.RPC_ENDPOINT!;
const WALLET_PATH = process.env.WALLET_KEYPAIR_PATH!;

const connection = new Connection(RPC, { commitment: 'confirmed' });
const walletJson = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'));
const wallet     = Keypair.fromSecretKey(new Uint8Array(walletJson));

const BATCH_SIZE = 8; // close 8 accounts per tx (compute budget safe)

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  PCP RENT RECLAIMER                      ║');
  console.log(`║  Wallet: ${wallet.publicKey.toBase58().slice(0,20)}…      ║`);
  console.log('╚══════════════════════════════════════════╝');

  // Fetch all token accounts
  console.log('\n[RENT] Scanning for closeable token accounts...');
  const accounts = await connection.getParsedTokenAccountsByOwner(
    wallet.publicKey,
    { programId: TOKEN_PROGRAM_ID }
  );

  // Only close zero-balance accounts
  const closeable = accounts.value.filter(a => {
    const amount = Number(a.account.data.parsed.info.tokenAmount.amount);
    return amount === 0;
  });

  const rentPerAccount = 0.00203928; // SOL
  const totalRecoverable = closeable.length * rentPerAccount;

  console.log(`[RENT] Found ${accounts.value.length} token accounts`);
  console.log(`[RENT] ${closeable.length} zero-balance (closeable) — ${totalRecoverable.toFixed(5)} SOL recoverable`);

  if (closeable.length === 0) {
    console.log('[RENT] Nothing to close. Run after trading to reclaim rent.');
    process.exit(0);
  }

  // Close in batches
  let totalClosed = 0;
  let totalSol    = 0;
  const batches   = [];
  for (let i = 0; i < closeable.length; i += BATCH_SIZE) {
    batches.push(closeable.slice(i, i + BATCH_SIZE));
  }

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const tx    = new Transaction();

    for (const account of batch) {
      tx.add(
        createCloseAccountInstruction(
          new PublicKey(account.pubkey),
          wallet.publicKey, // destination: return SOL to wallet
          wallet.publicKey, // owner
        )
      );
    }

    try {
      console.log(`[RENT] Batch ${b + 1}/${batches.length} — closing ${batch.length} accounts...`);
      const sig = await sendAndConfirmTransaction(connection, tx, [wallet], {
        commitment: 'confirmed',
        skipPreflight: true,
      });
      totalClosed += batch.length;
      totalSol    += batch.length * rentPerAccount;
      console.log(`[RENT] ✅ Batch ${b + 1} confirmed: ${sig.slice(0,16)}…`);
      console.log(`[RENT] 🔗 https://solscan.io/tx/${sig}`);
    } catch (e: any) {
      console.error(`[RENT] ❌ Batch ${b + 1} failed: ${e.message}`);
    }

    // Small delay between batches
    if (b < batches.length - 1) await new Promise(r => setTimeout(r, 1500));
  }

  // Final report
  const balanceAfter = await connection.getBalance(wallet.publicKey);
  console.log(`\n[RENT] ═══════════════════════════════════`);
  console.log(`[RENT] Closed:   ${totalClosed} accounts`);
  console.log(`[RENT] Recovered: ~${totalSol.toFixed(5)} SOL ($${(totalSol * 91).toFixed(3)})`);
  console.log(`[RENT] Balance now: ${(balanceAfter / 1e9).toFixed(5)} SOL`);
  console.log(`[RENT] ═══════════════════════════════════`);
}

main().catch(e => { console.error('[RENT] Fatal:', e); process.exit(1); });
