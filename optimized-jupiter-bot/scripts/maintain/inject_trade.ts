import RedisBus from '../../src/utils/redis_bus';
import { CHANNELS } from '../../src/shared/redis_config';
import * as path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '../../.env') });

const targetMint = process.argv[2] || 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // BONK by default if none provided

async function injectPayload() {
    console.log(`\n\n[INJECTOR] 🚀 Initiating Manual Payload Injection for ${targetMint}`);
    
    // Build a perfectly formatted synthetic 'stream:velocity' payload that explicitly forces momentum_sniper.ts to byte
    const syntheticPayload = {
        updatedAt: Date.now(),
        mintCount: 1,
        mints: {
            [targetMint]: {
                buys60s: 25,               // Easily clears MIN_BUYS (4)
                sells60s: 2,               // 25 buys to 2 sells = dominating ratio
                buyRatio60s: 0.925,        // Easily clears MIN_RATIO (0.55)
                solVolume60s: 1.5,         // Huge volume locally
                velocity: 35.0,            // Hyper speed
                firstSeen: Date.now() - 60000,
                lastSeen: Date.now(),
                isAccelerating: true,      // Must be accelerating
                ageSec: 60
            }
        }
    };

    console.log(`[INJECTOR] 🔗 Artificially injecting Mathematical Pre-Validation (pcp-market-data simulate)...`);
    const pub = RedisBus.getPublisher();
    
    // Unblock the Swarm's Capital Circuit Breaker
    await pub.hset('config:performance', 'circuitBreaker', 'false', 'positionSizeMultiplier', '1.0');
    
    await pub.hset(
        `trade:params:${targetMint}`,
        'isProfitable', 'true',
        'positionSizeUSD', '5.0',
        'maxBuyPrice', '0.0001',
        'maxTPpct', '0.2',
        'stopLossPct', '0.5',
        'maxHoldMinutes', '5'
    );
    
    console.log(`[INJECTOR] 🔗 Broadcasting payload across Redis Pub/Sub...`);
    await pub.publish(CHANNELS.VELOCITY_SPIKE, JSON.stringify(syntheticPayload));
    
    console.log(`[INJECTOR] ✅ Injection Complete! The Engine should immediately wake up and parse it in standard output!\n`);
    
    setTimeout(() => {
        process.exit(0);
    }, 2000);
}

injectPayload();
