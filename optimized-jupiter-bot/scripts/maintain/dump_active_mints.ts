import Redis from 'ioredis';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });
const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379');

async function dump() {
    console.log("Fetching active AI-tracked mints...");
    const mints = await redis.smembers('active:mints');
    if (mints.length === 0) {
        console.log("\n[NO TARGETS] No mints are being actively tracked right now. The Alpha Wallets have no active positions and Velocity hasn't detected any extreme outliers in the last 60 seconds.");
        process.exit(0);
    }
    
    console.log(`\nFound ${mints.length} actively tracked targets. Evaluating top 5 by 24h volume...\n`);
    const stats: any[] = [];
    for(const m of mints) {
        const ev = await redis.hgetall(`trade:params:${m}`);
        const mom = await redis.hgetall(`momentum:${m}`);
        const p = await redis.hgetall(`price:${m}`);
        stats.push({ mint: m, usd: parseFloat(p?.usd||'0'), chg5m: parseFloat(mom?.chg5m||'0'), vol24h: parseFloat(mom?.vol24h || '0'), isProfitable: ev?.isProfitable || 'false' });
    }
    
    // Sort by volume descending
    stats.sort((a,b) => b.vol24h - a.vol24h);
    
    const top5 = stats.slice(0, 5);
    top5.forEach((t, i) => {
        console.log(`${i+1}. MINT: ${t.mint} | Price: $${t.usd.toFixed(6)} | 5m Chg: ${t.chg5m}% | 24h Vol: $${t.vol24h} | AI Profitable: ${t.isProfitable}`);
    });
    process.exit(0);
}
dump();
