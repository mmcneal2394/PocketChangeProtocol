"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("./geyser/client");
const handlers_1 = require("./geyser/handlers");
const cache_1 = require("./jupiter/cache");
const logger_1 = require("./utils/logger");
async function main() {
    logger_1.logger.info('Starting Optimized Jupiter Arbitrage Bot...');
    // Start building cache
    logger_1.logger.info('Initializing fast-path caching...');
    await (0, cache_1.startBlockhashCache)();
    // Initialize Geyser gRPC connection
    logger_1.logger.info('Connecting to Chainstack Geyser gRPC...');
    try {
        const { stream } = await (0, client_1.createGeyserClient)();
        logger_1.logger.info('Attaching gRPC stream handlers...');
        (0, handlers_1.startGeyserListeners)(stream);
        logger_1.logger.info('Bot is successfully running and waiting for stream updates.');
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
