import RedisBus from '../../src/utils/redis_bus';
import { STREAMS, REDIS_KEYS } from '../../src/shared/redis_config';

const TRACKING_WINDOW = 20;

async function trackPerformance() {
    try {
        const pub = RedisBus.getPublisher();
        
        // Fetch trailing 20 trades from Redis Stream
        // XRANGE with - + gets all, but we just need XREVRANGE to get last N trades.
        // Format: XREVRANGE stream:trades + - COUNT 20
        const rawTrades = await pub.xrevrange(STREAMS.TRADES, '+', '-', 'COUNT', TRACKING_WINDOW);

        if (!rawTrades || rawTrades.length === 0) {
            console.log(`[PERFORMANCE] No trades found in ${STREAMS.TRADES}. Sleeping...`);
            return;
        }

        let wins = 0;
        let losses = 0;
        let grossProfit = 0;
        let grossLoss = 0;
        let totalDailyLossSol = 0; // For daily loss capping

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

        const exactCount = wins + losses;
        if (exactCount === 0) return; // Not enough sells

        const winRate = wins / exactCount;
        const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? 999 : 0);
        const avgLoss = losses > 0 ? (grossLoss / losses) : 0;
        const avgWin = wins > 0 ? (grossProfit / wins) : 0;

        let throttleLevel = 'normal';
        let positionSizeMultiplier = 1.0;
        let minMomentumExtra = 0;
        let minVolumeExtra = 0;
        let circuitBreaker = false;

        // ── Adaptive Tiering ── 
        if (winRate < 0.4 || profitFactor < 0.8) {
            throttleLevel = 'conservative';
            positionSizeMultiplier = 0.5; // Halve position sizes
            minMomentumExtra = 2;         // Add 2% harder momentum req
            minVolumeExtra = 5000;
            
            if (profitFactor < 0.5) {
                throttleLevel = 'pause';
                circuitBreaker = true;
            }
        } else if (winRate > 0.6 && profitFactor > 1.5) {
            throttleLevel = 'aggressive';
            positionSizeMultiplier = 1.5; // Up sizes slowly when on fire
            minMomentumExtra = -1;        // Slight loosening on momentum filter
        }

        // ── Daily Wallet Preservation ──
        if (totalDailyLossSol < -0.5) { // e.g. -0.5 SOL catastrophic limit
             console.log(`[PERFORMANCE] 🚨 DIRED: Total realized PnL in window hits ${totalDailyLossSol.toFixed(3)} SOL vs -0.5 allowance. Circuit breaker deployed.`);
             circuitBreaker = true;
             throttleLevel = 'pause';
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
            window: exactCount.toString()
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
