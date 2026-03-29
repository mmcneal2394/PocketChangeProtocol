import RedisBus from '../../src/utils/redis_bus';
import { CHANNELS } from '../../src/shared/redis_config';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

async function monitorClosest() {
    process.stdout.write("Subscribing to live Velocity Engine streams to capture the top organic leaders in the last 60 seconds...\n\n");
    const sub = RedisBus.getSubscriber();
    sub.subscribe(CHANNELS.VELOCITY_SPIKE);

    sub.on('message', (ch, msg) => {
        if (ch === CHANNELS.VELOCITY_SPIKE) {
            let data: any;
            try {
                data = typeof msg === 'string' ? JSON.parse(msg) : msg;
            } catch (e) {
                console.error("Parse error:", e);
                return;
            }
            if (!data || !data.mints) return;
            
            const mintMap = data.mints;
            const latest = Object.values(mintMap) as any[];

            if (latest.length === 0) {
                // Ignore empty payloads and keep waiting until a pump happens!
                return;
            }

            // Target ranking: Closer they are to buys > 4, solVolume > 0.2, the higher they rank
            const ranked = latest.sort((a, b) => b.solVolume60s - a.solVolume60s).slice(0, 3);

            console.log(`[HEATMAP] The 3 organically closest tokens to triggering your Sniper on Raydium right now are:\n`);
            
            ranked.forEach((v, i) => {
                const buyPct = (v.buyRatio60s * 100).toFixed(1);
                console.log(`${i+1}. MINT: ${v.mint}`);
                console.log(`   - Velocity: ${v.velocity.toFixed(2)} tx/min  (Requires > 5)`);
                console.log(`   - Total Buys: ${v.buys60s}              (Requires >= 4)`);
                console.log(`   - Total Volume: ${v.solVolume60s.toFixed(3)} SOL    (Requires >= 0.200 SOL)`);
                console.log(`   - Buy Pressure: ${buyPct}%         (Requires >= 51.0%)`);
                console.log(`   -------------------------------------------------`);
                
            });
            process.exit(0);
        }
    });

    // Timeout after 60 seconds if no broadcast
    setTimeout(() => {
        console.log("No velocity events recorded on Raydium in the last 60s window. Market might be asleep or perfectly flat.");
        process.exit(0);
    }, 60000);
}

monitorClosest();
