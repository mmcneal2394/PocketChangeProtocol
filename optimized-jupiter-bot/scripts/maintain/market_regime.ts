import RedisBus from '../../src/utils/redis_bus';
import { REDIS_KEYS } from '../../src/shared/redis_config';

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

async function defineMarketRegime() {
    try {
        const pub = RedisBus.getPublisher();
        
        // Fetch WSOL metrics from DexScreener or Jupiter if available, 
        // We'll use the Jupiter V3 price API simply to get quick SOL price over time.
        // Wait, DexScreener is better for momentum (5m/1h volume).
        
        const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${WSOL_MINT}`);
        const dexData = await dexRes.json();
        
        if (!dexData || !dexData.pairs || dexData.pairs.length === 0) {
            console.log('[REGIME] WSOL Data unavailable. Defaulting to Neutral.');
            return;
        }

        // Aggregate top WSOL pools (e.g. USDC/SOL Raydium/Orca)
        const solPairs = dexData.pairs.filter((p: any) => p.baseToken.address === WSOL_MINT && p.liquidity?.usd > 1_000_000);
        if (solPairs.length === 0) return;

        // Average 24h & 1h price changes
        let totalChg24h = 0;
        let totalChg1h = 0;
        let totalVol24h = 0;

        for (const p of solPairs) {
            totalChg24h += p.priceChange?.h24 || 0;
            totalChg1h += p.priceChange?.h1 || 0;
            totalVol24h += p.volume?.h24 || 0;
        }

        const avgChg24 = totalChg24h / solPairs.length;
        const avgChg1h = totalChg1h / solPairs.length;

        // Classification Logic
        let regime = 'neutral';
        let volatility = 'low';

        // High Volatility Threshold (e.g. SOL moving > 5% in 24h or >1.5% in 1h means market is active)
        if (Math.abs(avgChg24) > 5 || Math.abs(avgChg1h) > 1.5) {
            volatility = 'high';
        }

        if (avgChg24 > 4 && avgChg1h > 0.5) {
            regime = 'trending_up';
        } else if (avgChg24 < -4 && avgChg1h < -0.5) {
            regime = 'trending_down';
        } else {
            regime = 'mean_reverting';
        }

        const regimeObj = {
            classification: regime,
            volatility: volatility,
            sol_24h_chg: avgChg24.toFixed(2),
            sol_1h_chg: avgChg1h.toFixed(2),
            sol_vol_usd: totalVol24h.toFixed(0),
            timestamp: Date.now().toString()
        };

        // Standard ioredis HSET supports object fields directly
        await pub.hset(REDIS_KEYS.MARKET_REGIME, regimeObj);
        console.log(`[REGIME] 🌍 Global Sync: ${regime.toUpperCase()} | Volatility: ${volatility.toUpperCase()} | SOL 24h: ${avgChg24.toFixed(1)}%`);
    } catch(e: any) {
        console.error(`[REGIME] System API Failure: ${e.message}`);
    }
}

async function startDaemon() {
    console.log('[REGIME] 🚀 Booting Sol Macro-Economic Classification Daemon');
    await defineMarketRegime();
    setInterval(defineMarketRegime, 60_000 * 5); // Process every 5 minutes
}

startDaemon();
