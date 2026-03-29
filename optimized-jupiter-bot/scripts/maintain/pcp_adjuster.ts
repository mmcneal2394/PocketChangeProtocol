import RedisBus from '../../src/utils/redis_bus';

let lastValueUSD = 0;
let lastUpdateTs = 0;

function evaluateWalletDelta(currentUSD: number, timestamp: number) {
    if (lastValueUSD === 0 || lastUpdateTs === 0) {
        lastValueUSD = currentUSD;
        lastUpdateTs = timestamp;
        return;
    }

    const msDiff = timestamp - lastUpdateTs;
    if (msDiff < 5000) return; // Ignore micro-jitters
    
    // We want the % change per minute
    const pctChange = ((currentUSD - lastValueUSD) / lastValueUSD) * 100;
    const minutesElapsed = msDiff / 60000;
    const velocityPerMinute = pctChange / minutesElapsed;

    console.log(`[ADJUSTER] 📈 Wallet Velocity: ${velocityPerMinute > 0 ? '+' : ''}${velocityPerMinute.toFixed(2)}% per min`);

    // --- Emergency Drawdown Preset (-2% per min) ---
    if (velocityPerMinute < -2.0) {
        console.error(`[ADJUSTER] 🚨 FLASH CRASH DETECTED (${velocityPerMinute.toFixed(2)}%/min). DEPLOYING DEFENSIVE PRESETS!`);
        
        // Push config override immediately
        const override = {
            BASE_BUY_PCT: 0.05,        // halve capital deployment
            MIN_BUY_SOL: 0.005,        // minimum possible size
            MAX_POSITIONS: 1,          // lock to 1 position max
        };

        RedisBus.publish('config:update', override);
    } 
    // --- Massive Rally Preset (+5% per min) ---
    else if (velocityPerMinute > 5.0) {
        console.log(`[ADJUSTER] 🚀 MASSIVE RUN-UP DETECTED (${velocityPerMinute.toFixed(2)}%/min). DEPLOYING OFFENSIVE PRESETS!`);
        
        const override = {
            BASE_BUY_PCT: 0.15,        // Deploy more capital into the pump
            MAX_POSITIONS: 3,          // Open up to 3 strong positions
        };

        RedisBus.publish('config:update', override);
    } 
    // --- Stabilization / Normal Growth ---
    else {
        // If wallet velocity normalizes, we can restore normal parameters 
        // (usually handled by pcp-optimizer AI over longer horizons)
    }

    lastValueUSD = currentUSD;
    lastUpdateTs = timestamp;
}

function startAdjuster() {
    console.log(`[ADJUSTER] 🛡️ Watching Wallet Velocity...`);
    
    const sub = RedisBus.getSubscriber();
    sub.subscribe('wallet:state', (err) => {
        if (err) console.error(`[ADJUSTER] ❌ Sub error:`, err);
        else console.log(`[ADJUSTER] ✅ Locked onto wallet:state telemetry`);
    });

    sub.on('message', (channel, message) => {
        if (channel === 'wallet:state') {
            try {
                const data = JSON.parse(message);
                if (data.totalValueUSD && data.timestamp) {
                    evaluateWalletDelta(data.totalValueUSD, data.timestamp);
                }
            } catch (e: any) {
                console.error('[ADJUSTER] Parse error', e.message);
            }
        }
    });

    // Heartbeat
    setInterval(() => {
        RedisBus.publish('heartbeat:agent', { agent: 'pcp-adjuster', timestamp: Date.now() });
    }, 30000);
}

startAdjuster();
