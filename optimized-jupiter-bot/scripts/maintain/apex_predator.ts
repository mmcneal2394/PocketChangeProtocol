import Redis from 'ioredis';
import dotenv from 'dotenv';
import path from 'path';
import { runForensics, checkDeepLiquidity } from '../../src/utils/crime_forensics';

dotenv.config({ path: path.join(process.cwd(), '.env') });
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

async function processForensics(candidateStr: string) {
    try {
        const candidate = JSON.parse(candidateStr);
        const mint = candidate.mint;
        const symbol = candidate.symbol;

        console.log(`[APEX] 🦅 Received ${symbol} for Forensics Review...`);

        // Check cache to avoid double work for immediate successive snipes on the same mint
        const existing = await redis.get(`apex:analysis:${mint}`);
        if (existing) {
             console.log(`[APEX] ♻️ ${symbol} already scored. Skiping.`);
             return;
        }

        const rpcUrl = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
        
        // Execute FR-03 and FR-04 forensics
        const forensics = await runForensics(mint, { baseToken: { address: mint, symbol: symbol } }, rpcUrl);
        
        console.log(`[APEX] 🔎 Matrix [${symbol}]: Score ${forensics.convictionScore}/4`);
        if (forensics.holderUniformity) console.log(`   └─ 🚨 SUSPICIOUSLY_EVEN_DISTRIBUTION`);
        if (forensics.botPresence) console.log(`   └─ 🚨 BOT_ACTIVITY_DETECTED`);
        if (!forensics.volumeConsistency) console.log(`   └─ 📉 VOLUME_CLIMAX / DECLINING`);
        if (forensics.anomalousHolderGrowth) console.log(`   └─ 🚨 ANOMALOUS_HOLDER_GROWTH`);

        // Map strictly to the new PRD spec fields
        const isHighConviction = forensics.convictionScore >= 3;
        const analysisData = {
            holder_distribution_flag: forensics.holderUniformity ? 1 : 0,
            bot_activity_flag: forensics.botPresence ? 1 : 0,
            volume_trend: forensics.volumeConsistency ? 'increasing' : 'declining',
            holder_growth_flag: forensics.anomalousHolderGrowth ? 1 : 0,
            red_flag_count: 4 - forensics.convictionScore, // Score is 4-redFlags
            is_high_conviction: isHighConviction
        };

        // Cache the result for 2 hours
        await redis.setex(`apex:analysis:${mint}`, 7200, JSON.stringify(analysisData));

        if (!isHighConviction) {
             console.log(`[APEX] 🚨 THREAT ACQUIRED: ${symbol} failed limits. Broadcasted MANIPULATION status natively for Snipers.`);
             // Additional explicit broadcast if needed
             await redis.publish('apex:high_conviction', JSON.stringify({ mint, is_high_conviction: false }));
        } else {
             console.log(`[APEX] ✅ ${symbol} cleared forensics.`);
        }

    } catch (e) {
        console.error(`[APEX] ❌ Forensics pipeline failed:`, e);
    }
}

async function monitorLiquidityPools() {
    try {
        const activeMints = await redis.smembers('active:mints');
        for (const mint of activeMints) {
             // Only scan tokens that don't already have deep liquidity explicitly confirmed caching avoiding rate limits
             const existing = await redis.get(`apex:liquidity:${mint}`);
             if (!existing) {
                  const hasLiquidity = await checkDeepLiquidity(mint);
                  if (hasLiquidity !== undefined) {
                       await redis.setex(`apex:liquidity:${mint}`, 7200, JSON.stringify({
                            liquidity_sufficient: hasLiquidity,
                            timestamp: Date.now()
                       }));
                       if (!hasLiquidity) {
                           console.log(`[APEX] 🚨 THIN LIQUIDITY FLAGGED ON ACTIVE HOLDING: ${mint}`);
                       }
                  }
             }
        }
    } catch(e) {
        console.error(`[APEX] ❌ Liquidity sweep failed:`, e);
    }
    setTimeout(monitorLiquidityPools, 60000); // Check all active assets once every minute
}

async function listenLoop() {
    console.log(`[APEX] 🦅 Apex Predator Daemon Online. Listening to apex:candidates...`);
    // Blocking pop on Redis list 'apex:candidates', timeout 0 (forever)
    while (true) {
        try {
            const result = await redis.blpop('apex:candidates', 0);
            if (result) {
                const [queue, data] = result;
                // Dispatch async to grab the next item immediately
                processForensics(data);
            }
        } catch(e) {
            console.error(`[APEX] Redis Listen Error:`, e);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

if (require.main === module) {
    listenLoop();
    monitorLiquidityPools();
}
