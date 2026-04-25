import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import RedisBus from '../../src/utils/redis_bus';
import { CHANNELS } from '../../src/shared/redis_config';
import { runAgent } from './gemma4_agent';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const JOURNAL_PATH = path.join(process.cwd(), 'signals', process.env.PAPER_MODE === 'true' ? 'trade_journal_paper.jsonl' : 'trade_journal.jsonl');
const MIN_SAMPLE_SIZE = 5; // Start adjusting once we have at least 5 wins
const CONTROL_BASE_URL =
    process.env.HIVE_CONTROL_BASE_URL?.trim()?.replace(/\/+$/, '') ||
    process.env.PCP_HIVE_CONTROL_BASE_URL?.trim()?.replace(/\/+$/, '') ||
    '';

interface Trade {
    action: string;
    pnlSol?: number;
    heldMs?: number;
    momentum1m?: number;
    tokenAgeSec?: number;
    ts: number;
}

function calculatePercentile(arr: number[], p: number): number {
    if (arr.length === 0) return 0;
    arr.sort((a, b) => a - b);
    const index = (p / 100) * (arr.length - 1);
    if (Math.floor(index) === index) return arr[index];
    const i = Math.floor(index);
    const fraction = index - i;
    return arr[i] + (arr[i + 1] - arr[i]) * fraction;
}

