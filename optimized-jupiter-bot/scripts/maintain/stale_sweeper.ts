import RedisBus from '../../src/utils/redis_bus';
import { REDIS_KEYS, CHANNELS, PARAM_NAMES } from '../../src/shared/redis_config';

async function sweepStales() {
    try {
        console.log(`[SWEEPER] 🧹 Scanning active positions for stale locks...`);
        const pub = RedisBus.getPublisher();
        const keys = await pub.keys('position:*');
        
        let swept = 0;
        for (const key of keys) {
            const posData = await pub.get(key);
            if (!posData) continue;
            
            try {
                const pos = JSON.parse(posData);
                const mint = pos.mint;
                const entryTime = pos.openedAt;
                
                // Get configured maxHoldMinutes or default to 10
                const params = await pub.hgetall(REDIS_KEYS.tradeParams(mint));
                const maxHoldMinutes = params[PARAM_NAMES.MAX_HOLD_MINUTES] 
                     ? parseFloat(params[PARAM_NAMES.MAX_HOLD_MINUTES]) 
                     : 10;
                
                const ageMs = Date.now() - entryTime;
                const maxAgeMs = maxHoldMinutes * 60_000;
                
                if (ageMs > maxAgeMs) {
                    console.log(`[SWEEPER] ⚠️ TRASHING ${pos.symbol} — Overstayed max hold (${(ageMs/60000).toFixed(1)}m > ${maxHoldMinutes}m)`);
                    
                    // Signal the Engine to rigidly force-dump
                    await pub.publish(CHANNELS.ENGINE_FORCE_SELL, JSON.stringify({
                        mint,
                        symbol: pos.symbol,
                        reason: 'EXCEEDED_MAX_HOLD'
                    }));
                    
                    swept++;
                }
            } catch (e) {
               console.error(`[SWEEPER] Failed to parse position ${key}`);
            }
        }
        
        console.log(`[SWEEPER] ✅ Swept ${swept} stale positions from memory. Sleeping...`);
    } catch (e: any) {
        console.error(`[SWEEPER] Fatal error: ${e.message}`);
    }
}

async function startDaemon() {
    console.log('[SWEEPER] 🚀 Booting Stale Position Sweeper Daemon');
    await sweepStales();
    setInterval(sweepStales, 60_000); // 1-minute sweeping 
}

startDaemon();
