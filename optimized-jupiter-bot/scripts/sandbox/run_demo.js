const { spawn } = require('child_process');

console.log('--- STARTING LOCAL REDIS SANDBOX DEMO ---');

// Start Sniper Listener
const sniper = spawn('npx.cmd', ['ts-node', 'scripts/sandbox/mock_sniper.ts'], {shell: true});
sniper.stdout.on('data', (data) => console.log(`${data.toString()}`));
sniper.stderr.on('data', (data) => console.error(`${data.toString()}`));

// Wait a second for subscriber to lock onto Redis natively, then start Publisher
setTimeout(() => {
    const velocity = spawn('npx.cmd', ['ts-node', 'scripts/sandbox/mock_velocity.ts'], {shell: true});
    velocity.stdout.on('data', (data) => console.log(`${data.toString()}`));
    velocity.stderr.on('data', (data) => console.error(`${data.toString()}`));
    
    // Let them communicate over Redis Memory Hub for 8 seconds, then kill both
    setTimeout(() => {
        console.log('--- TEST COMPLETE. GRACEFULLY KILLING NODE SIMULATORS ---');
        sniper.kill();
        velocity.kill();
        process.exit(0);
    }, 8000);

}, 2000);
