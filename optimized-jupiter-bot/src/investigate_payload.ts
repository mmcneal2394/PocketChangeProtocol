import { fetchJupiterQuote, getParallelSwapInstructions } from './jupiter/quotes';
import { buildVersionedTransaction } from './execution/transaction';
import { getCachedBlockhash } from './jupiter/cache';
import { logger } from './utils/logger';

async function investigate() {
  console.log("Starting payload derivation testing sequence...");
  await new Promise(r => setTimeout(r, 1000)); // wait for blockhash to cache
  
  logger.info("Fetching strict quote for simulation...");
  const TOKENS = {
    WSOL: "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  };

  const tradeSize = 0.05 * 10 ** 9; // small

  const quote1 = await fetchJupiterQuote(TOKENS.WSOL, TOKENS.USDC, tradeSize);
  if (!quote1) throw new Error("Quote 1 failed");

  const quote2 = await fetchJupiterQuote(TOKENS.USDC, TOKENS.WSOL, Number(quote1.outAmount));
  if (!quote2) throw new Error("Quote 2 failed");

  logger.info("Fetching parallel swap instructions...");
  const instructions = await getParallelSwapInstructions(quote1, quote2);
  if (!instructions) throw new Error("Instructions fetch failed");

  logger.info("Building versioned transaction...");
  const transaction = await buildVersionedTransaction(instructions.ix1, instructions.ix2);

  if (transaction) {
      logger.info(`✅ Successfully built Payload. BROADCASTING FORCED LIVE TEST...`);
      const { submitTransactionWithRacing } = require('./execution/racing');
      const result = await submitTransactionWithRacing(transaction);
      logger.info(`Transaction result: ${JSON.stringify(result)}`);
  } else {
      logger.error(`❌ Failed to build Payload!`);
  }
  process.exit(0);
}

investigate();
