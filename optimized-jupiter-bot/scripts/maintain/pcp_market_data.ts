import Redis from 'ioredis';
import { Connection } from '@solana/web3.js';
import dotenv from 'dotenv';
import path from 'path';
import { REDIS_KEYS, PARAM_NAMES } from '../../src/shared/redis_config';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const connection = new Connection(process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com');

async function precomputeMath(mints: string[]) {
    for (const mint of mints) {
        let priceStr = await redis.hget(REDIS_KEYS.price(mint), 'usd');
        let momentumStr = await redis.hget(REDIS_KEYS.momentum(mint), 'chg5m');
        
        const price = parseFloat(priceStr || '0');
        const momentum = parseFloat(momentumStr || '0');
        
        if (price === 0) continue; // Unusable if no price

        // 1. Volatility + Max Slippage for Entry Logic
        const volatility = Math.abs(momentum);
        const maxSlippage = volatility > 5 ? 0.02 : 0.005; // 2% vs 0.5%
        const maxBuyPrice = price * (1 + maxSlippage);

        // 2. Real-time Wallet Tracking
        const walletStateRaw = await redis.get(REDIS_KEYS.WALLET_TOTAL_USD);
        let walletValue = 10; 
        if (walletStateRaw) {
            try {
                walletValue = parseFloat(walletStateRaw) || 10;
            } catch (e) { }
        }

        // 3. Dynamic Position Sizing (Fixed Fractional Risk + Kelly Criterion Volatility Scaling)
        // Retrieve performance config synced from pcp-performance daemon
        let winRate = 0.5;
        let avgWin = 0;
        let avgLoss = 0;
        let posMultiplier = 1.0;
        let circuitBreaker = false;
        
        try {
            const perfObj = await redis.hgetall(REDIS_KEYS.CONFIG_PERFORMANCE);
            if (perfObj && Object.keys(perfObj).length > 0) {
                 winRate = parseFloat(perfObj.winRate) || 0.5;
                 avgWin = parseFloat(perfObj.avgWin) || 0;
                 avgLoss = parseFloat(perfObj.avgLoss) || 0;
                 posMultiplier = parseFloat(perfObj.positionSizeMultiplier) || 1.0;
                 circuitBreaker = perfObj.circuitBreaker === 'true';
            }
        } catch(e) {}

        // Kelly Criterion Calculation: K% = W - [(1 - W) / R] 
        // W = Win Rate | R = Win/Loss Ratio
        let kellyFraction = 0;
        if (avgWin > 0 && avgLoss > 0) {
             const ratio = avgWin / avgLoss;
             kellyFraction = winRate - ((1 - winRate) / ratio);
        } else if (avgWin > 0 && avgLoss === 0) {
             kellyFraction = winRate; // infinite ratio
        }
        
        // Safety Limit: Max 25% of Kelly
        const maxKellyCap = Math.max(0, kellyFraction * 0.25);
        
        // Final sanity constraints: Never bet more than 1% of total wallet.
        // Scale it securely by dynamic constraints applied by performance daemon.
        const defaultRiskPcnt = 0.01; 
        const activeRiskPcnt = maxKellyCap > 0 ? Math.min(maxKellyCap, defaultRiskPcnt) : defaultRiskPcnt;
        const totalRiskRatio = circuitBreaker ? 0 : (activeRiskPcnt * posMultiplier);
        
        let positionSizeUSD = walletValue * totalRiskRatio;
        if (circuitBreaker) positionSizeUSD = 0; // Absolute block

        const positionSizeTokens = price > 0 ? (positionSizeUSD / price) : 0;

        // 4. Exit Logic Tiers (Triple-Layer Hard Exit)
        const maxTPpct = parseFloat(await redis.get('config:maxTPpct') || process.env.MAX_TP_PERCENT || '20') / 100;
        const maxHoldMinutes = parseFloat(await redis.get('config:maxHoldMinutes') || process.env.MAX_HOLD_MINUTES || '10');
        const stopLossPct = parseFloat(await redis.get('config:stopLossPct') || process.env.STOP_LOSS_PERCENT || '50') / 100;

        // 5. Expected Value Check
        const expectedValue = (winRate * maxTPpct) - ((1 - winRate) * stopLossPct);
        const isProfitable = expectedValue > 0 ? 'true' : 'false';

        await redis.hset(REDIS_KEYS.tradeParams(mint), {
            maxSlippage: maxSlippage.toString(),
            [PARAM_NAMES.MAX_BUY_PRICE]: maxBuyPrice.toString(),
            [PARAM_NAMES.POSITION_SIZE_TOKENS]: positionSizeTokens.toString(),
            [PARAM_NAMES.POSITION_SIZE_USD]: positionSizeUSD.toString(),
            [PARAM_NAMES.MAX_TP_PCT]: maxTPpct.toString(),
            [PARAM_NAMES.MAX_HOLD_MINUTES]: maxHoldMinutes.toString(),
            [PARAM_NAMES.STOP_LOSS_PCT]: stopLossPct.toString(),
            isProfitable: isProfitable,
            [PARAM_NAMES.EXPECTED_VALUE]: expectedValue.toString(),
            timestamp: Date.now().toString(),
        });
    }
}

async function preloadMarketData() {
    try {
        console.log(`[DATA] 🔄 Syncing market data...`);
        // 1. Resolve actively tracked wallet mints
        let mints = await redis.smembers('active:mints');
        
        // Guarantee WSOL exists for fallback
        if (!mints.includes('So11111111111111111111111111111111111111112')) {
            mints.push('So11111111111111111111111111111111111111112');
            await redis.sadd('active:mints', 'So11111111111111111111111111111111111111112');
        }

        // 2. Fetch Pricing from Jupiter V3
        const ids = mints.join(',');
        const headers: any = {};
        if (process.env.JUPITER_API_KEY) {
            headers['x-api-key'] = process.env.JUPITER_API_KEY;
        }

        const priceRes = await fetch(`https://api.jup.ag/price/v3?ids=${ids}`, { headers });
        const priceData = await priceRes.json();
        
        if (priceData && priceData.data) {
            const dataObj = priceData.data;
            for (const [mint, info] of Object.entries(dataObj) as any) {
                const usd = info.price || info.usdPrice;
                if (usd) {
                    await redis.hset(REDIS_KEYS.price(mint), 'usd', usd.toString());
                    await redis.hset(REDIS_KEYS.price(mint), 'timestamp', Date.now().toString());
                }
            }
        } else if (priceData) {
            // Direct object fallback parsing (per v3 snippet variations)
            for (const [mint, info] of Object.entries(priceData) as any) {
                const usd = info.price || info.usdPrice;
                if (usd && typeof usd !== 'object') {
                    await redis.hset(REDIS_KEYS.price(mint), 'usd', usd.toString());
                    await redis.hset(REDIS_KEYS.price(mint), 'timestamp', Date.now().toString());
                }
            }
        }

        // 3. Fetch Momentum from DexScreener (chunked if large, but mints is likely < 30)
        // Dexscreener allows max 30 pairs per request
        const chunkSize = 30;
        for (let i = 0; i < mints.length; i += chunkSize) {
            const chunk = mints.slice(i, i + chunkSize);
            try {
                const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`);
                const dexData = await dexRes.json();
                
                if (dexData && dexData.pairs) {
                    // Collect strongest pool for momentum
                    const processed = new Set();
                    for (const pair of dexData.pairs) {
                        const baseMint = pair.baseToken?.address;
                        if (baseMint && mints.includes(baseMint) && !processed.has(baseMint)) {
                            processed.add(baseMint);
                            const chg5m = pair.priceChange?.m5 || pair.priceChange?.h1 || 0; // Fallback h1 if m5 absent
                            const vol24h = pair.volume?.h24 || 0;
                            await redis.hset(REDIS_KEYS.momentum(baseMint), 'chg5m', chg5m.toString());
                            await redis.hset(REDIS_KEYS.momentum(baseMint), 'vol24h', vol24h.toString());
                        }
                    }
                }
            } catch (e) {
                console.error(`[DATA] Dexscreener fetch failed: ${e}`);
            }
        }

        // 4. Trigger mathematics precomputations
        await precomputeMath(mints);
        console.log(`[DATA] ✅ Precomputed executions for ${mints.length} assets`);
    } catch (e: any) {
        console.error(`[DATA] Critical Failure in Loop: ${e.message}`);
    }
}

async function startDaemon() {
    console.log('[DATA] 🚀 Booting Native Market Aggregation Daemon (Rate Limit: 5m)');
    await preloadMarketData();
    setInterval(preloadMarketData, 300_000);
}

startDaemon();
