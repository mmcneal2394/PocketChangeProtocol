import ccxt from 'ccxt';
import fetch from 'cross-fetch';

const TARGETS = [
    { mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", sym: "WIF", cexSymbol: "WIF/USDT", decimals: 6 },
    { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", sym: "BONK", cexSymbol: "BONK/USDT", decimals: 5 }, 
    { mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", sym: "RAY", cexSymbol: "RAY/USDT", decimals: 6 }
];

const JUPITER_QUOTE_API = 'https://public.jupiterapi.com/quote';
const JUP_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function runScanner() {
    console.log("======================================================");
    console.log("🌐 PIVOT: CEX-DEX SPATIAL ARBITRAGE SCANNER");
    console.log("======================================================\n");

    const exchange = new ccxt.bitget({ enableRateLimit: true });
    
    for (const target of TARGETS) {
        try {
            console.log(`Analyzing [${target.sym}] Spatial Spread between Binance and Jupiter...`);
            
            // 1. Fetch CEX Price (Binance)
            let cexBid, cexAsk;
            try {
                const ticker = await exchange.fetchTicker(target.cexSymbol);
                cexBid = ticker.bid; 
                cexAsk = ticker.ask; 
                
            } catch (err) {
                console.log(`   🔸 [CEX] Failed to fetch ticker for ${target.cexSymbol} on Bitget. (${err.message})`);
                continue;
            }

            // 2. Fetch DEX Ask (Buy on DEX: USDC -> Token)
            const usdcAmount = 500; // Simulate $500 bulk order to cross AMM spread realistically
            const usdcLamports = usdcAmount * 1e6;
            
            const jupBuyUrl = `${JUPITER_QUOTE_API}?inputMint=${JUP_USDC_MINT}&outputMint=${target.mint}&amount=${usdcLamports}&slippageBps=0`;
            const jupBuyRes = await fetch(jupBuyUrl);
            const jupBuyData = await jupBuyRes.json();
            
            if (jupBuyData.error) {
                console.log(`   🔸 [DEX] Failed to quote Buy route.`);
                continue;
            }
            
            const tokensReceivedOnDex = parseInt(jupBuyData.outAmount) / Math.pow(10, target.decimals);
            const dexAskPrice = usdcAmount / tokensReceivedOnDex;
            
            // 3. Fetch DEX Bid (Sell on DEX: Token -> USDC)
            const tokensToSellLamports = jupBuyData.outAmount;
            const jupSellUrl = `${JUPITER_QUOTE_API}?inputMint=${target.mint}&outputMint=${JUP_USDC_MINT}&amount=${tokensToSellLamports}&slippageBps=0`;
            const jupSellRes = await fetch(jupSellUrl);
            const jupSellData = await jupSellRes.json();
            
            let dexBidPrice = 0;
            if (!jupSellData.error) {
                const usdcReceivedOnDex = parseInt(jupSellData.outAmount) / 1e6;
                dexBidPrice = usdcReceivedOnDex / tokensReceivedOnDex;
            } else {
                continue;
            }
            
            // 4. Spread Calculation
            // Scenario A: Buy on DEX (at Ask), Sell on CEX (at Bid)
            const spreadBuyDexSellCex = ((cexBid - dexAskPrice) / dexAskPrice) * 100;
            
            // Scenario B: Buy on CEX (at Ask), Sell on DEX (at Bid)
            const spreadBuyCexSellDex = ((dexBidPrice - cexAsk) / cexAsk) * 100;
            
            console.log(`   [CEX BINANCE] Bid: $${cexBid.toFixed(6)} | Ask: $${cexAsk.toFixed(6)}`);
            console.log(`   [DEX JUPITER] Bid: $${dexBidPrice.toFixed(6)} | Ask: $${dexAskPrice.toFixed(6)}`);
            
            // 0.5% threshold is standard to cover CEX withdraw fee + limit grid execution
            if (spreadBuyDexSellCex > 0.5) {
                 console.log(`   🟢 STRUCTURAL ARB FOUND! Buy ${target.sym} on DEX, Sell on CEX => +${spreadBuyDexSellCex.toFixed(3)}% Profit Limit`);
            } else if (spreadBuyCexSellDex > 0.5) {
                 console.log(`   🟢 STRUCTURAL ARB FOUND! Buy ${target.sym} on CEX, Sell on DEX => +${spreadBuyCexSellDex.toFixed(3)}% Profit Limit`);
            } else {
                 console.log(`   🔴 No >0.5% Threshold Spread. Best Route (Buy DEX -> CEX): ${spreadBuyDexSellCex.toFixed(3)}% | (Buy CEX -> DEX): ${spreadBuyCexSellDex.toFixed(3)}%`);
            }
            console.log();
            
        } catch (e) {
            console.error(`Error checking ${target.sym}: ${e.message}\n`);
        }
    }
}

runScanner();
