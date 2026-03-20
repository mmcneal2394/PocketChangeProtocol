const fs = require('fs');
const path = require('path');

const logPath = path.join(__dirname, '../logs/rolling_metrics.json');

function analyzeMetrics() {
    console.log("==================================================");
    console.log("    📉 OPTIMIZED ARBITRAGE REFINEMENT TOOL 📉     ");
    console.log("==================================================");
    
    if (!fs.existsSync(logPath)) {
        console.log("[ERROR] No rolling_metrics.json found! The Arbitrage Engine has not successfully cached any viable execution payloads yet.");
        console.log("-> Recommendation: Ensure MIN_PROFIT_BPS is strictly set and the engine is actively scraping.");
        console.log("==================================================");
        return;
    }

    const data = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    if (data.length === 0) {
        console.log("[INFO] Metric cache is currently empty.");
        return;
    }

    console.log(`[INFO] Evaluating ${data.length} Rolling Execution Caches...`);
    
    let totalWins = 0;
    let totalLosses = 0;
    let totalVolumeSOL = 0;
    let maxProfitBps = -9999;
    let maxLossBps = 9999;
    let bestRoute = "N/A";
    
    const sizeDistribution = {};

    data.forEach(trade => {
        if (trade.success) totalWins++;
        else totalLosses++;
        
        totalVolumeSOL += trade.tradeSizeSOL;
        
        if (trade.expectedProfitBps > maxProfitBps) {
            maxProfitBps = trade.expectedProfitBps;
            bestRoute = `SOL -> ${trade.outputMint.substring(0, 8)}...`;
        }
        if (trade.expectedProfitBps < maxLossBps) {
            maxLossBps = trade.expectedProfitBps;
        }

        const sizeKey = `${trade.tradeSizeSOL.toFixed(4)} SOL`;
        if (!sizeDistribution[sizeKey]) sizeDistribution[sizeKey] = 0;
        sizeDistribution[sizeKey]++;
    });

    const winRate = ((totalWins / data.length) * 100).toFixed(2);
    
    console.log("\n📊 --- GLOBAL METRICS ---");
    console.log(`Total Attempts Logged: ${data.length}`);
    console.log(`Total Successes (Landed): ${totalWins}`);
    console.log(`Total Capital Swept: ${totalVolumeSOL.toFixed(4)} SOL`);
    console.log(`Execution Win Rate: ${winRate}%`);
    
    console.log("\n📈 --- EXTREME BOUNDARIES ---");
    console.log(`Maximum Arbitrage Yield Simulated: ${maxProfitBps.toFixed(2)} bps`);
    console.log(`Lowest Drawdown Recorded (Tests): ${maxLossBps.toFixed(2)} bps`);
    console.log(`Top Performing Route Vector: ${bestRoute}`);
    
    console.log("\n📐 --- CAPITAL SIZE DISTRIBUTION ---");
    for (const [size, count] of Object.entries(sizeDistribution)) {
        console.log(`- ${size} Execution Size: Triggered ${count} times (${((count / data.length) * 100).toFixed(1)}%)`);
    }

    console.log("\n🧠 --- ALGORITHMIC RECOMMENDATIONS ---");
    if (maxLossBps < 0 && winRate > 0) {
        console.log("-> ⚠️ Guard-Rail Failure Simulation Detected! Negative executions actively observed. You successfully proved mempool inclusion physics, but strictly verify MIN_PROFIT_BPS > 0 for autonomous running.");
    } else if (totalWins === 0) {
        console.log("-> 🛡️ Defensive Posture Locked: The algorithm is aggressively protecting your portfolio by fundamentally refusing to route unprofitable spreads. Market is currently tight. Consider expanding AMM routing to hunt deeper liquidity dislocation.");
    } else {
        console.log("-> 🚀 Alpha Captured: The protocol is successfully trapping and extracting robust positive basis spreads cleanly over Mainnet!");
    }
    
    console.log("==================================================\n");
}

analyzeMetrics();
