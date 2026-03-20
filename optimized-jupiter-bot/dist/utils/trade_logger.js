"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.cacheTradeMetrics = cacheTradeMetrics;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const logger_1 = require("./logger");
const CACHE_FILE = path_1.default.join(__dirname, '../../logs/rolling_metrics.json');
function cacheTradeMetrics(metrics) {
    try {
        if (!fs_1.default.existsSync(path_1.default.dirname(CACHE_FILE))) {
            fs_1.default.mkdirSync(path_1.default.dirname(CACHE_FILE), { recursive: true });
        }
        let history = [];
        if (fs_1.default.existsSync(CACHE_FILE)) {
            const data = fs_1.default.readFileSync(CACHE_FILE, 'utf-8');
            if (data)
                history = JSON.parse(data);
        }
        history.push(metrics);
        // Retain rolling 7-day period to prevent ENOSPC memory leaks
        const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        history = history.filter(m => now - m.timestamp < SEVEN_DAYS);
        fs_1.default.writeFileSync(CACHE_FILE, JSON.stringify(history, null, 2));
    }
    catch (err) {
        logger_1.logger.error("[CACHE] Failed to write rolling metrics:", err);
    }
}
