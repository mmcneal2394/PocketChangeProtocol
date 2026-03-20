import Database from 'better-sqlite3';
import { config } from '../src/utils/config';
import { logger } from '../src/utils/logger';

const db = new Database(config.LOG_DB_PATH || './trades.db');

export function runDailyRefinement() {
    logger.info("=========================================");
    logger.info("   🚀 DAILY ARBITRAGE REFINEMENT REPORT  ");
    logger.info("=========================================\n");

    const now = Date.now() * 1000; // microsecond timestamp format used in logger
    const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000 * 1000);
    const thirtyDaysAgo = now - (30 * 24 * 60 * 60 * 1000 * 1000);

    try {
        // 1. Overall Win Rate & Profitability by Route Type
        const winRates = db.prepare(`
            SELECT type, 
                   COUNT(*) as total,
                   SUM(CASE WHEN decision='executed' AND expected_profit > 0 THEN 1 ELSE 0 END) as wins,
                   AVG(expected_profit) as avg_expected_profit,
                   AVG(latency_ms) as avg_latency
            FROM trades
            WHERE timestamp > ?
            GROUP BY type
        `).all(sevenDaysAgo) as any[];

        logger.info("📊 --- WIN RATE BY STRATEGY (LAST 7 DAYS) ---");
        winRates.forEach(row => {
            const winRate = row.total > 0 ? (row.wins / row.total) * 100 : 0;
            logger.info(`[${row.type}] Total Trades: ${row.total} | Win Rate: ${winRate.toFixed(2)}% | Avg Net Expected: ${(row.avg_expected_profit / 1e9).toFixed(5)} SOL | Avg Latency: ${row.avg_latency?.toFixed(2)}ms`);
        });

        // 2. Optimal Tip Percentage Analysis
        const tipEfficiency = db.prepare(`
            SELECT 
                CAST((jito_tip * 1.0) / expected_profit * 10 AS INTEGER) / 10.0 as tip_ratio_bucket,
                COUNT(*) as attempts,
                SUM(CASE WHEN decision='executed' THEN 1 ELSE 0 END) as successes
            FROM trades
            WHERE expected_profit > 0 AND timestamp > ?
            GROUP BY tip_ratio_bucket
            ORDER BY tip_ratio_bucket
        `).all(sevenDaysAgo) as any[];

        logger.info("\n💰 --- OPTIMAL TIP EFFICIENCY (LAST 7 DAYS) ---");
        tipEfficiency.forEach(row => {
            const successRate = row.attempts > 0 ? (row.successes / row.attempts) * 100 : 0;
            logger.info(`Tip Ratio Bucket: ${row.tip_ratio_bucket * 100}% | Attempts: ${row.attempts} | Success Rate: ${successRate.toFixed(1)}%`);
        });

        // 3. Anomaly Detection (High Spread, but Failed or Skipped)
        const anomalies = db.prepare(`
            SELECT id, type, expected_profit, latency_ms, decision, error
            FROM trades
            WHERE expected_profit > 50000000 -- Over 0.05 SOL Expected Net
              AND decision != 'executed'
              AND timestamp > ?
            ORDER BY expected_profit DESC
            LIMIT 5
        `).all(sevenDaysAgo) as any[];

        if (anomalies.length > 0) {
            logger.warn("\n⚠️ --- ANOMALY DETECTION (PROFITABLE BUT MISHANDLED) ---");
            anomalies.forEach(row => {
               logger.warn(`ID: ${row.id} [${row.type}] | Expected: ${(row.expected_profit / 1e9).toFixed(4)} SOL | Latency: ${row.latency_ms?.toFixed(2)}ms | Decision: ${row.decision} | Error: ${row.error || 'None'}`);
            });
        } else {
            logger.info("\n✅ No massive profitable anomalies skipped/failed recently.");
        }

        // 4. Maintenance / 30-Day DB Purge
        logger.info("\n🧹 --- DATABASE MAINTENANCE ---");
        const purgeResult = db.prepare(`
            DELETE FROM trades WHERE timestamp < ?
        `).run(thirtyDaysAgo);
        
        // Use SQLite VACUUM to physically free unallocated disk space dynamically protecting the 50GB limit
        db.exec("VACUUM;");
        
        logger.info(`Deleted ${purgeResult.changes} trade logs older than 30 days. Reclaimed physical disk space cleanly.`);

    } catch (e: any) {
        logger.error(`Refinement query failed: ${e.message}`);
    }

    logger.info("\n=========================================");
}

// Automatically execute script if run directly
if (require.main === module) {
    runDailyRefinement();
}
