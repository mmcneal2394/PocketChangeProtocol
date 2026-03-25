import fs from 'fs';
import path from 'path';
import { logger } from './logger';

const CACHE_FILE = path.join(__dirname, '../../logs/rolling_metrics.json');

export interface ArbitrageMetrics {
    timestamp: number;
    date: string;
    inputMint: string;
    outputMint: string;
    tradeSizeSOL: number;
    expectedProfitSOL: number;
    expectedProfitBps: number;
<<<<<<< HEAD
    signature?: string | null;
    success: boolean;
=======
    jitoTipLamports?: number;   // dynamic Jito tip paid (lamports)
    signature?: string | null;
    success: boolean;
    // [8] Telemetry
    quoteAgeMs?: number;        // ms to fetch both legs
    signalToExecMs?: number;    // ms from quote start to on-chain landing
>>>>>>> b98063db64e327d63401fc99bce9fd880aa4d97f
}

export function cacheTradeMetrics(metrics: ArbitrageMetrics) {
    try {
        if (!fs.existsSync(path.dirname(CACHE_FILE))) {
            fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        }
        
        let history: ArbitrageMetrics[] = [];
        if (fs.existsSync(CACHE_FILE)) {
            const data = fs.readFileSync(CACHE_FILE, 'utf-8');
            if (data) history = JSON.parse(data);
        }
        
        history.push(metrics);
        
        // Retain rolling 7-day period to prevent ENOSPC memory leaks
        const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
        const now = Date.now();
        history = history.filter(m => now - m.timestamp < SEVEN_DAYS);
        
        fs.writeFileSync(CACHE_FILE, JSON.stringify(history, null, 2));
    } catch (err) {
        logger.error("[CACHE] Failed to write rolling metrics:", err);
    }
}
