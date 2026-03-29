import RedisBus from '../../src/utils/redis_bus';

const HEALTH_TIMEOUT_MS = 90000; // 3 missed heartbeats (90 seconds)
const agentHeartbeats: Record<string, number> = {};

function startSupervisor() {
    console.log(`[SUPERVISOR] 🛡️ Initializing PM2 Watchdog over Redis...`);
    const subscriber = RedisBus.getSubscriber();

    subscriber.subscribe('heartbeat:agent', (err, count) => {
        if (err) console.error(`[SUPERVISOR] ❌ Redis Subscription Error:`, err);
        else console.log(`[SUPERVISOR] ✅ Listening for V2 Agent Heartbeats...`);
    });

    subscriber.on('message', (channel, message) => {
        if (channel === 'heartbeat:agent') {
            try {
                const data = JSON.parse(message);
                if (data.agent && data.timestamp) {
                    agentHeartbeats[data.agent] = Date.now();
                }
            } catch (err) {
                console.error(`[SUPERVISOR] ⚠️ Invalid Heartbeat Payload:`, err);
            }
        }
    });

    // Watchdog Sweep Loop
    setInterval(() => {
        const now = Date.now();
        console.log(`\n[SUPERVISOR] 📊 Health Check (${new Date(now).toISOString()})`);
        
        if (Object.keys(agentHeartbeats).length === 0) {
            console.log(`[SUPERVISOR] ⚠️ No agents tracking yet...`);
            return;
        }

        for (const [agent, lastSeen] of Object.entries(agentHeartbeats)) {
            const age = now - lastSeen;
            if (age > HEALTH_TIMEOUT_MS) {
                console.error(`[SUPERVISOR] 🚨 CRITICAL: ${agent} has missed 3 heartbeats! It has been silent for ${(age/1000).toFixed(1)}s`);
                console.warn(`[SUPERVISOR] 🔧 Action Recommended: Manually run 'pm2 restart ${agent}' or investigate PM2 logs.`);
            } else {
                console.log(`[SUPERVISOR] 🟢 ${agent} is healthy (Ping: ${(age/1000).toFixed(1)}s ago)`);
            }
        }
    }, 30000);
}

if (require.main === module) {
    startSupervisor();
}
