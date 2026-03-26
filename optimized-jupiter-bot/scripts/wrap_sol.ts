/**
 * wrap_sol.ts — One-time setup: wrap native SOL into persistent WSOL ATA
 * ─────────────────────────────────────────────────────────────────────────────
 * Run ONCE before first trade to fund the WSOL ATA.
 * After this, the sniper + pumpfun agents trade from WSOL directly.
 *
 * Usage:
 *   npx ts-node scripts/wrap_sol.ts              # wrap all available SOL
 *   npx ts-node scripts/wrap_sol.ts 0.5          # wrap exactly 0.5 SOL
 *   npx ts-node scripts/wrap_sol.ts --dry-run    # preview only
 *
 * The script always retains MIN_NATIVE_SOL_RESERVE (0.02 SOL) unwrapped
 * to cover transaction fees.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import {
  ensureWsolAta, wrapSol, getWsolBalance,
  getTotalSpendableBalance, MIN_NATIVE_SOL_RESERVE,
} from '../src/utils/wsol_manager';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const DRY_RUN    = process.argv.includes('--dry-run');
const amountArg  = process.argv.find(a => /^\d+\.?\d*$/.test(a));
const WRAP_EXACT = amountArg ? parseFloat(amountArg) : null;

async function main() {
  const rpc = process.env.RPC_ENDPOINT!;
  const conn = new Connection(rpc, 'confirmed');

  let wallet: Keypair;
  const kpPath = process.env.WALLET_KEYPAIR_PATH;
  const privKey = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (kpPath && fs.existsSync(kpPath)) {
    wallet = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(kpPath, 'utf-8'))));
  } else if (privKey) {
    const { default: bs58 } = await import('bs58');
    wallet = Keypair.fromSecretKey(bs58.decode(privKey));
  } else {
    throw new Error('Set WALLET_KEYPAIR_PATH or WALLET_PRIVATE_KEY in .env');
  }

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  WSOL Wrap Setup — PCP Sniper Base Currency     ║');
  console.log(`║  Wallet: ${wallet.publicKey.toBase58().slice(0,20)}...       ║`);
  console.log(`║  Mode:   ${DRY_RUN ? 'DRY RUN (no tx)             ' : 'LIVE (will submit tx)       '}║`);
  console.log('╚══════════════════════════════════════════════════╝\n');

  const { wsolSol, nativeSol, totalSol, spendableSol } = await getTotalSpendableBalance(conn, wallet.publicKey);
  console.log(`  💰 Native SOL :  ${nativeSol.toFixed(4)} SOL`);
  console.log(`  🪙 WSOL ATA   :  ${wsolSol.toFixed(4)} WSOL`);
  console.log(`  📊 Total      :  ${totalSol.toFixed(4)} SOL`);
  console.log(`  ✅ Spendable  :  ${spendableSol.toFixed(4)} SOL (keeping ${MIN_NATIVE_SOL_RESERVE} native reserve)\n`);

  const wrapAmt = WRAP_EXACT ?? (nativeSol - MIN_NATIVE_SOL_RESERVE);
  if (wrapAmt <= 0) {
    console.log('  ⚠️  No native SOL available to wrap (already at minimum reserve)');
    process.exit(0);
  }

  console.log(`  📦 Will wrap: ${wrapAmt.toFixed(4)} SOL → WSOL`);

  if (DRY_RUN) {
    console.log('\n  [DRY RUN] No transaction submitted');
    console.log(`  After wrap: WSOL ≈ ${(wsolSol + wrapAmt).toFixed(4)} | Native ≈ ${(nativeSol - wrapAmt).toFixed(4)}`);
    process.exit(0);
  }

  // Create ATA if needed
  await ensureWsolAta(conn, wallet);

  // Wrap
  const sig = await wrapSol(conn, wallet, wrapAmt);
  if (!sig) { console.error('Wrap failed'); process.exit(1); }

  // Show final state
  const { wsolSol: newWsol, nativeSol: newNative } = await getTotalSpendableBalance(conn, wallet.publicKey);
  console.log('\n  ✅ Done!');
  console.log(`  WSOL ATA: ${newWsol.toFixed(4)} WSOL (ready to trade)`);
  console.log(`  Native:   ${newNative.toFixed(4)} SOL (tx fee reserve)`);
  console.log(`\n  🔗 https://solscan.io/tx/${sig}`);
  console.log('\n  ℹ️  From now on:');
  console.log('     • pcp-sniper buys with WSOL (no wrap fee)');
  console.log('     • Sells settle back to WSOL (no unwrap fee)');
  console.log('     • Run wrap_sol.ts again if you add more SOL to wallet');
}

main().catch(e => { console.error(e); process.exit(1); });
