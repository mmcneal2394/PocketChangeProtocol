import RedisBus from './../utils/redis_bus';
import { REDIS_KEYS, PARAM_NAMES } from './redis_config';
import { runForensics } from '../utils/crime_forensics';

export async function validateTradeCandidate(mint: string, symbol: string = ''): Promise<boolean> {
    const pub = RedisBus.getPublisher();
    
    // 1. Fetch pre-computed parameters
    const params = await pub.hgetall(REDIS_KEYS.tradeParams(mint));
    if (!params || Object.keys(params).length === 0) {
        // Missing pre-compute data means token is organically newly discovered
        // But we MUST STILL PASS FORENSICS!
    } else {
        const isProfitable = params.isProfitable === 'true';

        // 3. Expected Value (Historical WinRate check)
        if (!isProfitable) {
            console.log(`[VALIDATOR] 🚫 ${mint} rejected (EV < 0)`);
            return false;
        }
    }

    // 4. Check Advanced Manipulation Forensics
    let analysis: any = null;
    const apexAnalysisStr = await pub.get(REDIS_KEYS.apexAnalysis(mint));
    
    if (apexAnalysisStr) {
        try { analysis = JSON.parse(apexAnalysisStr); } catch(e) {}
    } else {
        // SYNCHRONOUS FORENSICS EXECUTION (Safety First!)
        console.log(`[VALIDATOR] 🔎 ${symbol.trim() || mint.slice(0, 8)} has no active Forensics Matrix. Running Synchronous Deployer Checks NOW...`);
        const rpcUrl = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
        const forensics = await runForensics(mint, { baseToken: { address: mint, symbol: symbol } }, rpcUrl);
        
        analysis = {
            is_high_conviction: forensics.convictionScore >= 3,
            red_flag_count: 4 - forensics.convictionScore
        };
        
        // Cache it immediately so Apex daemon skips double work
        await pub.setex(REDIS_KEYS.apexAnalysis(mint), 7200, JSON.stringify(analysis));
    }

    if (analysis) {
        // Must have high conviction or otherwise it's explicitly rug pulling
        if (analysis.is_high_conviction === false) {
             console.log(`[VALIDATOR] 🚨 ${symbol.trim() || mint.slice(0, 8)} rejected -> Flagged by APEX Forensics (${analysis.red_flag_count} red flags)`);
             return false;
        }
    }

    // Passes comprehensive mathematical safety!
    return true;
}
