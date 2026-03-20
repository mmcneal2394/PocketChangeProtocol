import { createJupiterApiClient } from '@jup-ag/api';
import { Connection, Keypair, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js';
import * as fs from 'fs';
import { config } from './utils/config';
import { logger } from './utils/logger';

const jupiter = createJupiterApiClient({ basePath: config.JUPITER_ENDPOINT });
const connection = new Connection(config.RPC_ENDPOINT, { commitment: 'processed' });

// Token the bot searches out
const TOKENS = {
  WSOL: "So11111111111111111111111111111111111111112",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", // BONK
};

async function forceTestTrade() {
  logger.info("⚡ FORCING SINGLE BUY TEST (BONK) ⚡");

  const walletJson = JSON.parse(fs.readFileSync(config.WALLET_KEYPAIR_PATH, 'utf-8'));
  const wallet = Keypair.fromSecretKey(new Uint8Array(walletJson));

  logger.info(`Keypair loaded: ${wallet.publicKey.toBase58()}`);

  const tradeSize = 0.025 * 10 ** 9; // 0.025 SOL 

  logger.info("1) Fetching Quote from Jupiter...");
  const quoteResponse = await jupiter.quoteGet({
    inputMint: TOKENS.WSOL,
    outputMint: TOKENS.BONK,
    amount: tradeSize,
    slippageBps: 100, // 1%
  });

  if (!quoteResponse) throw new Error("Jupiter returned null quote.");
  logger.info(`Quote received! Expected Output: ${(Number(quoteResponse.outAmount)/10**6).toFixed(4)} WIF`);

  logger.info("2) Fetching Transaction Payload...");
  const { swapTransaction } = await jupiter.swapPost({
    swapRequest: {
      quoteResponse,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true
    }
  });

  if (!swapTransaction) throw new Error("Failed to get swap transaction payload");

  logger.info("3) Signing Transaction and Injecting Priority Fees...");
  const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
  let transaction = VersionedTransaction.deserialize(swapTransactionBuf);
  transaction.sign([wallet]);

  logger.info("4) Submitting via Target RPC with High Priority Allocation...");
  try {
      const rawTx = transaction.serialize();
      const signature = await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        maxRetries: 3
      });
      logger.info(`✅ SUCCESS! Transaction Sent!`);
      logger.info(`🔗 Signature: https://solscan.io/tx/${signature}`);
  } catch (err: any) {
      logger.error(`❌ FAILED TO SUBMIT: ${err.message}`);
  }
}

forceTestTrade()
  .then(() => {
    logger.info("Force test execution completely finished.");
    process.exit(0);
  })
  .catch(err => {
    logger.error("Test failed: ", err);
    process.exit(1);
  });
