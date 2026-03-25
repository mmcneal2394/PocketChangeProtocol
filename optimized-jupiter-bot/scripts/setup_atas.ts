/**
 * setup_atas.ts  —  One-time ATA pre-creation for all seeded routes
 * ─────────────────────────────────────────────────────────────────────────────
 * Creates Associated Token Accounts for the operator wallet for every token
 * in the seeded route list. Run once before starting the engine.
 *
 * Cost: ~0.002039 SOL per new ATA × 20 tokens = ~0.041 SOL (~$3.60 at $87/SOL)
 * Benefit: Removes $0.177 ATA rent deduction from every subsequent trade.
 *
 * Usage:  npx ts-node scripts/setup_atas.ts [--dry-run]
 * ─────────────────────────────────────────────────────────────────────────────
 */
import dotenv from 'dotenv';
dotenv.config();

import {
  Connection, Keypair, PublicKey, Transaction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import fs from 'fs';
import path from 'path';

const DRY_RUN = process.argv.includes('--dry-run');

// All seeded route mints (from route_manager seedDefaults)
const SEEDED_MINTS = [
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', sym: 'USDC'     },
  { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', sym: 'USDT'     },
  { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', sym: 'MSOL'     },
  { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', sym: 'jitoSOL'  },
  { mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  sym: 'bSOL'     },
  { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',  sym: 'ORCA'     },
  { mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', sym: 'RAY'      },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', sym: 'BONK'     },
  { mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYtM2wYSzRo', sym: 'WIF'      },
  { mint: '7GCihgDB8fe6KNjn2gN7ZDB2h2n2i2Z7pW2r2YjN1e8p', sym: 'POPCAT'   },
  { mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgM2W8qT',  sym: 'BOME'     },
  { mint: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', sym: 'TRUMP'    },
  { mint: 'FUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P', sym: 'MELANIA'  },
  { mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump', sym: 'FARTCOIN' },
  { mint: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC', sym: 'AI16Z'    },
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbPwdrsxGBK',   sym: 'JUP'      },
  { mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',  sym: 'JTO'      },
  { mint: '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4', sym: 'MEW'      },
  { mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3AkTftx2K2aFCh', sym: 'PYTH'     },
  { mint: '4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS', sym: 'PCP'      },
];

const ATA_CACHE_FILE = path.join(__dirname, '..', 'ata_cache.json');
const ATA_RENT_LAMPORTS = 2_039_280;

async function main() {
  const rpc = process.env.RPC_ENDPOINT;
  if (!rpc) throw new Error('RPC_ENDPOINT not set in .env');

  // Support both JSON keypair file (WALLET_KEYPAIR_PATH) and bs58 private key
  let wallet: Keypair;
  const keypairPath = process.env.WALLET_KEYPAIR_PATH;
  const privKeyBs58 = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (keypairPath && fs.existsSync(keypairPath)) {
    const rawKeypair = JSON.parse(fs.readFileSync(keypairPath, 'utf-8'));
    wallet = Keypair.fromSecretKey(new Uint8Array(rawKeypair));
  } else if (privKeyBs58) {
    const { default: bs58 } = await import('bs58');
    wallet = Keypair.fromSecretKey(bs58.decode(privKeyBs58));
  } else {
    throw new Error('Set WALLET_KEYPAIR_PATH (JSON file) or WALLET_PRIVATE_KEY (bs58) in .env');
  }
  const owner = wallet.publicKey;
  const conn  = new Connection(rpc, 'confirmed');

  console.log(`\n╔═══════════════════════════════════════════════════════╗`);
  console.log(`║   ATA Pre-Creation Setup                              ║`);
  console.log(`║   Wallet: ${owner.toBase58().slice(0,20)}…           ║`);
  console.log(`║   Mode:   ${DRY_RUN ? 'DRY RUN (no txns)            ' : 'LIVE (will submit txns)      '}║`);
  console.log(`╚═══════════════════════════════════════════════════════╝\n`);

  const balance = await conn.getBalance(owner);
  console.log(`  Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  const existingCache: Record<string, boolean> = fs.existsSync(ATA_CACHE_FILE)
    ? JSON.parse(fs.readFileSync(ATA_CACHE_FILE, 'utf-8'))
    : {};

  let created = 0, existing = 0, failed = 0;
  let totalCost = 0;
  const newCache = { ...existingCache };

  for (const { mint: mintStr, sym } of SEEDED_MINTS) {
    const mint = new PublicKey(mintStr);
    const ata  = await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

    // Check cache first
    if (existingCache[mintStr]) {
      console.log(`  ✅ ${sym.padEnd(10)} ATA: ${ata.toBase58().slice(0,20)}… [cached]`);
      existing++;
      continue;
    }

    // Check on-chain
    const info = await conn.getAccountInfo(ata);
    if (info !== null) {
      console.log(`  ✅ ${sym.padEnd(10)} ATA: ${ata.toBase58().slice(0,20)}… [on-chain]`);
      newCache[mintStr] = true;
      existing++;
      continue;
    }

    // Need to create
    const cost = ATA_RENT_LAMPORTS / LAMPORTS_PER_SOL;
    console.log(`  📝 ${sym.padEnd(10)} Creating ATA… (~${cost.toFixed(4)} SOL)`);
    totalCost += ATA_RENT_LAMPORTS;

    if (!DRY_RUN) {
      try {
        const ix = createAssociatedTokenAccountInstruction(
          owner, ata, owner, mint,
          TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
        );
        const tx = new Transaction().add(ix);
        const sig = await sendAndConfirmTransaction(conn, tx, [wallet], {
          commitment: 'confirmed',
          skipPreflight: false,
        });
        console.log(`     ✓ Created: ${sig.slice(0,20)}…`);
        newCache[mintStr] = true;
        created++;
      } catch (e: any) {
        console.error(`     ✗ Failed: ${e.message}`);
        failed++;
      }
      await new Promise(r => setTimeout(r, 500));
    } else {
      console.log(`     [DRY RUN — would create]`);
      created++; // count as would-create
    }
  }

  // Save cache
  fs.writeFileSync(ATA_CACHE_FILE, JSON.stringify(newCache, null, 2));

  console.log(`\n══════════════ SUMMARY ══════════════`);
  console.log(`  Already existed  : ${existing}`);
  console.log(`  Created${DRY_RUN?' (simulated)':''}         : ${created}`);
  console.log(`  Failed           : ${failed}`);
  console.log(`  Total cost       : ${(totalCost / LAMPORTS_PER_SOL).toFixed(4)} SOL ($${((totalCost / LAMPORTS_PER_SOL) * 87).toFixed(2)})`);
  console.log(`  ATA cache saved  : ${ATA_CACHE_FILE}`);
  console.log(`\n  Per-trade savings: ${(ATA_RENT_LAMPORTS / LAMPORTS_PER_SOL).toFixed(4)} SOL ($${(ATA_RENT_LAMPORTS / LAMPORTS_PER_SOL * 87).toFixed(3)}) x trades`);
}

main().catch(e => { console.error(e); process.exit(1); });
