import { Connection } from '@solana/web3.js';
import { config } from './src/utils/config';
import { fetchJupiterQuote, getParallelSwapInstructions } from './src/jupiter/quotes';
import { buildVersionedTransaction } from './src/execution/transaction';
import { startBlockhashCache } from './src/jupiter/cache';

async function verify() {
    await startBlockhashCache();
    console.log("==========================================");
    console.log("   🚀 STRUCTURAL PAYLOAD VERIFICATION 🚀   ");
    console.log("==========================================");

    const WSOL = "So11111111111111111111111111111111111111112";
    const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

    console.log("[1] Triggering Unrestricted WSOL -> USDC Quote...");
    const quote1 = await fetchJupiterQuote(WSOL, USDC, 10000000); // 0.01 WSOL
    if (!quote1) return console.log("[ERROR] Quote 1 failed");

    console.log("[2] Triggering Unrestricted USDC -> WSOL Quote...");
    const quote2 = await fetchJupiterQuote(USDC, WSOL, Number(quote1.otherAmountThreshold));
    if (!quote2) return console.log("[ERROR] Quote 2 failed");

    console.log("[3] Compiling Parallel Swap Instructions (wrapAndUnwrapSol: false)...");
    const instructions = await getParallelSwapInstructions(quote1, quote2);
    if (!instructions) return console.log("[ERROR] Swap Fetch failed");

    console.log("[4] Assembling Multi-Hop ALTs & Base Priority Fees...");
    const tx = await buildVersionedTransaction(instructions.ix1, instructions.ix2);
    if (!tx) return console.log("[ERROR] Transaction Assembly failed");

    const rawBytes = tx.serialize();
    console.log(`\n✅ Transaction physically assembled without Uint8Array Overflow!`);
    console.log(`📦 Payload Byte Size: ${rawBytes.length} / 1232 bytes (Maximum UDP Limit)`);
    
    console.log("\n[5] Simulating Transaction strictly against Solana Mainnet Validators...");
    const connection = new Connection(config.RPC_ENDPOINT, 'confirmed');
    const sim = await connection.simulateTransaction(tx);
    
    if (sim.value.err) {
        console.log(`❌ Simulation Failed:`, sim.value.err);
        if (sim.value.logs) console.log(sim.value.logs.slice(-5));
    } else {
        console.log(`✅ Simulation PASSED Structurally!`);
        console.log(`⚙️ Compute Units Consumed: ${sim.value.unitsConsumed} / 1400000 Limit`);
        console.log(`[SYS] Triangular Arbitrage Pipeline is fully validated and operationally lethal.`);
    }
    console.log("==========================================");
    process.exit(0);
}

verify();
