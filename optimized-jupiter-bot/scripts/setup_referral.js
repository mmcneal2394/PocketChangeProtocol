/**
 * REFERRAL FEE ACCOUNT SETUP
 * Creates the wSOL + USDC Associated Token Accounts that Jupiter
 * will deposit platform fees into. Run once.
 */
'use strict';
require('dotenv').config();
const { Connection, Keypair, PublicKey, Transaction, SystemProgram } = require('@solana/web3.js');
const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const fs = require('fs');

const HELIUS_RPC = process.env.RPC_ENDPOINT || 'https://rpc.helius.xyz/?api-key=YOUR_HELIUS_API_KEY';
const wSOL = new PublicKey('So11111111111111111111111111111111111111112');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

const wallet = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync('./real_wallet.json'))));
const conn   = new Connection(HELIUS_RPC, 'confirmed');

async function getOrCreateATA(mint, label) {
  const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
  console.log(`\n${label} fee ATA: ${ata.toBase58()}`);
  const info = await conn.getAccountInfo(ata);
  if (info) { console.log(`  ✅ Already exists`); return ata; }
  console.log(`  Creating...`);
  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(wallet.publicKey, ata, wallet.publicKey, mint)
  );
  const sig = await conn.sendTransaction(tx, [wallet]);
  await conn.confirmTransaction(sig, 'confirmed');
  console.log(`  ✅ Created: https://solscan.io/account/${ata.toBase58()}`);
  return ata;
}

async function main() {
  console.log('\n═══════════════════════════════════════════');
  console.log('  REFERRAL FEE ACCOUNT SETUP');
  console.log('═══════════════════════════════════════════');
  console.log(`  Authority: ${wallet.publicKey.toBase58()}`);

  const wsolATA = await getOrCreateATA(wSOL, 'wSOL');
  const usdcATA = await getOrCreateATA(USDC, 'USDC');

  console.log('\n═══════════════════════════════════════════');
  console.log('  ADD THESE TO .env:');
  console.log('═══════════════════════════════════════════');
  console.log(`PLATFORM_FEE_BPS=20`);
  console.log(`PLATFORM_FEE_ACCOUNT_WSOL=${wsolATA.toBase58()}`);
  console.log(`PLATFORM_FEE_ACCOUNT_USDC=${usdcATA.toBase58()}`);
  console.log('\n  Copy ↑ into .env then restart arb-jup and sniper');
}
main().catch(e => { console.error('❌', e.message); process.exit(1); });
