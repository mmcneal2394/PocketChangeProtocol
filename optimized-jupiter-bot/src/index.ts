import { createGeyserClient } from './geyser/client';
import { startGeyserListeners } from './geyser/handlers';
import { startBlockhashCache } from './jupiter/cache';
import { logger } from './utils/logger';

async function main() {
  logger.info('Starting Optimized Jupiter Arbitrage Bot...');

  // Start building cache
  logger.info('Initializing fast-path caching...');
  await startBlockhashCache();

  // Initialize Geyser gRPC connection
  logger.info('Connecting to Chainstack Geyser gRPC...');
  try {
    const { stream } = await createGeyserClient();
    
    logger.info('Attaching gRPC stream handlers...');
    startGeyserListeners(stream);

    logger.info('Bot is successfully running and waiting for stream updates.');
  } catch (error) {
    logger.error('Failed to start bot due to Geyser connection issue:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error('Fatal unhandled exception:', error);
  process.exit(1);
});
