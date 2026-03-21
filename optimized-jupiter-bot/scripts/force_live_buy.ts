import { Connection, PublicKey, Keypair } from '@solana/web3.js';
import fetch from 'node-fetch';
import * as fs from 'fs';
import bs58 from 'bs58';
import { logger } from '../src/utils/logger';
import { config } from '../src/utils/config';
import { buildVersionedTransaction } from '../src/execution/transaction';
import { submitTransactionWithRacing } from '../src/execution/racing';
import * as cache from '../src/jupiter/cache';

const connection = new Connection(config.RPC_ENDPOINT, { commitment: 'processed' });
const walletRaw = JSON.parse(fs.readFileSync(config.WALLET_KEYPAIR_PATH, 'utf-8'));
const wallet = Keypair.fromSecretKey(new Uint8Array(walletRaw));

async function forceLiveBuy() {
    logger.info("🔥 [FORCE LIVE BUY] Generating true on-chain swap via Jito boundaries...");
    
    logger.info("Fetching strict network blockhash temporarily...");
    const { blockhash } = await connection.getLatestBlockhash();
    // @ts-ignore
    cache.getCachedBlockhash = () => blockhash;
    
    // 1. Get Real Quote (0.001 SOL -> USDC)
    const quoteResponse = await (
        await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50`)
    ).json();

    if (!quoteResponse) {
        logger.error("Failed to fetch Jupiter quote.");
        return;
    }

    // 2. Instruct Jupiter to return raw un-serialized ix data instead of a built transaction!
    const instructionsReq = await fetch('https://lite-api.jup.ag/swap/v1/swap-instructions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            quoteResponse,
            userPublicKey: wallet.publicKey.toString(),
            wrapAndUnwrapSol: true,
        })
    });
    
    const ixData: any = await instructionsReq.json();
    if (ixData.error) {
         logger.error("Jupiter Swap IX Error: ", ixData.error);
         return;
    }

    // 3. Funnel true instructions straight through our bespoke Native Execution Boundary Engine!
    // The engine attaches strict Baseline Priority Fees (1000 microLamports) + Dynamic Jito Tip securely!
    const jitoTipLamports = 100000; // Hardcoded 0.0001 SOL Jito inclusion tip to ensure it maps boundaries!
    
    // We pass ixData as ix1, and nothing as ix2 for a 1-hop execution.
    const emptyIx = { setupInstructions: [], swapInstruction: null, cleanupInstruction: null, addressLookupTableAddresses: [] };
    
    logger.info("⚡ Funneling Swap Instructions into Native Compiler...");
    
    const transaction = await buildVersionedTransaction(ixData, emptyIx, jitoTipLamports);

    if (transaction) {
         logger.info("🚀 Dispatching into BloXroute, Jito, and Chainstack Racing Pipeline!");
         const response: any = await submitTransactionWithRacing(transaction);
         if (response && response.success) {
              logger.info(`✅ PHYSICAL EXECUTION SUCCESS!`);
              logger.info(`🔗 Explorer: https://solscan.io/tx/${response.signature}`);
         } else {
              logger.error("All Racing pipelines failed to drop the execution on-chain!");
         }
    } else {
         logger.error("Native Compiler failed to build versioned structures.");
    }
}

forceLiveBuy().then(() => {
    setTimeout(() => process.exit(0), 10000);
});
