import * as http from 'http';
import * as https from 'https';
import RedisBus from '../../src/utils/redis_bus';
import { CHANNELS } from '../../src/shared/redis_config';
import { exec } from 'child_process';
import * as util from 'util';
import * as dotenv from 'dotenv';

dotenv.config();

const execAsync = util.promisify(exec);

// Polling interval mapped to 30s to respect GMGN API RPS limits while maintaining speed
const POLL_INTERVAL_SMART_MONEY = 30_000;

// Central cache to prevent looping over the same coins excessively
const knownMints = new Set<string>();

function pushVelocitySpike(mint: string, symbol: string, swaps: number, source: string) {
    if (knownMints.has(mint)) return;
    knownMints.add(mint);

    // Allow cache pruning to keep memory linear
    if (knownMints.size > 10000) knownMints.clear();

    const formattedPayload = {
        updatedAt: Date.now(),
        mints: {
            [mint]: {
                buys60s: swaps,
                sells60s: 0,
                buyRatio60s: 1.0,         
                velocity: swaps,           
                isAccelerating: true,
                solVolume60s: 0,
                symbol: symbol
            }
        }
    };

    RedisBus.publish(CHANNELS.VELOCITY_SPIKE, formattedPayload)
        .then(() => {
            console.log(`[DISCOVERY][${source}] Ingested token: ${symbol} (${mint}) (True 1m Swaps: ${swaps})`);
        })
        .catch((e: any) => {
            console.error(`[DISCOVERY] Redis publish failed:`, e.message);
        });
}

// ── GMGN SMART MONEY PIPELINE ────────────────────────────────────────────────
async function pollGmgnSmartMoney() {
    try {
        // We use the universal 'market trenches' command to query near_completion and completed tokens
        // heavily filtered for Smart money holding, omitting wash-trading rugs
        const command = `gmgn-cli market trenches --chain sol --type near_completion --type completed --filter-preset smart-money --min-smart-degen-count 1 --sort-by smart_degen_count --limit 10 --raw | cat`;
        
        // Ensure API Key is passed locally, and forcefully disable CLI spinners / UI
        const envParams: any = { ...process.env, CI: '1', NO_COLOR: '1', TERM: 'dumb' };
        if (!envParams.GMGN_API_KEY) {
            console.warn(`[DISCOVERY][GMGN] ⚠️ GMGN_API_KEY not found in environment! Requests may be restricted.`);
        }

        const { stdout, stderr } = await execAsync(command, { env: envParams, maxBuffer: 1024 * 1024 * 5 }); 
        
        if (stderr && !stdout) {
             throw new Error(`CLI Error: ${stderr}`);
        }

        // Parse CLI output safely using regex to extract JSON blob amidst potential CLI spinners/noise
        let parsedData: any = null;
        let cleanStdout = stdout.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
        const jsonMatch = cleanStdout.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                parsedData = JSON.parse(jsonMatch[0]);
            } catch(e: any) {
                console.warn(`[DISCOVERY][GMGN] Failed to parse matched JSON: ${e.message}`);
            }
        }

        if (!parsedData) {
             console.log(`[DISCOVERY][GMGN] Malformed or empty GMGN CLI response. Skipping poll.`);
             return;
        }

        const payload = parsedData.data || parsedData;

        const tokensRaw = [];
        if (Array.isArray(payload.pump)) tokensRaw.push(...payload.pump);
        if (Array.isArray(payload.completed)) tokensRaw.push(...payload.completed);

        let viableTargets = 0;

        for (const token of tokensRaw) {
             // LAST STAND MODE: Hard drop condition for known wash-trading flags or explicit rug ratios
             if (token.is_wash_trading === true) continue;
             if (typeof token.rug_ratio === 'number' && token.rug_ratio > 0.10) continue; // max 10% tolerance!

             const smartCount = token.smart_degen_count || 0;
             if (smartCount < 5) continue; // 5x Smart Money tracking wallets required!

             const mint = token.address;
             // Ensure the on-chain velocity is populated through token swaps in the last 1 minute, default to 1h / 60 if null
             const swaps1m = token.swaps_1m || Math.floor((token.swaps_1h || 0) / 60) || 5; 
             const tokenSymbol = token.symbol || mint.slice(0, 8);

             if (mint) {
                 pushVelocitySpike(mint, tokenSymbol, swaps1m, `GMGN-SMART[${smartCount}x]`);
                 viableTargets++;
             }
        }

        if (viableTargets === 0) {
             console.log(`[DISCOVERY][GMGN] 0 high-tier targets found traversing GMGN Smart Money Pipeline. Holding...`);
        }

    } catch (e: any) {
        console.warn(`[DISCOVERY][GMGN] Polling fault: ${e.message}`);
    }
}

async function start() {
    console.log(`╔══════════════════════════════════════════╗`);
    console.log(`║     PCP DISCOVERY ENGINE ONLINE v1.5     ║`);
    console.log(`║     Sources: 🦅 GMGN.ai (Smart Money)     ║`);
    console.log(`╚══════════════════════════════════════════╝`);
    
    // Initial fetch
    pollGmgnSmartMoney();

    setInterval(pollGmgnSmartMoney, POLL_INTERVAL_SMART_MONEY);
}

start();
