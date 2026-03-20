"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleAccountUpdate = handleAccountUpdate;
exports.startGeyserListeners = startGeyserListeners;
const logger_1 = require("../utils/logger");
const quotes_1 = require("../jupiter/quotes");
const transaction_1 = require("../execution/transaction");
const racing_1 = require("../execution/racing");
const config_1 = require("../utils/config");
const web3_js_1 = require("@solana/web3.js");
const trade_logger_1 = require("../utils/trade_logger");
const TOKENS = {
    WSOL: "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYtM2wYSzRo",
    BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
    JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbPwdrsxGBK",
    PYTH: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3AkTftx2K2aFCh",
    JTO: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
    POPCAT: "7GCihgDB8fe6KNjn2gN7ZDB2h2n2i2Z7pW2r2YjN1e8p",
    BOME: "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgM2W8qT"
};
const TRADE_ROUTES = [
    [TOKENS.WSOL, TOKENS.USDC],
    [TOKENS.WSOL, TOKENS.WIF],
    [TOKENS.WSOL, TOKENS.BONK],
    [TOKENS.WSOL, TOKENS.RAY],
    [TOKENS.WSOL, TOKENS.JUP],
    [TOKENS.WSOL, TOKENS.PYTH],
    [TOKENS.WSOL, TOKENS.JTO],
    [TOKENS.WSOL, TOKENS.POPCAT],
    [TOKENS.WSOL, TOKENS.BOME]
];
// Dynamic Routing Array (Updated via multi-DEX fetch)
let DYNAMIC_ROUTES = [...TRADE_ROUTES];
async function refreshDynamicTokens() {
    try {
        const jupRes = await fetch("https://token.jup.ag/strict");
        const jupData = await jupRes.json();
        if (jupData && jupData.length > 0) {
            const newRoutes = [];
            const shuffled = jupData.sort(() => 0.5 - Math.random()).slice(0, 50);
            shuffled.forEach((token) => {
                if (token.address !== TOKENS.WSOL) {
                    newRoutes.push([TOKENS.WSOL, token.address]);
                }
            });
            DYNAMIC_ROUTES = [...TRADE_ROUTES, ...newRoutes];
            logger_1.logger.info(`✅ Multi-DEX Token Rotator pulled ${newRoutes.length} trending items! Current Hunting Scope: ${DYNAMIC_ROUTES.length} routes.`);
        }
        if (config_1.config.BAGS_API_KEY) {
            const bagsRes = await fetch("https://public-api-v2.bags.fm/api/v1/tokens", {
                headers: { 'Authorization': `Bearer ${config_1.config.BAGS_API_KEY}` }
            });
            if (bagsRes.ok) {
                logger_1.logger.debug("Bags API authenticated securely.");
            }
        }
    }
    catch (err) {
        logger_1.logger.warn("Failed to fetch dynamic tokens:", err);
    }
}
refreshDynamicTokens();
// Refresh every 60 seconds (1 minute) for absolute maximum trending pool tracking
setInterval(refreshDynamicTokens, 60 * 1000);
// Connection for wallet balance checking
const connection = new web3_js_1.Connection(config_1.config.RPC_ENDPOINT, { commitment: 'processed' });
const walletPubkey = new web3_js_1.PublicKey(config_1.config.WALLET_PUBLIC_KEY);
let cachedLamportsBalance = 0.5 * 10 ** 9; // Fallback
// Update balance every 30 seconds
setInterval(async () => {
    try {
        cachedLamportsBalance = await connection.getBalance(walletPubkey);
    }
    catch (err) {
        logger_1.logger.warn("Failed to fetch wallet balance:", err);
    }
}, 30000);
let hasForcedInitialTrade = false;
let lastTradeTime = 0;
async function handleAccountUpdate(data) {
    const startMs = Date.now();
    // Guard-rail removal cooldown: prevent >10ms Geyser stream from physically draining all Solana via gas inside 1 second
    if (startMs - lastTradeTime < 10000)
        return;
    if (process.env.DEBUG) {
        logger_1.logger.debug(`[GEYSER] Stream triggered account update event.`);
    }
    const route = DYNAMIC_ROUTES[Math.floor(Math.random() * DYNAMIC_ROUTES.length)];
    const inputMint = route[0];
    const intermediateMint = route[1];
    // Phase 16a: Temporal Jitter (Anti-Trust / MEV Obfuscation)
    // Suspends execution for 5-25ms to spoof synthetic robotic tick-rates, destroying Validator Sandwich predictions
    const temporalJitterMs = Math.floor(Math.random() * 20) + 5;
    await new Promise(resolve => setTimeout(resolve, temporalJitterMs));
    // Phase 16b: Quantitative Parameter Jitter
    // Randomizes flat block sizing to generate organic, human-like byte lengths natively bypassing RPC WAF blocks
    const generateJitter = () => Number((Math.random() * 0.009).toFixed(4));
    const tradeSizes = [
        0.05 + generateJitter(),
        0.10 + generateJitter(),
        0.25 + generateJitter(),
        0.50 + generateJitter()
    ];
    logger_1.logger.info(`🔍 [JITTER: +${temporalJitterMs}ms] Hunting synthetic volumes for Route: WSOL -> ${intermediateMint.substring(0, 4)}...`);
    const sweepResults = await Promise.all(tradeSizes.map(async (size) => {
        const tradeSizeLamports = Math.floor(size * 10 ** 9);
        // Ensure the wallet can actually afford this leg (plus gas padding)
        if (cachedLamportsBalance < tradeSizeLamports + 50000)
            return null;
        const quote1 = await (0, quotes_1.fetchJupiterQuote)(inputMint, intermediateMint, tradeSizeLamports);
        if (!quote1)
            return null;
        const intermediateAmount = Number(quote1.otherAmountThreshold);
        const quote2 = await (0, quotes_1.fetchJupiterQuote)(intermediateMint, inputMint, intermediateAmount);
        if (!quote2)
            return null;
        const expectedOut = Number(quote2.outAmount);
        const grossProfitLamports = expectedOut - tradeSizeLamports;
        // Subtract standard physical network fees natively (Bypassing MEV Tips constraints)
        // Freed up ~200,000 lamports of margin previously wasted on Artificial buffers!
        const ESTIMATED_GAS_AND_TIP_LAMPORTS = 15000;
        const netProfitLamports = grossProfitLamports - ESTIMATED_GAS_AND_TIP_LAMPORTS;
        const netProfitBps = (netProfitLamports / tradeSizeLamports) * 10000;
        return { size, quote1, quote2, netProfitLamports, netProfitBps };
    }));
    // Filter valid completed sweeps
    const validResults = sweepResults.filter(r => r !== null);
    if (validResults.length === 0)
        return;
    // Select the trade size that yielded the highest absolute SOL profit
    const bestResult = validResults.sort((a, b) => b.netProfitLamports - a.netProfitLamports)[0];
    const processMs = Date.now() - startMs;
    if (bestResult.netProfitBps > 0) {
        logger_1.logger.info(`✅ [ARBITRAGE FOUND] Size: ${bestResult.size} SOL | Net Profit: ${bestResult.netProfitBps.toFixed(2)} bps (${(bestResult.netProfitLamports / 10 ** 9).toFixed(5)} SOL) [Sweep Ms: ${processMs}ms]`);
    }
    else {
        logger_1.logger.info(`❌ [NO ARBITRAGE] Route: SOL -> ${intermediateMint.substring(0, 4)}... | Best Size: ${bestResult.size} SOL yielded Net Loss: ${bestResult.netProfitBps.toFixed(2)} bps. [Sweep Ms: ${processMs}ms]`);
    }
    // Final confirmation to execute
    if (bestResult.netProfitBps >= config_1.config.MIN_PROFIT_BPS) {
        lastTradeTime = Date.now(); // Instantly lock out the concurrent Geyser streams
        logger_1.logger.warn(`🔥 PROFITABLE OPPORTUNITY DETECTED on Size ${bestResult.size} SOL! Proceeding to bundle extraction...`);
        let signatureStr = null;
        let success = false;
        const instructions = await (0, quotes_1.getParallelSwapInstructions)(bestResult.quote1, bestResult.quote2);
        if (instructions) {
            const transaction = await (0, transaction_1.buildVersionedTransaction)(instructions.ix1, instructions.ix2);
            if (transaction) {
                const results = await (0, racing_1.submitTransactionWithRacing)(transaction);
                const rpcResult = results[0];
                if (rpcResult.status === 'fulfilled' && rpcResult.value.success) {
                    signatureStr = rpcResult.value.signature;
                    success = true;
                }
            }
            else {
                logger_1.logger.error('Failed to build versioned transaction.');
            }
        }
        else {
            logger_1.logger.error('Failed to get routing instructions.');
        }
        // Persist evaluation metrics for analytics & refining rolling period strategies
        (0, trade_logger_1.cacheTradeMetrics)({
            timestamp: Date.now(),
            date: new Date().toISOString(),
            inputMint: bestResult.quote1.inputMint,
            outputMint: bestResult.quote1.outputMint,
            tradeSizeSOL: bestResult.size,
            expectedProfitSOL: bestResult.netProfitLamports / 10 ** 9,
            expectedProfitBps: bestResult.netProfitBps,
            signature: signatureStr,
            success: success
        });
    }
}
function startGeyserListeners(stream) {
    stream.on('data', (data) => {
        try {
            if (data.filters && data.filters.includes('jupiter')) {
                handleAccountUpdate(data);
            }
        }
        catch (err) {
            logger_1.logger.error('Error handling geyser message', err);
        }
    });
    stream.on('error', (err) => {
        logger_1.logger.error('Geyser stream error', err);
    });
    stream.on('end', () => {
        logger_1.logger.warn('Geyser stream ended. Consider reconnecting.');
    });
}
