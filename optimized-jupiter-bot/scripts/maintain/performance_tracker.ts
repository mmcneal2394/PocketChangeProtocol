import RedisBus from '../../src/utils/redis_bus';
import { STREAMS, REDIS_KEYS } from '../../src/shared/redis_config';
import { exec } from 'child_process';
import * as util from 'util';
import * as dotenv from 'dotenv';

dotenv.config();

const execAsync = util.promisify(exec);

const TRACKING_WINDOW = 20;

async function fetchGmgnStats(): Promise<any> {
    try {
        const wallet = process.env.WALLET_PUBLIC_KEY || process.env.PUBLIC_KEY;
        if (!wallet) {
            console.warn(`[PERFORMANCE][GMGN] ⚠️ No WALLET_PUBLIC_KEY found! Stats request may fail.`);
        }
        
        const command = `npx -y gmgn-cli portfolio stats --chain sol --period 7d --wallet ${wallet} --raw | cat`;
        const envParams: any = { ...process.env, CI: '1', NO_COLOR: '1', TERM: 'dumb' };

        const { stdout, stderr } = await execAsync(command, { env: envParams, maxBuffer: 1024 * 1024 * 5 });
        
        if (stderr && !stdout) {
             throw new Error(`CLI Error: ${stderr}`);
        }

        let cleanStdout = stdout.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '');
        const jsonMatch = cleanStdout.match(/\{[\s\S]*\}/);
        
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }
        return null;
    } catch (e: any) {
        console.warn(`[PERFORMANCE][GMGN] Failed to fetch portfolio: ${e.message}`);
        return null;
    }
}

async function trackPerformance() {
    try {
        const pub = RedisBus.getPublisher();
        
        // Fetch trailing 20 trades from Redis Stream
        // XRANGE with - + gets all, but we just need XREVRANGE to get last N trades.
        // Format: XREVRANGE stream:trades + - COUNT 20
        const rawTrades = await pub.xrevrange(STREAMS.TRADES, '+', '-', 'COUNT', TRACKING_WINDOW);

        let wins = 0;
        let losses = 0;
        let grossProfit = 0;
        let grossLoss = 0;
        let totalDailyLossSol = 0; // For daily loss capping

        if (!rawTrades || rawTrades.length === 0) {
            console.log(`[PERFORMANCE] No internal trades mapped in ${STREAMS.TRADES} yet. Evaluating external GMGN state...`);
        } else {
            for (const [id, fields] of rawTrades) {
                // Redis streams return [id, [key1, val1, key2, val2]]
                const trade: any = {};
                for (let i = 0; i < fields.length; i += 2) {
                    trade[fields[i]] = fields[i + 1];
                }

                // Only evaluate SELLs for performance metrics (they contain realized PNL)
                if (trade.action === 'SELL' && trade.pnlSol) {
                    const pnl = parseFloat(trade.pnlSol);
                    totalDailyLossSol += pnl;

                    if (pnl > 0) {
                        wins++;
                        grossProfit += pnl;
                    } else {
                        losses++;
                        grossLoss += Math.abs(pnl);
                    }
                }
            }
        }

        const exactCount = wins + losses;

        const winRate = exactCount > 0 ? wins / exactCount : 0;
        const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? 999 : 0);
        const avgLoss = losses > 0 ? (grossLoss / losses) : 0;
        const avgWin = wins > 0 ? (grossProfit / wins) : 0;

        let throttleLevel = 'normal';
        let positionSizeMultiplier = 1.0;
        let minMomentumExtra = 0;
        let minVolumeExtra = 0;
        let circuitBreaker = false;

        // ── Adaptive Tiering ── 
        if (exactCount >= 10) {
            if (winRate < 0.25 || profitFactor < 0.5) {
                throttleLevel = 'conservative';
                positionSizeMultiplier = 0.5; // Halve position sizes
                minMomentumExtra = 2;         // Add 2% harder momentum req
                minVolumeExtra = 5000;
                
                if (profitFactor < 0.2 || winRate < 0.1) {
                    throttleLevel = 'pause';
                    circuitBreaker = true;
                }
            } else if (winRate > 0.6 && profitFactor > 1.5) {
                throttleLevel = 'aggressive';
                positionSizeMultiplier = 1.5; // Up sizes slowly when on fire
                minMomentumExtra = -1;        // Slight loosening on momentum filter
            }
        } else {
            console.log(`[PERFORMANCE] Grace Period Active: ${exactCount}/10 trades. Allowing execution.`);
        }

        // ── Daily Wallet Preservation ──
        if (totalDailyLossSol < -2.5) { // e.g. -2.5 SOL catastrophic limit
             console.log(`[PERFORMANCE] 🚨 DIRED: Total realized PnL in window hits ${totalDailyLossSol.toFixed(3)} SOL vs -2.5 allowance. Circuit breaker deployed.`);
             circuitBreaker = true;
             throttleLevel = 'pause';
        }

        // ── GMGN Validated Truth ──
        const gmgnStats = await fetchGmgnStats();
        let gmgnPnlUSD: number = 0;
        let gmgnWinRate: number = 0;
        if (gmgnStats && typeof gmgnStats.realized_profit !== 'undefined') {
             gmgnPnlUSD = parseFloat(gmgnStats.realized_profit);
             gmgnWinRate = parseFloat(gmgnStats.winrate) || 0;
             const unrealizedPnL = parseFloat(gmgnStats.unrealized_profit) || 0;
             
             console.log(`[PERFORMANCE] 🦅 GMGN 7d Truth: Realized $${gmgnPnlUSD.toFixed(2)} | Unrealized $${unrealizedPnL.toFixed(2)} | WR ${(gmgnWinRate*100).toFixed(1)}%`);
             
             // Hard-halt on USD Loss equivalent to ~2.5 SOL (~$500 right now)
             if (gmgnPnlUSD < -500) {
                 console.log(`[PERFORMANCE] 🚨 GMGN API DIRED: Hard loss of -$500 USD threshold broken. Halting Swarm.`);
                 circuitBreaker = true;
                 throttleLevel = 'pause';
             }
        }

        const finalConfig = {
            winRate: winRate.toFixed(3),
            profitFactor: profitFactor.toFixed(3),
            throttleLevel,
            positionSizeMultiplier: positionSizeMultiplier.toFixed(2),
            minMomentumExtra: minMomentumExtra.toString(),
            minVolumeExtra: minVolumeExtra.toString(),
            circuitBreaker: circuitBreaker.toString(),
            avgLoss: avgLoss.toFixed(4),
            avgWin: avgWin.toFixed(4),
            window: exactCount.toString(),
            gmgnRealizedPnL: Number(gmgnPnlUSD).toFixed(2),
            gmgnWinRate: Number(gmgnWinRate).toFixed(3)
        };

        await pub.hmset(REDIS_KEYS.CONFIG_PERFORMANCE, finalConfig);
        console.log(`[PERFORMANCE] 📊 Configured: WR ${(winRate*100).toFixed(1)}% | PF ${profitFactor.toFixed(2)}x | Tier: ${throttleLevel.toUpperCase()}`);
    } catch (e: any) {
        console.error(`[PERFORMANCE] Fatal: ${e.message}`);
    }
}

async function startDaemon() {
    console.log('[PERFORMANCE] 🚀 Booting Swarm Adaptive Throttle Daemon');
    await trackPerformance();
    setInterval(trackPerformance, 30_000); // 30 second moving tracker
}

startDaemon();
