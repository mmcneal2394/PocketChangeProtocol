import { Connection, PublicKey } from "@solana/web3.js";

const RPC_ENDPOINT = "https://mainnet.helius-rpc.com/?api-key=df082a16-aebf-4ec4-8ad6-86abfa06c8fc";
const connection = new Connection(RPC_ENDPOINT, "confirmed");

const TARGETS = [
    { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", sym: "USDC" },
    { mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", sym: "RAY" },
    { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", sym: "BONK" },
    { mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", sym: "WIF" }
];

async function testFees() {
    console.log("=== SANDBOX GAS LOGIC TEST ===");
    
    // Simulate a spread config
    const startingLamports = 50000000; // 0.05 SOL
    const simulatedEstProfits = [-0.00025, 0.0001, 0.005]; // Various simulated profit states

    for (const target of TARGETS) {
        console.log(`\nTesting Targets for ${target.sym} (${target.mint})...`);
        const feeAccounts = [new PublicKey(target.mint), new PublicKey("So11111111111111111111111111111111111111112")];
        
        try {
            const recentFees = await connection.getRecentPrioritizationFees({
                lockedWritableAccounts: feeAccounts
            });
            
            console.log(`Total Fee Records Returned: ${recentFees.length}`);
            
            if (recentFees.length > 0) {
                // deep clone to avoid modifying original ref while iterating
                const sortedFees = [...recentFees].sort((a, b) => a.prioritizationFee - b.prioritizationFee);
                
                const minFee = sortedFees[0]?.prioritizationFee;
                const maxFee = sortedFees[sortedFees.length - 1]?.prioritizationFee;
                const medianFee = sortedFees[Math.floor(sortedFees.length / 2)]?.prioritizationFee;
                
                console.log(`- Base Array Stats => Min: ${minFee}, Median: ${medianFee}, Max: ${maxFee}`);

                for (const estProfit of simulatedEstProfits) {
                    const isTightSpread = (estProfit / (startingLamports / 1e9)) < 0.003;
                    const targetIndex = Math.floor(sortedFees.length * (isTightSpread ? 0.25 : 0.50));
                    
                    const ESTIMATED_COMPUTE_UNITS = 300000;
                    const rawMicroLamportsPerCU = sortedFees[targetIndex]?.prioritizationFee || 100;
                    
                    let absolutePriorityLamports = Math.floor((rawMicroLamportsPerCU * ESTIMATED_COMPUTE_UNITS) / 1000000);
                    let optimalPriorityFee = Math.min(absolutePriorityLamports, 100000);
                    optimalPriorityFee = Math.max(optimalPriorityFee, 10);

                    // Jito tip logic test
                    const jitoTipLamports = estProfit > 0 
                        ? Math.floor(Math.min(100000, estProfit * 1e9 * 0.05)) 
                        : 10000;

                    console.log(`   [simulated_profit: ${estProfit}] isTightSpread: ${isTightSpread} -> PercentileIndex: ${targetIndex}`);
                    console.log(`     -> Absolute Lamports (Formula): ${absolutePriorityLamports} | Final Priority Fee (Bound): ${optimalPriorityFee}`);
                    console.log(`     -> Jito Tip: ${jitoTipLamports}`);
                }
            } else {
                console.log("No recent fee data returned. Using fallback base 10000.");
            }
        } catch (e) {
            console.error("RPC Error:", e);
        }
    }
}

testFees();
