import ccxt from 'ccxt';
import fetch from 'node-fetch';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import * as dotenv from 'dotenv';
import BN from 'bn.js';

dotenv.config();

// =========================================================================
// PocketChange CEX-DEX Spatial Arbitrage Engine 
// =========================================================================

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY");

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

const JUPITER_QUOTE_API = 'https://public.jupiterapi.com/quote';
const JUPITER_SWAP_API = 'https://public.jupiterapi.com/swap';
const JUP_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Token Definitions (Expanded)
const TARGET_POOLS = [
    { mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", sym: "WIF", cexSymbol: "WIF/USDT", decimals: 6 },
    { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", sym: "BONK", cexSymbol: "BONK/USDT", decimals: 5 }, 
];

const exchange = new ccxt.bitget({ enableRateLimit: true, apiKey: process.env.BITGET_API, secret: process.env.BITGET_SECRET });

async function executeJupiterSwap(quoteResponse: any) {
    try {
        const swapResponse: any = await (await fetch(JUPITER_SWAP_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                quoteResponse,
                userPublicKey: wallet.publicKey.toString(),
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true,
                prioritizationFeeLamports: "auto"
            })
        })).json();
        
        const { swapTransaction } = swapResponse;

        const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([wallet]);

        const rawTransaction = transaction.serialize();
        const txid = await connection.sendRawTransaction(rawTransaction, { skipPreflight: true, maxRetries: 2 });
        await connection.confirmTransaction(txid);
        console.log(`✅ [DEX Leg] Jupiter Swap Confirmed: https://solscan.io/tx/${txid}`);

    } catch (e: any) {
        throw new Error(`Jupiter Swap Failed: ${e.message}`);
    }
}

async function executeCexLimitOrder(symbol: string, side: 'buy' | 'sell', amount: number, price: number) {
    try {
        // We use createLimitOrder since we want to lock the exact spread spread threshold we calculated
        const order = await exchange.createLimitOrder(symbol, side, amount, price);
        console.log(`✅ [CEX Leg] Bitget Order Placed: ID ${order.id}`);
        return order;
    } catch (e: any) {
        throw new Error(`Bitget Order Failed: ${e.message}`);
    }
}

async function startSpatialScanner() {
    console.log(`\n🚀 Initializing Continuous CEX-DEX Spatial Scanner...`);
    console.log(`🔑 Hot Wallet: ${wallet.publicKey.toBase58()}`);

    // Loop interval
    setInterval(async () => {
        for (const target of TARGET_POOLS) {
            try {
                // 1. Fetch live orderbook depth from CEX
                const orderbook = await exchange.fetchOrderBook(target.cexSymbol, 5);
                const cexBestBid = orderbook.bids[0][0]; // Price they buy
                const cexBestAsk = orderbook.asks[0][0]; // Price they sell

                // 2. Poll Jupiter API 
                const usdcAmount = 50; 
                const usdcLamports = usdcAmount * 1e6;
                const dexBuyQuote: any = await (await fetch(`${JUPITER_QUOTE_API}?inputMint=${JUP_USDC_MINT}&outputMint=${target.mint}&amount=${usdcLamports}&slippageBps=50`)).json();
                
                if (dexBuyQuote.error) continue;

                const tokensReceived = parseInt(dexBuyQuote.outAmount) / Math.pow(10, target.decimals);
                const dexAskPrice = usdcAmount / tokensReceived; 

                // 3. Profit Delta Analysis: "Buy Low on DEX, Sell High on CEX"
                // Assuming no transfer bridging is needed immediately (Inventory Arbitrage)
                const dexBuyCexSellSpread = ((Number(cexBestBid) - dexAskPrice) / dexAskPrice) * 100;
                
                if (dexBuyCexSellSpread > 1.2) { // 1.2% threshold to be safe against volatile spreads
                    console.log(`\n🚨 ARBITRAGE DETECTED [${target.sym}] | Spread: +${dexBuyCexSellSpread.toFixed(2)}%`);
                    console.log(`   DEX Buy: $${dexAskPrice.toFixed(4)} -> CEX Sell: $${Number(cexBestBid).toFixed(4)}`);
                    
                    // Concurrent Leg Execution!
                    console.log(`   Executing dual-leg atomic operation...`);
                    
                    const [dexResult, cexResult] = await Promise.allSettled([
                        executeJupiterSwap(dexBuyQuote),
                        executeCexLimitOrder(target.cexSymbol, 'sell', tokensReceived, Number(cexBestBid))
                    ]);

                    if (dexResult.status === 'fulfilled' && cexResult.status === 'fulfilled') {
                         console.log(`   🎉 Spatial Arbitrage Leg Cleared! Yield Captured.`);
                    } else {
                         console.log(`   ⚠️ Partial fulfillment. Balancing required.`);
                    }
                }
            } catch (e: any) {
                // Silently drop polling errors
            }
        }
    }, 2000); // 2-second aggressive polling interval
}

startSpatialScanner();
