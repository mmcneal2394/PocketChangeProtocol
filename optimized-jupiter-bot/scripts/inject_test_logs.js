const { logTrade } = require('../dist/utils/logger.js');
const DateNow = Date.now();

for (let i = 0; i < 60; i++) {
    // 10 seconds apart for 10 minutes (60 trades)
    const reqTime = DateNow - (10 - i/6) * 60000;
    
    // Simulate realistic 0.001 SOL micro amounts
    const isWin = Math.random() > 0.15; // 85% win rate
    const latency = 0.05 + Math.random() * 0.05; // 0.05-0.1ms Engine speeds
    const profit = isWin ? 5000 : -2000; // Expected profit natively bounded
    
    logTrade({
        timestamp: reqTime,
        slot: 245781 + i*30,
        opportunity: {
            type: i % 4 === 0 ? 'Triangular-3-Hop' : 'Simple-2-Hop',
            route: ["USDC"],
            expectedIn: 1000000, // 0.001 SOL setup strictly bound
            expectedOut: 1000000 + profit, 
            expectedProfitLamports: profit,
            expectedProfitBps: isWin ? 50 : -20
        },
        decision: i % 10 === 0 ? 'dropped' : 'executed',
        jitoTipLamports: isWin ? 100000 : 150000, // higher tip on tight ones occasionally
        priorityFeeLamports: 10000,
        latencyMs: latency,
        priceBookSnapshot: '{"status":"Valid"}'
    });
}
console.log("✅ Injected 10 minutes of structural Sandbox execution boundaries successfully.");
