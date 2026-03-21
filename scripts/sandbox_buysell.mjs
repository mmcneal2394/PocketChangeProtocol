// Native global.fetch integration
const TARGETS = [
    { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", sym: "USDC" },
    { mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", sym: "RAY" },
    { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", sym: "BONK" },
    { mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", sym: "WIF" }
];

async function testBuySellLogic() {
    console.log("=== SANDBOX BUY/SELL MATH TEST ===");
    
    const startingLamports = 50000000; // 0.05 SOL
    const routingParam = ""; // Using dynamic multihop route like triangular
    
    for (const target of TARGETS) {
        console.log(`\nTesting Buy/Sell Spread for ${target.sym}...`);
        try {
            // Leg 1: SOL -> Target (with 0% max slippage = 0 bps)
            const url1 = `https://api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=${target.mint}&amount=${startingLamports}&slippageBps=0${routingParam}`;
            const quoteRes = await fetch(url1, {
                headers: { 'x-api-key': '05aa94b2-05d5-4993-acfe-30e18dc35ff1' }
            });
            const quoteData = await quoteRes.json();
            
            if (quoteData.error || !quoteData.outAmount) {
                console.log(`   [ERROR] Leg 1 Failed: ${JSON.stringify(quoteData)}`);
                continue; 
            }
            
            // Expected Output of Target Token
            const receivedTokens = parseInt(quoteData.outAmount);
            console.log(`   [LEG 1] Input: ${(startingLamports / 1e9)} SOL -> Output Tokens: ${receivedTokens}`);
            console.log(`           Leg 1 Price Impact: ${quoteData.priceImpactPct}%`);
            
            // Leg 2: Target -> SOL (with 0% max slippage = 0 bps)
            const url2 = `https://api.jup.ag/swap/v1/quote?inputMint=${target.mint}&outputMint=So11111111111111111111111111111111111111112&amount=${receivedTokens}&slippageBps=0${routingParam}`;
            const q2Res = await fetch(url2, {
                headers: { 'x-api-key': '05aa94b2-05d5-4993-acfe-30e18dc35ff1' }
            });
            const q2Data = await q2Res.json();
            
            if (q2Data.error || !q2Data.outAmount) {
                console.log(`   [ERROR] Leg 2 Failed: ${JSON.stringify(q2Data)}`);
                continue;
            }
            
            const outSol = parseInt(q2Data.outAmount);
            const profit = outSol - startingLamports;
            const roi = profit / startingLamports;
            const estProfit = profit / 1000000000;
            
            console.log(`   [LEG 2] Input Tokens: ${receivedTokens} -> Output SOL: ${(outSol / 1e9)}`);
            console.log(`           Leg 2 Price Impact: ${q2Data.priceImpactPct}%`);
            console.log(`   📊 Route: SOL -> ${target.sym} -> SOL | ROI: ${(roi * 100).toFixed(3)}% | Est Profit: ${estProfit.toFixed(6)} SOL`);
            
            const impact1 = parseFloat(quoteData.priceImpactPct || "0"); 
            const impact2 = parseFloat(q2Data.priceImpactPct || "0");
            const totalSlippageDecimal = (impact1 + impact2); 
            console.log(`   🔸 Total Market Slippage Penalty (AMM Spread Impact): ${(totalSlippageDecimal * 100).toFixed(4)}%`);
            
        } catch (e) {
            console.error(`Error processing ${target.sym}: ${e.message}`);
        }
    }
}

testBuySellLogic();
