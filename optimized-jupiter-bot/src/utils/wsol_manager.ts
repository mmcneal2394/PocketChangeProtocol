/**
 * wsol_manager.ts — WSOL Persistent ATA Manager
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared utility for all pcp agents. Manages the persistent WSOL token account
 * so trades never pay wrap/unwrap fees on every swap.
 *
 * Design:
 *   - Wallet holds trading capital as WSOL in a persistent ATA
 *   - Always keeps MIN_NATIVE_SOL_RESERVE in native SOL for tx fees
 *   - Agents read getWsolBalance() instead of connection.getBalance()
 *   - executeSwap() calls use wrapAndUnwrapSol: false
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  Connection, Keypair, PublicKey, Transaction,
  SystemProgram, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from '@solana/spl-token';
import { sendAndConfirmTransaction } from '@solana/web3.js';

// ── Constants ──────────────────────────────────────────────────────────────
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const WSOL_PUBKEY = NATIVE_MINT; // alias for clarity

/** Minimum native SOL to always keep unwrapped (for tx fees + rent) */
export const MIN_NATIVE_SOL_RESERVE = 0.02; // 0.02 SOL (~$1.50 buffer)

let _wsolAtaCache: PublicKey | null = null;

/** Get (or derive) the persistent WSOL ATA for a given owner */
export async function getWsolAta(owner: PublicKey): Promise<PublicKey> {
  if (_wsolAtaCache) return _wsolAtaCache;
  _wsolAtaCache = await getAssociatedTokenAddress(
    NATIVE_MINT, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return _wsolAtaCache;
}

/**
 * Ensure the WSOL ATA exists on-chain. Creates it if missing.
 * No-op if already exists. Returns the ATA public key.
 */
export async function ensureWsolAta(
  connection: Connection,
  wallet: Keypair
): Promise<PublicKey> {
  const ata = await getWsolAta(wallet.publicKey);
  const info = await connection.getAccountInfo(ata);
  if (info !== null) {
    console.log(`[WSOL] ✅ WSOL ATA exists: ${ata.toBase58()}`);
    return ata;
  }
  console.log(`[WSOL] 📝 Creating WSOL ATA...`);
  const ix = createAssociatedTokenAccountInstruction(
    wallet.publicKey, ata, wallet.publicKey, NATIVE_MINT,
    TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: 'confirmed' });
  console.log(`[WSOL] ✅ WSOL ATA created: ${sig}`);
  return ata;
}

/**
 * Get current WSOL token balance in lamports.
 * Returns 0 if ATA doesn't exist or has no balance.
 */
export async function getWsolBalanceLamports(
  connection: Connection,
  owner: PublicKey
): Promise<number> {
  try {
    const ata = await getWsolAta(owner);
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('RPC_TIMEOUT')), 2000));
    const info = await Promise.race([
      connection.getTokenAccountBalance(ata),
      timeout
    ]) as any;
    return Number(info.value.amount);
  } catch (e: any) { 
    if (e.message !== 'RPC_TIMEOUT') console.warn(`[WSOL] Balance read error: ${e.message}`);
    return 0; 
  }
}

/**
 * Get current WSOL balance in SOL units.
 */
export async function getWsolBalance(
  connection: Connection,
  owner: PublicKey
): Promise<number> {
  return (await getWsolBalanceLamports(connection, owner)) / LAMPORTS_PER_SOL;
}

/**
 * Get total spendable balance: WSOL + (native SOL - reserve).
 * This is what agents should use for position sizing.
 */
export async function getTotalSpendableBalance(
  connection: Connection,
  owner: PublicKey
): Promise<{ wsolSol: number; nativeSol: number; totalSol: number; spendableSol: number }> {
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('RPC_TIMEOUT')), 2000));
  let wsolLamports = 0;
  let nativeLamports = 0;

  try {
    const results = await Promise.race([
      Promise.all([
        getWsolBalanceLamports(connection, owner),
        connection.getBalance(owner)
      ]),
      timeout
    ]) as [number, number];
    wsolLamports = results[0];
    nativeLamports = results[1];
  } catch (e: any) {
    if (e.message !== 'RPC_TIMEOUT') console.warn(`[WSOL] Spendable read error: ${e.message}`);
    // If it fails, fallback to strict 0 to halt trading rather than blocking the event loop indefinitely
  }
  const wsolSol   = wsolLamports / LAMPORTS_PER_SOL;
  const nativeSol = nativeLamports / LAMPORTS_PER_SOL;
  const totalSol  = wsolSol + nativeSol;
  const spendableSol = wsolSol + Math.max(0, nativeSol - MIN_NATIVE_SOL_RESERVE);
  return { wsolSol, nativeSol, totalSol, spendableSol };
}

