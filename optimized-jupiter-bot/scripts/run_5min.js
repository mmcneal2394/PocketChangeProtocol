const { spawn } = require('child_process');

console.log("🏁 Initiating 5-Minute Dedicated Node Micro-Arbitrage Test...");
const child = spawn('node', ['-r', 'ts-node/register', 'src/index.ts'], { 
    env: { ...process.env },
    stdio: 'inherit'
});

setTimeout(() => {
    console.log("\n⏱️ 5 Minutes elapsed. Terminating Engine...");
    child.kill();
    process.exit(0);
}, 300000);
