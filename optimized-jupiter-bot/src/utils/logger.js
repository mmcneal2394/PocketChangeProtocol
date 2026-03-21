"use strict";
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
exports.logTestTrade = logTestTrade;
exports.logTrade = logTrade;
var Database = require('better-sqlite3');
var config_1 = require("./config");
exports.logger = {
    info: function (msg) {
        var args = [];
        for (var _i = 1; _i < arguments.length; _i++) {
            args[_i - 1] = arguments[_i];
        }
        return console.log.apply(console, __spreadArray(["[INFO] ".concat(new Date().toISOString(), " - ").concat(msg)], args, false));
    },
    warn: function (msg) {
        var args = [];
        for (var _i = 1; _i < arguments.length; _i++) {
            args[_i - 1] = arguments[_i];
        }
        return console.warn.apply(console, __spreadArray(["[WARN] ".concat(new Date().toISOString(), " - ").concat(msg)], args, false));
    },
    error: function (msg) {
        var args = [];
        for (var _i = 1; _i < arguments.length; _i++) {
            args[_i - 1] = arguments[_i];
        }
        return console.error.apply(console, __spreadArray(["[ERROR] ".concat(new Date().toISOString(), " - ").concat(msg)], args, false));
    },
    debug: function (msg) {
        var args = [];
        for (var _i = 1; _i < arguments.length; _i++) {
            args[_i - 1] = arguments[_i];
        }
        if (process.env.DEBUG) {
            console.debug.apply(console, __spreadArray(["[DEBUG] ".concat(new Date().toISOString(), " - ").concat(msg)], args, false));
        }
    }
};
var db = new Database(config_1.config.LOG_DB_PATH);
db.exec("\n    CREATE TABLE IF NOT EXISTS trades (\n        id INTEGER PRIMARY KEY AUTOINCREMENT,\n        timestamp INTEGER,\n        slot INTEGER,\n        type TEXT,\n        route TEXT,\n        expected_in INTEGER,\n        expected_out INTEGER,\n        expected_profit INTEGER,\n        expected_profit_bps INTEGER,\n        decision TEXT,\n        actual_out INTEGER,\n        actual_profit INTEGER,\n        jito_tip INTEGER,\n        priority_fee INTEGER,\n        latency_ms INTEGER,\n        error TEXT,\n        price_snapshot TEXT\n    )\n");
db.exec("\n    CREATE TABLE IF NOT EXISTS test_trades (\n        id INTEGER PRIMARY KEY AUTOINCREMENT,\n        timestamp INTEGER,\n        route_type TEXT,\n        route TEXT,\n        expected_in INTEGER,\n        expected_out INTEGER,\n        actual_out INTEGER,\n        deviation REAL,\n        success BOOLEAN,\n        latency_ms INTEGER,\n        txid TEXT,\n        error TEXT\n    )\n");
function logTestTrade(entry) {
    try {
        var stmt = db.prepare("\n            INSERT INTO test_trades (\n                timestamp, route_type, route, expected_in, expected_out,\n                actual_out, deviation, success, latency_ms, txid, error\n            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n        ");
        stmt.run(Date.now() * 1000, entry.type, JSON.stringify(entry.route), entry.expectedIn, entry.expectedOut, entry.actualOut, entry.deviation, entry.success ? 1 : 0, entry.latencyMs, entry.txid, entry.error || null);
    }
    catch (e) {
        exports.logger.error("Failed to SQLite logTestTrade: ".concat(e.message));
    }
}
function logTrade(entry) {
    try {
        var stmt = db.prepare("\n            INSERT INTO trades (\n                timestamp, slot, type, route, expected_in, expected_out,\n                expected_profit, expected_profit_bps, decision, actual_out,\n                actual_profit, jito_tip, priority_fee, latency_ms, error, price_snapshot\n            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n        ");
        stmt.run(entry.timestamp, entry.slot, entry.opportunity.type, JSON.stringify(entry.opportunity.route), entry.opportunity.expectedIn, entry.opportunity.expectedOut, entry.opportunity.expectedProfitLamports, entry.opportunity.expectedProfitBps, entry.decision, entry.actualOut, entry.actualProfitLamports, entry.jitoTipLamports, entry.priorityFeeLamports, entry.latencyMs, entry.error, entry.priceBookSnapshot ? JSON.stringify(entry.priceBookSnapshot) : null);
    }
    catch (e) {
        exports.logger.error("Failed to SQLite logTrade: ".concat(e.message));
    }
}
