import Redis from 'ioredis';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const pubClient = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const JUPITER_API = process.env.JUPITER_ENDPOINT || 'https://api.jup.ag/swap/v1';

// Definition of highly-liquid, structurally correlated pairs
const PAIRS = [
    {
        name: 'WIF_BONK_SPREAD',
        assetA: { symbol: 'WIF', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYtM23PptMz', baseUnit: 1e6 },
        assetB: { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', baseUnit: 1e5 }
    },
    {
        name: 'JUP_RAY_SPREAD',
        assetA: { symbol: 'JUP', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbZedPFTs83F', baseUnit: 1e6 },
        assetB: { symbol: 'RAY', mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', baseUnit: 1e6 }
    }
];

const WINDOW_SIZE = 120; // 120 polling ticks (~1 hour if polling every 30s)
const Z_SCORE_THRESHOLD = 2.5; // Trigger divergence at 2.5 standard deviations

const history: Record<string, number[]> = {};

async function fetchPriceUSD(mint: string, baseUnit: number): Promise<number | null> {
    try {
        const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
        const res = await fetch(`${JUPITER_API}/quote?inputMint=${mint}&outputMint=${usdcMint}&amount=${baseUnit}`);
        const data = await res.json();
        if (data && data.outAmount) {
            return Number(data.outAmount) / 1e6; // USDC has 6 decimals
        }
        return null;
    } catch (e) {
        return null;
    }
}

function calculateMean(arr: number[]): number {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function calculateStdDev(arr: number[], mean: number): number {
    const variance = arr.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / arr.length;
    return Math.sqrt(variance);
}

async function monitorPairs() {
    console.log(`[STAT-ARB] Polling structural divergence...`);
    for (const pair of PAIRS) {
        const priceA = await fetchPriceUSD(pair.assetA.mint, pair.assetA.baseUnit);
        const priceB = await fetchPriceUSD(pair.assetB.mint, pair.assetB.baseUnit);

        if (priceA && priceB && priceB > 0) {
            const ratio = priceA / priceB;

            if (!history[pair.name]) history[pair.name] = [];
            history[pair.name].push(ratio);

            if (history[pair.name].length > WINDOW_SIZE) {
                history[pair.name].shift(); // Restrict memory window
            }

            if (history[pair.name].length >= 30) { // Require at least a 15-minute warmup window
                const currentHistory = history[pair.name];
                const mean = calculateMean(currentHistory);
                const stdDev = calculateStdDev(currentHistory, mean);

                const zScore = (ratio - mean) / stdDev;

                console.log(`[STAT-ARB] ${pair.name} | Ratio: ${ratio.toFixed(4)} | Mean: ${mean.toFixed(4)} | Z-Score: ${zScore.toFixed(2)}`);

                if (Math.abs(zScore) >= Z_SCORE_THRESHOLD) {
                    const signalDirection = zScore > 0 ? `SHORT_${pair.assetA.symbol}_LONG_${pair.assetB.symbol}` : `SHORT_${pair.assetB.symbol}_LONG_${pair.assetA.symbol}`;
                    
                    const payload = {
                        pair: pair.name,
                        assetA: pair.assetA,
                        assetB: pair.assetB,
                        currentRatio: ratio,
                        zScore: zScore,
                        signal: signalDirection,
                        timestamp: Date.now()
                    };

                    console.log(`[STAT-ARB] 🚨 DIVERGENCE DETECTED! Transmitting target vector to Gemma-4: ${signalDirection}`);
                    pubClient.publish('AI_ARBITRAGE_TARGET', JSON.stringify(payload));
                    redis.hset(`arb:stats:${pair.name}`, 'last_z_score', zScore.toFixed(3));
                    redis.hset(`arb:stats:${pair.name}`, 'last_signal', signalDirection);
                }
            } else {
                console.log(`[STAT-ARB] ${pair.name} Warming up dataset... (${history[pair.name].length}/30 ticks)`);
            }
        }
    }

    setTimeout(monitorPairs, 30_000); // Wait 30 seconds before polling again
}

async function startEngine() {
    console.log('[STAT-ARB] Mean Reversion Execution Module Online.');
    monitorPairs();
}

startEngine();
