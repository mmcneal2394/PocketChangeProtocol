/**
 * pump_executor.ts — On-chain pump.fun bonding curve execution
 * ─────────────────────────────────────────────────────────────────────────────
 * Builds and submits actual buy/sell transactions on the pump.fun bonding curve.
 * Uses the Pump program instruction format with proper account derivation.
 *
 * Pump program: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 * Buy discriminator:  0x66063d1201daebea
 * Sell discriminator: 0x33e685a4017f83ad
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, LAMPORTS_PER_SOL, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
const PUMP_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ5GEFDM97zC');
const PUMP_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjQ7d7TDEkHw');
const SYSTEM_PROGRAM = SystemProgram.programId;
const RENT_SYSVAR = new PublicKey('SysvarRent111111111111111111111111111111111');

// Jito tip accounts
const JITO_TIP_ACCOUNTS = [
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'DttWaMuVvTiDuNV8bnSiGwMU5B5LWyVVdeXP8kJ7HPnV',
  'HFqU5x63VTqvQss8hp11i4bPOHzY3YMqP1RGjBXkHRe8',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSGA6ho3DZANpTqMGTE',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  'ADaUMid9yfUytqMBgopwjb2DTLSATGHPdFo1DQQKQ4BU',
  'HkFmgjBdBEpGuFSbE9aqjd3kWhnMFKMZbQLJtfG1PAXB',
];

// Instruction discriminators (SHA256 of "global:buy" / "global:sell" first 8 bytes)
const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

/** Derive the bonding curve PDA for a given mint */
function deriveBondingCurve(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM_ID,
  );
  return pda;
}

/** Derive the bonding curve's associated token account */
async function deriveBondingCurveAta(mint: PublicKey, bondingCurve: PublicKey): Promise<PublicKey> {
  return getAssociatedTokenAddress(mint, bondingCurve, true);
}

/** Build a pump.fun BUY instruction */
function buildBuyInstruction(
  wallet: PublicKey,
  mint: PublicKey,
  bondingCurve: PublicKey,
  bondingCurveAta: PublicKey,
  walletAta: PublicKey,
  tokenAmount: bigint,
  maxSolCost: bigint,
): TransactionInstruction {
  // Encode: discriminator(8) + amount(u64) + maxSolCost(u64)
  const data = Buffer.alloc(8 + 8 + 8);
  BUY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(tokenAmount, 8);
  data.writeBigUInt64LE(maxSolCost, 16);

  const keys = [
    { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
    { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: bondingCurveAta, isSigner: false, isWritable: true },
    { pubkey: walletAta, isSigner: false, isWritable: true },
    { pubkey: wallet, isSigner: true, isWritable: true },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: RENT_SYSVAR, isSigner: false, isWritable: false },
    { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ keys, programId: PUMP_PROGRAM_ID, data });
}

/** Build a pump.fun SELL instruction */
function buildSellInstruction(
  wallet: PublicKey,
  mint: PublicKey,
  bondingCurve: PublicKey,
  bondingCurveAta: PublicKey,
  walletAta: PublicKey,
  tokenAmount: bigint,
  minSolOut: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(8 + 8 + 8);
  SELL_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(tokenAmount, 8);
  data.writeBigUInt64LE(minSolOut, 16);

  const keys = [
    { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
    { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: bondingCurveAta, isSigner: false, isWritable: true },
    { pubkey: walletAta, isSigner: false, isWritable: true },
    { pubkey: wallet, isSigner: true, isWritable: true },
    { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({ keys, programId: PUMP_PROGRAM_ID, data });
}

/** Build a Jito tip instruction */
function buildJitoTipIx(wallet: PublicKey, tipLamports: number): TransactionInstruction {
  const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
  return SystemProgram.transfer({
    fromPubkey: wallet,
    toPubkey: new PublicKey(tipAccount),
    lamports: tipLamports,
  });
}

/** Execute a LIVE buy on the pump.fun bonding curve */
export async function liveBuyOnCurve(
  connection: Connection,
  wallet: Keypair,
  mintStr: string,
  tokenAmount: bigint,
  maxSolCost: bigint,
  tipLamports: number = 100_000, // 0.0001 SOL Jito tip
): Promise<string | null> {
  try {
    const mint = new PublicKey(mintStr);
    const bondingCurve = deriveBondingCurve(mint);
    const bondingCurveAta = await deriveBondingCurveAta(mint, bondingCurve);
    const walletAta = await getAssociatedTokenAddress(mint, wallet.publicKey);

    const tx = new Transaction();

    // Priority fee
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));

    // Create ATA if needed
    const ataInfo = await connection.getAccountInfo(walletAta);
    if (!ataInfo) {
      tx.add(createAssociatedTokenAccountInstruction(
        wallet.publicKey, walletAta, wallet.publicKey, mint,
      ));
    }

    // Buy instruction
    tx.add(buildBuyInstruction(
      wallet.publicKey, mint, bondingCurve, bondingCurveAta, walletAta,
      tokenAmount, maxSolCost,
    ));

    // Jito tip
    tx.add(buildJitoTipIx(wallet.publicKey, tipLamports));

    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });

    console.log(`[PUMP-EXEC] BUY submitted: ${sig}`);
    return sig;
  } catch (e: any) {
    console.error(`[PUMP-EXEC] BUY failed: ${e.message}`);
    return null;
  }
}

/** Execute a LIVE sell on the pump.fun bonding curve */
export async function liveSellOnCurve(
  connection: Connection,
  wallet: Keypair,
  mintStr: string,
  tokenAmount: bigint,
  minSolOut: bigint,
  tipLamports: number = 50_000,
): Promise<string | null> {
  try {
    const mint = new PublicKey(mintStr);
    const bondingCurve = deriveBondingCurve(mint);
    const bondingCurveAta = await deriveBondingCurveAta(mint, bondingCurve);
    const walletAta = await getAssociatedTokenAddress(mint, wallet.publicKey);

    const tx = new Transaction();

    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));

    // Sell instruction
    tx.add(buildSellInstruction(
      wallet.publicKey, mint, bondingCurve, bondingCurveAta, walletAta,
      tokenAmount, minSolOut,
    ));

    // Jito tip
    tx.add(buildJitoTipIx(wallet.publicKey, tipLamports));

    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;
    tx.sign(wallet);

    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 3,
    });

    console.log(`[PUMP-EXEC] SELL submitted: ${sig}`);
    return sig;
  } catch (e: any) {
    console.error(`[PUMP-EXEC] SELL failed: ${e.message}`);
    return null;
  }
}
