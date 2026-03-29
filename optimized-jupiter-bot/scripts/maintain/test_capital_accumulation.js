const { spawn } = require('child_process');
const Redis = require('ioredis');

console.log('--- STARTING LOCAL CAPITAL ACCUMULATION DEMO ---');

// The sniper needs env vars for guard limits, just mock a small set
const env = { ...process.env, SNIPER_BUY_PCT: "0.1", SNIPER_MAX_POS: "1" };

// Start Sniper Waiter
const sniper = spawn('npx.cmd', ['ts-node', 'scripts/maintain/momentum_sniper.ts'], {shell: true, env});
sniper.stdout.on('data', (data) => console.log(`${data.toString().trim()}`));
sniper.stderr.on('data', (data) => {}); // suppress normal noise

setTimeout(() => {
    // Start Adjuster
    const adjuster = spawn('npx.cmd', ['ts-node', 'scripts/maintain/pcp_adjuster.ts'], {shell: true, env});
    adjuster.stdout.on('data', (data) => console.log(`${data.toString().trim()}`));

    setTimeout(() => {
        // Mock a Wallet Balance via Redis directly
        const r = new Redis({ host: '127.0.0.1', port: 6379 });
        
        console.log('\n--> Mocking Initial Wallet Value: $100.00');
        r.publish('wallet:state', JSON.stringify({
            timestamp: Date.now(),
            totalValueUSD: 100.00
        }));

        setTimeout(() => {
            console.log('\n--> Mocking Wallet Crash (-5% in 6 seconds)');
            // Wait 6 seconds (to bypass the 5s jitter lock in adjuster)
            r.publish('wallet:state', JSON.stringify({
                timestamp: Date.now() + 6000,
                totalValueUSD: 95.00 
            }));

            setTimeout(() => {
                console.log('\n--> Mocking Massive Run Up (+20% in 12 seconds)');
                r.publish('wallet:state', JSON.stringify({
                    timestamp: Date.now() + 12000,
                    totalValueUSD: 120.00 
                }));

                // Wait for processing then kill
                setTimeout(() => {
                    console.log('\n--- DEMO COMPLETE. GRACEFULLY KILLING PROCESSES ---');
                    sniper.kill();
                    adjuster.kill();
                    r.quit();
                    process.exit(0);
                }, 2000);

            }, 2000); // interval for crash propagation
        }, 6000);

    }, 1000);
}, 1000);
