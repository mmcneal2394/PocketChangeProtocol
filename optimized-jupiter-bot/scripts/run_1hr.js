require('dotenv').config();
const { globalArbEngine } = require('../dist/local_calc/arb_engine');
const { globalPriceBook } = require('../dist/local_calc/price_book');
const { logger } = require('../dist/utils/logger');
const fs = require('fs');

logger.info("🏁 Initiating 1-Hour Micro-Amount Arbitrage Refinement Test...");

async function loop() {
    await globalArbEngine.runArbitrageScan();
}

setTimeout(async () => {
    logger.info("[BOOT] Executing initial boot test trace dynamically!");
    try {
        await globalArbEngine['executeArbitrage']({ type: 'Simple-2-Hop-Test', expectedInSol: 0.001, tipAmount: 0.002, grossProfitSol: 0, netProfit: 0, pools: [] });
    } catch (e) {
        logger.error("Initial Test Trace failed: " + e.message);
    }
}, 6000);

// Run scan continuously every 1 second
setInterval(loop, 1000);

// 1 Hour = 3600000 ms
setTimeout(() => {
    logger.info("✅ 1-Hour Verification Concluded. Exiting gracefully.");
    try {
        const db = require('better-sqlite3')('./trades.db');
        const row = db.prepare('SELECT COUNT(*) as c FROM trades').get();
        if (row && row.c > 0) {
            logger.info("Persisted " + row.c + " total evaluated trades over the 1-hour runtime.");
        }
    } catch(e) {}
    process.exit(0);
}, 3600000);
