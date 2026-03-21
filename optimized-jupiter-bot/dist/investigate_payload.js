"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const quotes_1 = require("./jupiter/quotes");
const transaction_1 = require("./execution/transaction");
const logger_1 = require("./utils/logger");
async function investigate() {
    console.log("Starting payload derivation testing sequence...");
    await new Promise(r => setTimeout(r, 1000)); // wait for blockhash to cache
    logger_1.logger.info("Fetching strict quote for simulation...");
    const TOKENS = {
        WSOL: "So11111111111111111111111111111111111111112",
        USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    };
    const tradeSize = 0.05 * 10 ** 9; // small
    const quote1 = await (0, quotes_1.fetchJupiterQuote)(TOKENS.WSOL, TOKENS.USDC, tradeSize);
    if (!quote1)
        throw new Error("Quote 1 failed");
    const quote2 = await (0, quotes_1.fetchJupiterQuote)(TOKENS.USDC, TOKENS.WSOL, Number(quote1.outAmount));
    if (!quote2)
        throw new Error("Quote 2 failed");
    logger_1.logger.info("Fetching parallel swap instructions...");
    const instructions = await (0, quotes_1.getParallelSwapInstructions)(quote1, quote2);
    if (!instructions)
        throw new Error("Instructions fetch failed");
    logger_1.logger.info("Building versioned transaction...");
    const transaction = await (0, transaction_1.buildVersionedTransaction)(instructions.ix1, instructions.ix2);
    if (transaction) {
        logger_1.logger.info(`✅ Successfully built Payload. BROADCASTING FORCED LIVE TEST...`);
        const { submitTransactionWithRacing } = require('./execution/racing');
        const result = await submitTransactionWithRacing(transaction);
        logger_1.logger.info(`Transaction result: ${JSON.stringify(result)}`);
    }
    else {
        logger_1.logger.error(`❌ Failed to build Payload!`);
    }
    process.exit(0);
}
investigate();
