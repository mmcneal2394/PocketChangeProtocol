import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import RedisBus from '../../src/utils/redis_bus';
import { CHANNELS } from '../../src/shared/redis_config';

const SIGNALS_DIR = path.join(process.cwd(), 'signals');
const LIVE_JOURNAL = path.join(SIGNALS_DIR, 'trade_journal.jsonl');
const PAPER_JOURNAL = path.join(SIGNALS_DIR, 'trade_journal_paper.jsonl');

// Baseline fallback config
let optimalTP = 0.20; // 20%
let optimalSL = 0.50; // 50%
let optimalHold = 10; // 10 minutes

async function processJournals() {
    const trades: any[] = [];

    const parseFile = async (filePath: string) => {
        if (!fs.existsSync(filePath)) return;
        
        const fileStream = fs.createReadStream(filePath);
        const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

        for await (const line of rl) {
            if (!line.trim()) continue;
            try {
                const trade = JSON.parse(line);
                if (trade.action === 'SELL' && typeof trade.pnlSol === 'number') {
                    trades.push(trade);
                }
            } catch (e) {}
        }
    };

    await parseFile(LIVE_JOURNAL);
    await parseFile(PAPER_JOURNAL);

    if (trades.length < 5) {
        console.log(`[TRAINER] Not enough historical trades (${trades.length}) to extract gradient data. Skipping optimization.`);
        return;
    }

    // Sort by most recent
    trades.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    
    // Analyze the last 50 trades
    const recentTrades = trades.slice(0, 50);
    const wins = recentTrades.filter(t => t.pnlSol > 0);
    const losses = recentTrades.filter(t => t.pnlSol <= 0);

    const winRate = wins.length / recentTrades.length;
    let netPnl = recentTrades.reduce((acc, t) => acc + t.pnlSol, 0);

    console.log(`[TRAINER] Analyzed last ${recentTrades.length} trades. WinRate: ${(winRate * 100).toFixed(1)}%. Net PnL: ${netPnl.toFixed(4)} SOL`);

    // Simple Reinforcement Heuristic
    if (winRate < 0.40 && netPnl < 0) {
        // High loss regime: Tighten Stop Loss & lower Target TP
        optimalTP = Math.max(0.10, optimalTP * 0.90);
        optimalSL = Math.max(0.20, optimalSL * 0.85); // 0.50 -> 0.42 -> 0.35 etc
        optimalHold = Math.max(5, optimalHold - 1);
        console.log(`[TRAINER] 🔻 High Loss Detected. Restricting parameters: TP ${(optimalTP*100).toFixed(1)}%, SL ${(optimalSL*100).toFixed(1)}%, Hold ${optimalHold}m`);
    } else if (winRate >= 0.60 && netPnl > 0) {
        // High win regime: Expand Take Profit and Loosen Stop Loss for Runners
        optimalTP = Math.min(1.00, optimalTP * 1.15); // Let winners run
        optimalSL = Math.min(0.60, optimalSL * 1.05); // Widen breathing room
        optimalHold = Math.min(30, optimalHold + 2); // Hold longer for larger runs
        console.log(`[TRAINER] 🚀 High Win Regime. Expanding parameters: TP ${(optimalTP*100).toFixed(1)}%, SL ${(optimalSL*100).toFixed(1)}%, Hold ${optimalHold}m`);
    } else {
        console.log(`[TRAINER] ⚖️ Stable Regime. Keeping parameters unchanged.`);
    }

    const compiledConfig = {
        maxTPpct: optimalTP,
        stopLossPct: optimalSL,
        maxHoldMinutes: optimalHold,
        timestamp: Date.now()
    };

    // Broadcast global configuration shift to all Active Sniper subsystems!
    try {
        await RedisBus.publish(CHANNELS.CONFIG_UPDATE, compiledConfig);
        console.log(`[TRAINER] 📡 Broadcasted new optimized profile to Swarm fleet.`);
    } catch(e) {
        console.log(`[TRAINER] ⚠️ Failed to broadcast config update.`);
    }
}

async function startDaemon() {
    console.log(`╔══════════════════════════════════════════╗`);
    console.log(`║      PCP TRAINER DAEMON ONLINE v1.0      ║`);
    console.log(`║     Ingesting Trade Journals for ML      ║`);
    console.log(`╚══════════════════════════════════════════╝`);
    
    // Initial Run
    await processJournals();

    // Optimize every 15 minutes mapped to historical PnL logs
    setInterval(async () => {
        try {
            await processJournals();
        } catch(e) {}
    }, 15 * 60 * 1000);
}

startDaemon();
