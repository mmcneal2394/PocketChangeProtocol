"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchJupiterQuote = fetchJupiterQuote;
exports.getParallelSwapInstructions = getParallelSwapInstructions;
const config_1 = require("../utils/config");
const logger_1 = require("../utils/logger");
async function fetchJupiterQuote(inputToken, outputToken, amount) {
    try {
        const params = new URLSearchParams({
            inputMint: inputToken,
            outputMint: outputToken,
            amount: amount.toString(),
            slippageBps: config_1.config.SLIPPAGE_BPS.toString(),
            restrictIntermediateTokens: config_1.config.RESTRICT_INTERMEDIATE_TOKENS.toString(),
        });
        const quoteRes = await fetch(`${config_1.config.JUPITER_ENDPOINT}/quote?${params.toString()}`, {
            headers: { 'x-api-key': config_1.config.JUPITER_API_KEY }
        });
        if (!quoteRes.ok)
            throw new Error(`Quote failed: ${quoteRes.statusText}`);
        return await quoteRes.json();
    }
    catch (error) {
        logger_1.logger.error('Failed to fetching Jupiter quote:', error);
        return null;
    }
}
async function getParallelSwapInstructions(quote1, quote2) {
    try {
        const fetchSwap = (quoteParams) => fetch(`${config_1.config.JUPITER_ENDPOINT}/swap-instructions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": config_1.config.JUPITER_API_KEY,
            },
            body: JSON.stringify({
                quoteResponse: quoteParams,
                userPublicKey: config_1.config.WALLET_PUBLIC_KEY,
                wrapAndUnwrapSol: false,
                dynamicComputeUnitLimit: true,
            }),
        }).then(r => r.json());
        const [ix1, ix2] = await Promise.all([fetchSwap(quote1), fetchSwap(quote2)]);
        return { ix1, ix2 };
    }
    catch (error) {
        logger_1.logger.error('Failed to get swap instructions in parallel:', error);
        return null;
    }
}
