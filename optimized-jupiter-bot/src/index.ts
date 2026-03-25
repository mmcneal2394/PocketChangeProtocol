import { createGeyserClient }    from './geyser/client';
import { startGeyserListeners }  from './geyser/handlers';
import { logger }                 from './utils/logger';
import { startStrategyTuner }    from './strategy_tuner';
import { priceFeed }             from './utils/price_feed';
import {
  Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress, createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import fs   from 'fs';
import path from 'path';

// ── ATA pre-creation (saves $0.18/trade on every seeded route) ───────────────
const ATA_CACHE_FILE   = path.join(process.cwd(), 'ata_cache.json');
const ATA_RENT         = 2_039_280; // lamports

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

async function ensureAtas(): Promise<void> {
  // ── Load wallet ─────────────────────────────────────────────────────────────
  let wallet: Keypair | null = null;
  try {
    const keypairPath  = process.env.WALLET_KEYPAIR_PATH;
    const privKeyBs58  = process.env.WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;
    if (keypairPath && fs.existsSync(keypairPath)) {
      wallet = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(keypairPath, 'utf-8'))));
    } else if (privKeyBs58) {
      const { default: bs58 } = await import('bs58');
      wallet = Keypair.fromSecretKey(bs58.decode(privKeyBs58));
    }
  } catch (e: any) {
    logger.warn(`[ATA] Could not load wallet keypair: ${e.message} — skipping ATA pre-creation`);
    return;
  }
  if (!wallet) {
    logger.warn('[ATA] No wallet key configured (WALLET_KEYPAIR_PATH / WALLET_PRIVATE_KEY) — skipping ATA pre-creation');
    return;
  }

  const rpc   = process.env.RPC_ENDPOINT;
  if (!rpc) { logger.warn('[ATA] RPC_ENDPOINT not set — skipping ATA pre-creation'); return; }

  const owner = wallet.publicKey;
  const conn  = new Connection(rpc, 'confirmed');

  // ── Load existing cache ──────────────────────────────────────────────────────
  const cache: Record<string, boolean> = fs.existsSync(ATA_CACHE_FILE)
    ? JSON.parse(fs.readFileSync(ATA_CACHE_FILE, 'utf-8')) : {};

  let created = 0, skipped = 0, failed = 0;

  for (const { mint: mintStr, sym } of SEEDED_MINTS) {
    // Already cached → skip on-chain check (fast path)
    if (cache[mintStr]) { skipped++; continue; }

    try {
      const mint = new PublicKey(mintStr);
      const ata  = await getAssociatedTokenAddress(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

      // Check on-chain
      const info = await conn.getAccountInfo(ata);
      if (info !== null) {
        cache[mintStr] = true;
        skipped++;
        continue;
      }

      // Create missing ATA
      logger.info(`[ATA] Creating ${sym} ATA (~${(ATA_RENT / 1e9).toFixed(4)} SOL)…`);
      const ix  = createAssociatedTokenAccountInstruction(owner, ata, owner, mint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
      const tx  = new Transaction().add(ix);
      await sendAndConfirmTransaction(conn, tx, [wallet], { commitment: 'confirmed' });
      cache[mintStr] = true;
      created++;
      await new Promise(r => setTimeout(r, 400)); // pace to avoid RPC flood
    } catch (e: any) {
      logger.warn(`[ATA] Failed to create ${sym}: ${e.message}`);
      failed++;
    }
  }

  // Persist updated cache
  fs.writeFileSync(ATA_CACHE_FILE, JSON.stringify(cache, null, 2));

  const savedPerTrade = (ATA_RENT / 1e9 * Object.keys(cache).filter(k => cache[k]).length).toFixed(4);
  logger.info(`[ATA] Pre-creation done — ${skipped} cached | ${created} created | ${failed} failed | ~${savedPerTrade} SOL saved/trade`);
}

async function main() {
  logger.info('Starting Optimized Jupiter Arbitrage Bot...');
  logger.info(`Starting highly optimized JUPBOT engine using AMSTERDAM bypass...`);

  // ── Step 0: ATA pre-creation (runs every restart, fast if already cached) ──
  logger.info('[BOOT] Ensuring ATA accounts are pre-created…');
  await ensureAtas();

  // ── Start live price feed first (Pyth WS + Jupiter fallback) ──────────────
  priceFeed.start();
  priceFeed.on('price', (mint: string, price: number, src: string) => {
    if (mint === 'So11111111111111111111111111111111111111112') {
      process.env.SOL_PRICE_HINT = price.toFixed(4);
    }
  });

  // ── Start 72h strategy auto-calibration in background ──────────────────
  startStrategyTuner();

  // Initialize Geyser gRPC connection
  logger.info('Connecting to Chainstack Geyser gRPC...');
  try {
    const { stream } = await createGeyserClient();
    
    logger.info('Attaching gRPC stream handlers...');
    startGeyserListeners(stream);

    logger.info('Bot is successfully running and waiting for stream updates.');
    logger.info('Live Geyser Listener securely active across Mainnet physical socket.');

    setTimeout(async () => {
        logger.warn("🔥 [FORCED TEST START] Constructing diagnostic trace via the core Arbitrage Engine (SOL -> USDC -> SOL)...");
        const { globalArbEngine } = await import('./local_calc/arb_engine');
        const mockOpp = {
            type: 'Force-Test-Hop',
            description: 'SOL -> USDC -> SOL (SYNTHETIC ROUTE)',
            expectedInSol: 0.001,
            expectedOutSol: 0.001,
            grossProfitSol: 0,
            netProfit: 0,
            tipAmount: 0.001,
            pools: []
        };
        // @ts-ignore
        await globalArbEngine['executeArbitrage'](mockOpp);
        logger.info("✅ [FORCED TEST COMPLETE] Engine reverted to Geyser scanner.");
    }, 8000);
  } catch (error) {
    logger.error('Failed to start bot due to Geyser connection issue:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error('Fatal unhandled exception:', error);
  process.exit(1);
});

