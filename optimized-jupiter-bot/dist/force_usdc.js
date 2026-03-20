"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("@jup-ag/api");
const web3_js_1 = require("@solana/web3.js");
const fs = __importStar(require("fs"));
const config_1 = require("./utils/config");
const logger_1 = require("./utils/logger");
const jupiter = (0, api_1.createJupiterApiClient)({ basePath: config_1.config.JUPITER_ENDPOINT });
const connection = new web3_js_1.Connection(config_1.config.RPC_ENDPOINT, { commitment: 'processed' });
const TOKENS = {
    WSOL: "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
}; // USDC
async function forceTestTrade() {
    logger_1.logger.info("⚡ FORCING USDC BUY TEST ⚡");
    const walletJson = JSON.parse(fs.readFileSync(config_1.config.WALLET_KEYPAIR_PATH, 'utf-8'));
    const wallet = web3_js_1.Keypair.fromSecretKey(new Uint8Array(walletJson));
    logger_1.logger.info(`Keypair loaded: ${wallet.publicKey.toBase58()}`);
    const tradeSize = 0.001 * 10 ** 9; // 0.001 SOL 
    logger_1.logger.info("1) Fetching Quote from Jupiter...");
    const quoteResponse = await jupiter.quoteGet({
        inputMint: TOKENS.WSOL,
        outputMint: TOKENS.USDC,
        amount: tradeSize,
        slippageBps: 100, // 1%
    });
    if (!quoteResponse)
        throw new Error("Jupiter returned null quote.");
    logger_1.logger.info(`Quote received! Expected Output: ${(Number(quoteResponse.outAmount) / 10 ** 6).toFixed(4)} USDC`);
    logger_1.logger.info("2) Fetching Transaction Payload...");
    const { swapTransaction } = await jupiter.swapPost({
        swapRequest: {
            quoteResponse,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true
        }
    });
    if (!swapTransaction)
        throw new Error("Failed to get swap transaction payload");
    logger_1.logger.info("3) Signing Transaction...");
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    let transaction = web3_js_1.VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);
    logger_1.logger.info("4) Submitting via RPC...");
    try {
        const rawTx = transaction.serialize();
        const signature = await connection.sendRawTransaction(rawTx, {
            skipPreflight: true,
            maxRetries: 3
        });
        logger_1.logger.info(`✅ SUCCESS! Transaction Sent!`);
        logger_1.logger.info(`🔗 Signature: https://solscan.io/tx/${signature}`);
    }
    catch (err) {
        logger_1.logger.error(`❌ FAILED TO SUBMIT: ${err.message}`);
    }
}
forceTestTrade()
    .then(() => {
    logger_1.logger.info("Force test execution completely finished.");
    process.exit(0);
})
    .catch(err => {
    logger_1.logger.error("Test failed: ", err);
    process.exit(1);
});