async function postControlUpdate(payload: Record<string, unknown>, label: string) {
    if (!CONTROL_BASE_URL) {
        console.log(`[HIVE-MIND] Skipping ${label}: HIVE_CONTROL_BASE_URL is not configured.`);
        return false;
    }

    await fetch(`${CONTROL_BASE_URL}/config-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    return true;
}

async function fetchTradeSamples(filter: string, limit: number) {
    if (!CONTROL_BASE_URL) {
        console.log(`[HIVE-MIND] Skipping mistake analysis fetch: HIVE_CONTROL_BASE_URL is not configured.`);
        return null;
    }

    const res = await fetch(`${CONTROL_BASE_URL}/trades?filter=${encodeURIComponent(filter)}&limit=${limit}`);
    if (!res.ok) {
        throw new Error(`Failed to fetch trades: ${res.status}`);
    }
    return res.json() as Promise<any[]>;
}

async function clearRemoteTrades() {
    if (!CONTROL_BASE_URL) return;

    await fetch(`${CONTROL_BASE_URL}/trades`, { method: 'DELETE' });
}

async function runHiveAnalysis() {
    try {
        if (!fs.existsSync(JOURNAL_PATH)) return;

        const lines = fs.readFileSync(JOURNAL_PATH, 'utf-8').trim().split('\n');
        const trades: Trade[] = [];
        
        for (const line of lines) {
            if (!line) continue;
            try {
                trades.push(JSON.parse(line));
            } catch (e) {}
        }

        const sellTrades = trades.filter(t => t.action === 'SELL' && t.pnlSol !== undefined);
        const winTrades = sellTrades.filter(t => t.pnlSol! > 0);
        
        // Base AI Parameters
        let minSpreadOverride = parseFloat(process.env.MIN_SPREAD_PCT || '1.5');
        let priorityFeeOverride = parseInt(process.env.PRIORITY_FEE_MICROLAMPORTS || '50000');
        
        // 0. DROUGHT RECOVERY (If we aren't getting trades, organically adjust bounds!)
        const oneHourAgo = Date.now() - 3600000;
        const recentTradesArr = trades.filter(t => t.ts > oneHourAgo);
        
        if (recentTradesArr.length === 0) {
            console.log(`[HIVE-MIND] 🏜️ TRADE DROUGHT DETECTED (0 trades in last 1hr). Loosening parameters organically.`);
            minSpreadOverride = Math.max(0.5, minSpreadOverride - 0.2); // Lower spread requirement by 0.2%
            priorityFeeOverride = Math.min(1000000, priorityFeeOverride + 25000); // 25k lamports boost to gas
        } else if (recentTradesArr.length > 20) {
            console.log(`[HIVE-MIND] 🌊 HIGH VELOCITY DETECTED (>20 trades/hr). Tightening protection.`);
            minSpreadOverride = Math.min(3.0, minSpreadOverride + 0.2); 
        }

        if (winTrades.length < MIN_SAMPLE_SIZE) {
            console.log(`[HIVE-MIND] Collecting target data... (${winTrades.length}/${MIN_SAMPLE_SIZE} wins required for optimization layer). Droplet config updated for starvation recovery.`);
            // DO NOT RETURN! We must push the updated gas/spread parameters to the Droplet!
        }

        // 1. DYNAMIC HOLD OPTIMIZATION (P75 of winning hold times)
        const heldTimes = winTrades.map(t => t.heldMs!).filter(v => v > 0);
        let maxHoldMin = 2; // Default max
        if (heldTimes.length >= MIN_SAMPLE_SIZE) {
            const p75Ms = calculatePercentile(heldTimes, 75);
            // Cap it between 1 and 2 minutes
            maxHoldMin = Math.max(1, Math.min(2, p75Ms / 60000));
        }

        // 2. FEATURE REGRESSION MAPPING (Mom1m & Age)
        const mom1mArr = winTrades.map(t => t.momentum1m!).filter(v => v !== undefined && !isNaN(v));
        const ageSecArr = winTrades.map(t => t.tokenAgeSec!).filter(v => v !== undefined && !isNaN(v));

        let minMom1m = process.env.SNIPER_MIN_1M ? parseFloat(process.env.SNIPER_MIN_1M) : 5; // Defaults
        let maxAgeMin = parseFloat(process.env.SNIPER_MAX_AGE || '525600');

        if (mom1mArr.length >= MIN_SAMPLE_SIZE) {
            // we want the floor of average winning momentum
            const avgMom1m = mom1mArr.reduce((a, b) => a + b, 0) / mom1mArr.length;
            // E.g. If avg winning mom is 20%, maybe set floor to 10%
            minMom1m = Math.max(minMom1m, avgMom1m * 0.5);
        }

        if (ageSecArr.length >= MIN_SAMPLE_SIZE) {
            // 80% percentile of winning token age 
            const p80AgeSec = calculatePercentile(ageSecArr, 80);
            maxAgeMin = Math.max(1, p80AgeSec / 60); // Don't allow less than 1 min
        }

        // 3. TIME OF DAY REGIME FILTERING
        const hourlyWins: Record<number, number> = {};
        const hourlyLosses: Record<number, number> = {};
        
        sellTrades.forEach(t => {
            const date = new Date(t.ts);
            const hour = date.getUTCHours();
            if (t.pnlSol! > 0) {
                hourlyWins[hour] = (hourlyWins[hour] || 0) + 1;
            } else {
                hourlyLosses[hour] = (hourlyLosses[hour] || 0) + 1;
            }
        });

        const currentHour = new Date().getUTCHours();
        const winsThisHour = hourlyWins[currentHour] || 0;
        const lossesThisHour = hourlyLosses[currentHour] || 0;
        const totalThisHour = winsThisHour + lossesThisHour;
        
        let slOverride = parseFloat(process.env.STOP_LOSS_PERCENT || '50') / 100;
        let baseSizeOverride = parseFloat(process.env.SNIPER_BUY_PCT || '0.10');
        
        // If we have at least 5 trades in this UTC hour historically, and WR < 25% -> Enter Defensive Setup
        if (totalThisHour >= 5) {
            const wr = winsThisHour / totalThisHour;
            if (wr < 0.25) {
                console.log(`[HIVE-MIND] 🚨 TOXIC REGIME DETECTED: Hour ${currentHour} UTC has a ${wr*100}% Win Rate! Tightening bounds...`);
                slOverride *= 0.5; // Cut SL liability
                baseSizeOverride *= 0.5; // Cut position sizing
            }
        }

        // Broadcast the Pheromone Packet
        const payload = {
            maxHoldMinutes: Math.round(maxHoldMin * 10) / 10,
            dynamicMinMom1m: Math.round(minMom1m * 10) / 10,
            dynamicMaxAgeMin: Math.round(maxAgeMin * 10) / 10,
            stopLossPct: slOverride,
            maxTPpct: parseFloat(process.env.MAX_TP_PERCENT || '8') / 100,
            BASE_BUY_PCT: baseSizeOverride,
            MIN_SPREAD_PCT: minSpreadOverride,
            PRIORITY_FEE_MICROLAMPORTS: priorityFeeOverride
        };

        console.log(`[HIVE-MIND] 🐜 Broadcasting Overrides to Swarm:`, payload);
        
        const isDryRun = process.argv.includes('--dry-run');
        if (isDryRun) {
            console.log(`[HIVE-MIND] Dry-run: would send parameter update to Droplet`);
        } else {
            try {
                const sent = await postControlUpdate(payload, 'parameter broadcast');
                if (sent) {
                    console.log(`[HIVE-MIND] ✅ Sent payload to remote execution controller`);
                }
            } catch (e: any) {
                console.error(`[HIVE-MIND] ❌ Failed to bridge remote update.`, e.message);
            }
        }
        
        // Gemma 4 Offloaded Analytics
        console.log(`[HIVE-MIND] 🧠 Requesting Gemma 4 Synthesis Analysis...`);
        const recentTrades = trades.slice(-10);
        const prompt = `As an expert trading strategist, analyze the following trade journal snippet to propose parameter adjustments for the trading swarm.
        
        Trade Journal: ${JSON.stringify(recentTrades)}
        Current Hour Payload: ${JSON.stringify(payload)}
        
        Be concise. List 2-3 specific parameter changes.`;
        
        const gemmaResult = await runAgent(prompt);
        if (gemmaResult) {
            console.log(`[HIVE-MIND] 💎 Gemma Insight:\n${gemmaResult}`);
        }

    } catch (error: any) {
        console.error(`[HIVE-MIND] Processing Error: ${error.message}`);
    }
}

async function learnFromMistakes() {
    try {
        console.log(`[HIVE-MIND] 📚 Fetching losing trades for mistake analysis...`);

        const losingTrades = await fetchTradeSamples('loss', 10);
        if (!losingTrades) return;
        if (losingTrades.length === 0) {
            console.log(`[HIVE-MIND] ✅ No losing trades found — nothing to learn from.`);
            return;
        }

        console.log(`[HIVE-MIND] 🔍 Analyzing ${losingTrades.length} losing trades with Gemma 4...`);

        const prompt = `
You are a profit-focused trading strategist. Review the last 10 losing trades.
Losing trades often failed to take profit early.

Your goal: adjust parameters to take solid profits in the +5% to +15% range, not hold for 50%+ gains that rarely materialize.

Current parameters:
- takeProfitPercent: 20
- trailingStopPercent: 50
- stopLossPercent: 20
- maxHoldMinutes: 10

Losing trades:
${JSON.stringify(losingTrades, null, 2)}

Return a JSON with:
- "takeProfitPercent": number (suggest between 5 and 12)
- "trailingStopPercent": number (suggest between 2 and 5)
- "stopLossPercent": number (suggest between 8 and 10)
- "maxHoldMinutes": number (suggest between 2 and 5)
- "reasoning": string

Do not return any markdown formatting outside of the json block. Return pure JSON.
`;

        const analysis = await runAgent(prompt);
        if (analysis) {
            console.log(`[HIVE-MIND] 🎓 Mistake Analysis:\n${analysis}`);
            try {
                // Extract JSON if it's wrapped in markdown
                const jsonMatch = analysis.match(/\{[\s\S]*\}/);
                const jsonString = jsonMatch ? jsonMatch[0] : analysis;
                const advice = JSON.parse(jsonString);
                
                // Construct the payload matching the /config-update handler
                const payload = {
                    takeProfitPercent: advice.takeProfitPercent,
                    trailingStopPercent: advice.trailingStopPercent,
                    stopLossPct: advice.stopLossPercent / 100,
                    maxHoldMinutes: advice.maxHoldMinutes
                };

                const sent = await postControlUpdate(payload, 'mistake-analysis tuning');
                if (sent) {
                    console.log(`[HIVE-MIND] ✅ Sent aggressive Gemma 4 tuning to remote controller.`);
                }
            } catch(e: any) {
                console.warn(`[HIVE-MIND] ⚠️ Failed to parse or send JSON from Gemma:`, e.message);
            }
        }

        // Clean up remote disk space by deleting logs after refining
        try {
            await clearRemoteTrades();
            console.log(`[HIVE-MIND] 🧹 Cleared remote trade samples after refinement.`);
        } catch (e: any) {
            console.error(`[HIVE-MIND] Failed to clear remote trade samples: ${e.message}`);
        }
    } catch (e: any) {
        console.error(`[HIVE-MIND] ❌ learnFromMistakes error: ${e.message}`);
    }
}

// Daemon execution loop
async function initialize() {
    console.log("==========================================");
    console.log(" 🐜 PCP HIVE-MIND PHEROMONE AGENT ONLINE 🐜 ");
    console.log("==========================================");
    
    const isDryRun = process.argv.includes('--dry-run');
    await runHiveAnalysis();
    
    if (!isDryRun) {
        setInterval(runHiveAnalysis, 60_000 * 5);        // Tune params every 5 min
        setInterval(learnFromMistakes, 60_000 * 30);      // Learn from mistakes every 30 min
        await learnFromMistakes();                         // Run once immediately
    } else {
        console.log("[HIVE-MIND] Dry run complete, exiting.");
        process.exit(0);
    }
}

initialize();
