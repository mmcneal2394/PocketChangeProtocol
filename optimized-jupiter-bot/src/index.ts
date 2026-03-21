import { createGeyserClient } from './geyser/client';
import { startGeyserListeners } from './geyser/handlers';
import { logger } from './utils/logger';

async function main() {
  logger.info('Starting Optimized Jupiter Arbitrage Bot...');

  // Start building cache
  logger.info(`Starting highly optimized JUPBOT engine using AMSTERDAM bypass...`);

  // Initialize Geyser gRPC connection
  logger.info('Connecting to Chainstack Geyser gRPC...');
  try {
    const { stream } = await createGeyserClient();
    
    logger.info('Attaching gRPC stream handlers...');
    startGeyserListeners(stream);

    logger.info('Bot is successfully running and waiting for stream updates.');

    logger.info('Live Geyser Listener securely active across Mainnet physical socket.');

    setTimeout(async () => {
        logger.warn("🔥 [FORCED TEST START] Constructing comprehensive structural diagnostic trace explicitly via the core Arbitrage Engine natively (SOL -> USDC -> SOL)...");
        const { globalArbEngine } = await import('./local_calc/arb_engine');
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
        logger.info("✅ [FORCED TEST COMPLETE] Engine securely reverted to mathematically-limited physical Geyser scanner.");
    }, 8000);
  } catch (error) {
    logger.error('Failed to start bot due to Geyser connection issue:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error('Fatal unhandled exception:', error);
  process.exit(1);
});
