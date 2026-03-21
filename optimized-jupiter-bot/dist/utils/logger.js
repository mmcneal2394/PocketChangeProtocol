"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
exports.logTestTrade = logTestTrade;
exports.logTrade = logTrade;
const Database = require('better-sqlite3');
const config_1 = require("./config");
exports.logger = {
    info: (msg, ...args) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`, ...args),
    warn: (msg, ...args) => console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`, ...args),
    error: (msg, ...args) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`, ...args),
    debug: (msg, ...args) => {
        if (process.env.DEBUG) {
            console.debug(`[DEBUG] ${new Date().toISOString()} - ${msg}`, ...args);
        }
    }
};
const db = new Database(config_1.config.LOG_DB_PATH);
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
function logTestTrade(entry) {
    try {
        const stmt = db.prepare(`
            INSERT INTO test_trades (
                timestamp, route_type, route, expected_in, expected_out,
                actual_out, deviation, success, latency_ms, txid, error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(Date.now() * 1000, entry.type, JSON.stringify(entry.route), entry.expectedIn, entry.expectedOut, entry.actualOut, entry.deviation, entry.success ? 1 : 0, entry.latencyMs, entry.txid, entry.error || null);
    }
    catch (e) {
        exports.logger.error(`Failed to SQLite logTestTrade: ${e.message}`);
    }
}
function logTrade(entry) {
    try {
        const stmt = db.prepare(`
            INSERT INTO trades (
                timestamp, slot, type, route, expected_in, expected_out,
                expected_profit, expected_profit_bps, decision, actual_out,
                actual_profit, jito_tip, priority_fee, latency_ms, error, price_snapshot
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(entry.timestamp, entry.slot, entry.opportunity.type, JSON.stringify(entry.opportunity.route), entry.opportunity.expectedIn, entry.opportunity.expectedOut, entry.opportunity.expectedProfitLamports, entry.opportunity.expectedProfitBps, entry.decision, entry.actualOut, entry.actualProfitLamports, entry.jitoTipLamports, entry.priorityFeeLamports, entry.latencyMs, entry.error, entry.priceBookSnapshot ? JSON.stringify(entry.priceBookSnapshot) : null);
    }
    catch (e) {
        exports.logger.error(`Failed to SQLite logTrade: ${e.message}`);
    }
}