/**
 * Wrap native SOL into WSOL.
 * Transfers `amountSol` from native wallet into WSOL ATA, then syncs.
 * Always preserves MIN_NATIVE_SOL_RESERVE as unwrapped native SOL.
 */
export async function wrapSol(
  connection: Connection,
  wallet: Keypair,
  amountSol: number
): Promise<string | null> {
  const ata = await ensureWsolAta(connection, wallet);
  const nativeBalance = await connection.getBalance(wallet.publicKey);
  const maxWrap = (nativeBalance / LAMPORTS_PER_SOL) - MIN_NATIVE_SOL_RESERVE;

  if (amountSol > maxWrap) {
    console.warn(`[WSOL] ⚠️  Can only wrap ${maxWrap.toFixed(4)} SOL (keeping ${MIN_NATIVE_SOL_RESERVE} native reserve)`);
    amountSol = maxWrap;
  }
  if (amountSol <= 0) {
    console.warn('[WSOL] ⚠️  Nothing to wrap — native SOL at minimum reserve');
    return null;
  }

  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);
  console.log(`[WSOL] 🔄 Wrapping ${amountSol.toFixed(4)} SOL → WSOL...`);

  const tx = new Transaction().add(
    // Transfer native SOL to the WSOL ATA
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: ata, lamports }),
    // Sync the WSOL token balance to reflect the deposit
    createSyncNativeInstruction(ata)
  );

  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: 'confirmed' });
    const newBalance = await getWsolBalance(connection, wallet.publicKey);
    console.log(`[WSOL] ✅ Wrapped ${amountSol.toFixed(4)} SOL → WSOL | WSOL balance: ${newBalance.toFixed(4)} | tx: ${sig}`);
    return sig;
  } catch (e: any) {
    console.error('[WSOL] ❌ Wrap failed:', e.message);
    return null;
  }
}

/**
 * Unwrap ALL WSOL back to native SOL (close the ATA).
 * Use this to convert proceeds back to native SOL if needed.
 */
export async function unwrapAllSol(
  connection: Connection,
  wallet: Keypair
): Promise<string | null> {
  const ata = await getWsolAta(wallet.publicKey);
  const balance = await getWsolBalance(connection, wallet.publicKey);
  if (balance === 0) { console.log('[WSOL] Nothing to unwrap'); return null; }

  console.log(`[WSOL] 🔄 Unwrapping ${balance.toFixed(4)} WSOL → SOL...`);
  const tx = new Transaction().add(
    createCloseAccountInstruction(ata, wallet.publicKey, wallet.publicKey)
  );
  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: 'confirmed' });
    console.log(`[WSOL] ✅ Unwrapped ${balance.toFixed(4)} WSOL → SOL | tx: ${sig}`);
    return sig;
  } catch (e: any) {
    console.error('[WSOL] ❌ Unwrap failed:', e.message);
    return null;
  }
}

/**
 * Auto-refill WSOL ATA from native SOL if WSOL balance drops below threshold.
 * Call this in the main loop of sniper/pumpfun agents before each trade.
 * Wraps everything above the native reserve into WSOL.
 */
export async function autoRefillWsol(
  connection: Connection,
  wallet: Keypair,
  minWsolSol = 0.01  // trigger refill if WSOL < this amount
): Promise<void> {
  const { wsolSol, nativeSol } = await getTotalSpendableBalance(connection, wallet.publicKey);
  if (wsolSol >= minWsolSol) return; // already enough WSOL

  const wrapAmt = nativeSol - MIN_NATIVE_SOL_RESERVE;
  if (wrapAmt > 0.001) {
    console.log(`[WSOL] 🔁 Auto-refill: WSOL ${wsolSol.toFixed(4)} < ${minWsolSol} — wrapping ${wrapAmt.toFixed(4)} SOL`);
    await wrapSol(connection, wallet, wrapAmt);
  }
}
