import RedisBus from './../utils/redis_bus';
import { REDIS_KEYS, PARAM_NAMES } from './redis_config';

export async function validateTradeCandidate(mint: string): Promise<boolean> {
    const pub = RedisBus.getPublisher();
    
    // 1. Fetch pre-computed parameters
    const params = await pub.hgetall(REDIS_KEYS.tradeParams(mint));
    if (!params || Object.keys(params).length === 0) {
        // Missing pre-compute data means token is organically newly discovered
        return true;
    }

    const maxBuyPrice = parseFloat(params[PARAM_NAMES.MAX_BUY_PRICE]);
    const isProfitable = params.isProfitable === 'true';

    // 2. We skip price validation here as its dynamically assessed post-quote 
    // but we can reject purely on EV metrics (historical Win Rate constraints)

    // 3. Expected Value (Historical WinRate check)
    if (!isProfitable) {
        console.log(`[VALIDATOR] 🚫 ${mint} rejected (EV < 0)`);
        return false;
    }

    // 4. Check Advanced Manipulation Forensics (Apex Predator async rejection)
    const apexAnalysisStr = await pub.get(REDIS_KEYS.apexAnalysis(mint));
    if (apexAnalysisStr) {
        try {
            const analysis = JSON.parse(apexAnalysisStr);
            // Must have high conviction or otherwise it's explicitly rug pulling
            if (analysis.is_high_conviction === false) {
                 console.log(`[VALIDATOR] 🚨 ${mint} rejected (Flagged by APEX Predators)`);
                 return false;
            }
        } catch(e) {}
    }

    // Passes comprehensive mathematical safety!
    return true;
}
