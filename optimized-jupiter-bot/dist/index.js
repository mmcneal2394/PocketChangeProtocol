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
const client_1 = require("./geyser/client");
const handlers_1 = require("./geyser/handlers");
const logger_1 = require("./utils/logger");
async function main() {
    logger_1.logger.info('Starting Optimized Jupiter Arbitrage Bot...');
    // Start building cache
    logger_1.logger.info(`Starting highly optimized JUPBOT engine using AMSTERDAM bypass...`);
    // Initialize Geyser gRPC connection
    logger_1.logger.info('Connecting to Chainstack Geyser gRPC...');
    try {
        const { stream } = await (0, client_1.createGeyserClient)();
        logger_1.logger.info('Attaching gRPC stream handlers...');
        (0, handlers_1.startGeyserListeners)(stream);
        logger_1.logger.info('Bot is successfully running and waiting for stream updates.');
        logger_1.logger.info('Live Geyser Listener securely active across Mainnet physical socket.');
        setTimeout(async () => {
            logger_1.logger.warn("🔥 [FORCED TEST START] Constructing comprehensive structural diagnostic trace explicitly via the core Arbitrage Engine natively (SOL -> USDC -> SOL)...");
            const { globalArbEngine } = await Promise.resolve().then(() => __importStar(require('./local_calc/arb_engine')));
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
            logger_1.logger.info("✅ [FORCED TEST COMPLETE] Engine securely reverted to mathematically-limited physical Geyser scanner.");
        }, 8000);
    }
    catch (error) {
        logger_1.logger.error('Failed to start bot due to Geyser connection issue:', error);
        process.exit(1);
    }
}
main().catch((error) => {
    logger_1.logger.error('Fatal unhandled exception:', error);
    process.exit(1);
});
