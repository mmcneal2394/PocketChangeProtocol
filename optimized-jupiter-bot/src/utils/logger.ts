const Database = require('better-sqlite3');
import { config } from './config';

export const logger = {
  info: (msg: string, ...args: any[]) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`, ...args),
  warn: (msg: string, ...args: any[]) => console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`, ...args),
  error: (msg: string, ...args: any[]) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, ...args),
  debug: (msg: string, ...args: any[]) => {
    if (process.env.DEBUG) {
      console.debug(`[DEBUG] ${new Date().toISOString()} - ${msg}`, ...args);
    }
  }
};

export interface LogEntry {
  timestamp: number;
  slot: number;
  opportunity: {
    type: string;
    route: string[];
    expectedIn: number;
    expectedOut: number;
    expectedProfitLamports: number;
    expectedProfitBps: number;
  };
  decision: 'executed' | 'skipped' | 'failed';
  actualOut?: number;
  actualProfitLamports?: number;
  jitoTipLamports: number;
  priorityFeeLamports: number;
  latencyMs: number;
  error?: string;
  priceBookSnapshot?: any;
}

const db = new Database(config.LOG_DB_PATH);
db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER,
        slot INTEGER,
        type TEXT,
        route TEXT,
        expected_in INTEGER,
        expected_out INTEGER,
        expected_profit INTEGER,
        expected_profit_bps INTEGER,
        decision TEXT,
        actual_out INTEGER,
        actual_profit INTEGER,
        jito_tip INTEGER,
        priority_fee INTEGER,
        latency_ms INTEGER,
        error TEXT,
        price_snapshot TEXT
    )
`);

<<<<<<< HEAD
=======
// ── Fix 4: SQLite log rotation (30-day retention) ─────────────────────────────
// Prevents unbounded row growth after weeks of live trading.
// Runs once at startup (clears any backlog) then every 24h.
// wal_checkpoint(TRUNCATE) reclaims the disk space immediately.
function rotateLogs() {
  try {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago in ms
    const r1 = db.prepare('DELETE FROM trades      WHERE timestamp < ?').run(cutoff);
    const r2 = db.prepare('DELETE FROM test_trades WHERE timestamp < ?').run(cutoff);
    const deleted = (r1.changes || 0) + (r2.changes || 0);
    if (deleted > 0) {
      db.pragma('wal_checkpoint(TRUNCATE)'); // reclaim disk space
      logger.info(`[LOGGER] Log rotation: deleted ${deleted} rows older than 30d`);
    }
  } catch (e: any) {
    logger.warn(`[LOGGER] Log rotation failed: ${e.message}`);
  }
}
rotateLogs();                                          // startup sweep
setInterval(rotateLogs, 24 * 60 * 60 * 1000);         // daily thereafter

>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f
db.exec(`
    CREATE TABLE IF NOT EXISTS test_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER,
        route_type TEXT,
        route TEXT,
        expected_in INTEGER,
        expected_out INTEGER,
        actual_out INTEGER,
        deviation REAL,
        success BOOLEAN,
        latency_ms INTEGER,
        txid TEXT,
        error TEXT
    )
`);

export function logTestTrade(entry: any) {
    try {
        const stmt = db.prepare(`
            INSERT INTO test_trades (
                timestamp, route_type, route, expected_in, expected_out,
                actual_out, deviation, success, latency_ms, txid, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            Date.now() * 1000,
            entry.type,
            JSON.stringify(entry.route),
            entry.expectedIn,
            entry.expectedOut,
            entry.actualOut,
            entry.deviation,
            entry.success ? 1 : 0,
            entry.latencyMs,
            entry.txid,
            entry.error || null
        );
    } catch (e: any) {
        logger.error(`Failed to SQLite logTestTrade: ${e.message}`);
    }
}

export function logTrade(entry: LogEntry) {
    try {
        const stmt = db.prepare(`
            INSERT INTO trades (
                timestamp, slot, type, route, expected_in, expected_out,
                expected_profit, expected_profit_bps, decision, actual_out,
                actual_profit, jito_tip, priority_fee, latency_ms, error, price_snapshot
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            entry.timestamp,
            entry.slot,
            entry.opportunity.type,
            JSON.stringify(entry.opportunity.route),
            entry.opportunity.expectedIn,
            entry.opportunity.expectedOut,
            entry.opportunity.expectedProfitLamports,
            entry.opportunity.expectedProfitBps,
            entry.decision,
            entry.actualOut,
            entry.actualProfitLamports,
            entry.jitoTipLamports,
            entry.priorityFeeLamports,
            entry.latencyMs,
            entry.error,
            entry.priceBookSnapshot ? JSON.stringify(entry.priceBookSnapshot) : null
        );
    } catch (e: any) {
        logger.error(`Failed to SQLite logTrade: ${e.message}`);
    }
}
