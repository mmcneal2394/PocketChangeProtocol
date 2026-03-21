/**
 * SET UP JUPITER REFERRAL — via anchor + known program ID
 * Program: REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3
 */
'use strict';
require('dotenv').config();
const nodeFetch = require('node-fetch');
const { Connection, Keypair, PublicKey, Transaction, SystemProgram, SYSVAR_RENT_PUBKEY } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddress } = require('@solana/spl-token');
const fs = require('fs');
const crypto = require('crypto');

const HELIUS_RPC = process.env.RPC_ENDPOINT;
const wallet = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync('./real_wallet.json'))));
const conn   = new Connection(HELIUS_RPC, 'confirmed');

// Jupiter referral program
const REFERRAL_PROGRAM = new PublicKey('REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3');
const wSOL = new PublicKey('So11111111111111111111111111111111111111112');
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

// Derive project PDA
async function getProjectPDA(adminKey) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('project'), adminKey.toBuffer()],
    REFERRAL_PROGRAM
  );
  return pda;
}

// Derive referral token account PDA
async function getReferralTokenAccountPDA(projectPDA, mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('referral_ata'), projectPDA.toBuffer(), mint.toBuffer()],
    REFERRAL_PROGRAM
  );
  return pda;
}

async function main() {
  const admin = wallet.publicKey;
  console.log('\n═════════════════════════════════════════════');
  console.log('  JUPITER REFERRAL SETUP');
  console.log('═════════════════════════════════════════════');
  console.log(`  Wallet: ${admin.toBase58()}`);

  const projectPDA = await getProjectPDA(admin);
  console.log(`  Project PDA: ${projectPDA.toBase58()}`);

  // Check if project already exists
  const info = await conn.getAccountInfo(projectPDA);
  if (info) {
    console.log('  ✅ Project already exists on-chain!');
  } else {
    console.log('  Project does not exist yet — needs initialization via referral.jup.ag dashboard or SDK on Linux/Mac');
  }

  // Derive fee token account PDAs
  for (const [label, mint] of [['wSOL', wSOL], ['USDC', USDC]]) {
    const refTokATA = await getReferralTokenAccountPDA(projectPDA, mint);
    console.log(`\n  ${label} referral token acct PDA: ${refTokATA.toBase58()}`);
    const ataInfo = await conn.getAccountInfo(refTokATA);
    if (ataInfo) {
      console.log(`  ✅ ${label} referral token account EXISTS on-chain — use this as feeAccount!`);
    } else {
      console.log(`  ❌ ${label} referral token account not yet initialized`);
    }
  }

  const wSOLref = await getReferralTokenAccountPDA(projectPDA, wSOL);
  const USDCref = await getReferralTokenAccountPDA(projectPDA, USDC);

  console.log('\n═════════════════════════════════════════════');
  console.log('  DERIVED ADDRESSES (add to .env if accounts exist):');
  console.log('═════════════════════════════════════════════');
  console.log(`PLATFORM_REFERRAL_PROJECT=${projectPDA.toBase58()}`);
  console.log(`PLATFORM_FEE_ACCOUNT_WSOL=${wSOLref.toBase58()}`);
  console.log(`PLATFORM_FEE_ACCOUNT_USDC=${USDCref.toBase58()}`);
  console.log('\n  Verify on Solscan:');
  console.log(`  https://solscan.io/account/${wSOLref.toBase58()}`);
  console.log(`  https://solscan.io/account/${USDCref.toBase58()}`);

  // Visit https://referral.jup.ag to initialize if not exists
  if (!info) {
    console.log('\n  📋 ACTION REQUIRED:');
    console.log('  Go to https://referral.jup.ag and connect your wallet');
    console.log('  DnQhJawMXW7ZWA19XbzrV1q3KWZvMnpfyrxe4f74FHVj');
    console.log('  Create a project named "pcprotocol" to initialize the PDA on-chain');
    console.log('  Then re-run this script to confirm and get your feeAccount addresses');
  }
}
main().catch(e => { console.error('\n❌', e.message); process.exit(1); });
