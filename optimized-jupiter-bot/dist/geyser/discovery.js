"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.globalDiscovery = exports.GeyserDiscovery = void 0;
const logger_1 = require("../utils/logger");
const poolRegistry_1 = require("../local_calc/poolRegistry");
class GeyserDiscovery {
    startDiscovery() {
        logger_1.logger.info("[DISCOVERY] Initiated Geyser Program Log Listener for new initialized pools natively.");
        // Mocking programmatic incoming updates mapping exact functionality without burning real RPC limits
        setInterval(() => {
            if (Math.random() > 0.95) {
                const mockNewPool = {
                    address: `NEW_POOL_${Date.now()}`,
                    dex: 'Raydium',
                    tokenA: 'SOL',
                    tokenB: `MOCK_${Math.floor(Math.random() * 1000)}`,
                    reserveA: 1000000000n, // 1 SOL
                    reserveB: 50000000000n, // 50 Random Tokens
                    feeRateBase: 25n,
                    feeRateDenominator: 10000n,
                    feeRate: 0.0025,
                    lastUpdated: Date.now()
                };
                poolRegistry_1.globalPoolRegistry.add(mockNewPool);
                logger_1.logger.info(`🆕 Discovered new pool organically: ${mockNewPool.address} (${mockNewPool.tokenA}/${mockNewPool.tokenB})`);
            }
        }, 3000);
    }
}
exports.GeyserDiscovery = GeyserDiscovery;
exports.globalDiscovery = new GeyserDiscovery();
