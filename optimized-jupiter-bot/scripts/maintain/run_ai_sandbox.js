const { spawn } = require('child_process');

console.log('--- STARTING LOCAL REDIS V2 AI LOOP DEMO ---');

// Start Watchdog
const supervisor = spawn('npx.cmd', ['ts-node', 'scripts/maintain/pcp_supervisor.ts'], {shell: true});
supervisor.stdout.on('data', (data) => console.log(`${data.toString()}`));

// Wait 1s, start Optimizer Subscriber
setTimeout(() => {
    const optimizer = spawn('npx.cmd', ['ts-node', 'scripts/maintain/strategy_tune.ts'], {shell: true});
    optimizer.stdout.on('data', (data) => console.log(`${data.toString()}`));

    // Wait 2s, trigger Python Critic
    setTimeout(() => {
        const critic = spawn('python', ['scripts/maintain/swarm_critic_agent.py'], {shell: true});
        critic.stdout.on('data', (data) => console.log(`${data.toString()}`));
        
        // Let them run for a few more seconds, then kill everything
        setTimeout(() => {
            console.log('\n--- V2 TEST COMPLETE. GRACEFULLY KILLING PROCESSES ---');
            supervisor.kill();
            optimizer.kill();
            process.exit(0);
        }, 8000);

    }, 2000);
}, 1000);
