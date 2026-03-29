import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import dotenv from 'dotenv';
import axios from 'axios';
import RedisBus from '../../src/utils/redis_bus';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const connection = new Connection(process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com', 'confirmed');
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY_1!));

const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUP_BASE = process.env.JUPITER_ENDPOINT || 'https://quote-api.jup.ag/v6';
const API_KEY = process.env.JUPITER_API_KEY || '';

async function executeLiveSwap(inputMint: string, outputMint: string, amountStr: string, label: string) {
    console.log(`\n[FORCE TRADE] ⚡ Executing ${label}... (${amountStr} units)`);
    try {
        const quoteUrl = `${JUP_BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountStr}&slippageBps=200`; // 2% slippage for safety
        const headers = API_KEY ? { headers: { 'x-api-key': API_KEY } } : {};
        
        const quoteRes = await axios.get(quoteUrl, headers);
        const quoteResponse = quoteRes.data;

        console.log(`[FORCE TRADE] 🧮 Quote Received: Expected ${quoteResponse.outAmount} tokens out.`);

        const swapRes = await axios.post(`${JUP_BASE}/swap`, {
            quoteResponse,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            prioritizationFeeLamports: 250000 // 0.00025 SOL gas to guarantee instant slot filling
        }, headers);

        const swapTransactionBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([wallet]);

        console.log(`[FORCE TRADE] 🚀 Broadcasting SIGNED payload to Mainnet...`);
        
        const rawTx = transaction.serialize();
        const txid = await connection.sendRawTransaction(rawTx, {
            skipPreflight: true,
            maxRetries: 3
        });

        console.log(`[FORCE TRADE] ⏳ Transaction sent! Confirming blockhash: https://solscan.io/tx/${txid}`);

        // Wait for confirmation
        const latestBlockHash = await connection.getLatestBlockhash('confirmed');
        const confirmation = await connection.confirmTransaction({
            blockhash: latestBlockHash.blockhash,
            lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
            signature: txid
        }, 'confirmed');

        if (confirmation.value.err) {
            console.error(`[FORCE TRADE] ❌ Transaction Failed on Chain:`, confirmation.value.err);
            return false;
        }

        console.log(`[FORCE TRADE] ✅ CONFIRMED on chain!`);
        return quoteResponse.outAmount;
    } catch (e: any) {
        console.error(`[FORCE TRADE] ❌ Fatal API Error: ${e.response?.data?.error || e.message}`);
        return false;
    }
}

async function runTest() {
    console.log(`=== 🧪 MANUAL VELOCITY INJECTION HARDWARE TEST ===`);
    console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
    
    // 1. Fetch currently hot token from Redis
    const redis = RedisBus.getSubscriber();
    
    // Subscribe to catch exactly one stream:velocity payload
    await new Promise<void>((resolve) => {
        redis.subscribe('stream:velocity');
        redis.on('message', async (channel, message) => {
            if (channel !== 'stream:velocity') return;
            try {
                const data = JSON.parse(message);
                if (!data.mints || Object.keys(data.mints).length === 0) return;
                
                // Get the hottest token that is NOT USDC
                let expectedOut: any = false;
                let finalTarget = '';
                
                for (const mint of Object.keys(data.mints)) {
                    if (mint !== USDC_MINT && mint !== WSOL_MINT && !mint.includes('USDT') && !mint.includes('GMgn')) {
                        console.log(`[FORCE TRADE] 🎯 Target Candidate: ${mint}`);
                        const buyInLamports = '2000000'; // 0.002 SOL (~$0.35 test buy)
                        expectedOut = await executeLiveSwap(WSOL_MINT, mint, buyInLamports, `BUY STAGE (wSOL -> ${mint.slice(0, 6)})`);
                        if (expectedOut) {
                            finalTarget = mint;
                            break;
                        }
                    }
                }
                
                if (!expectedOut || !finalTarget) {
                    console.log(`[FORCE TRADE] 🔄 No Jupiter-tradable tokens found in this velocity snapshot. Waiting for next stream tick...`);
                    return; // Don't resolve, just wait for the next message
                }

                redis.unsubscribe('stream:velocity');
                resolve();
                
                console.log(`\n[FORCE TRADE] ⏱️ Position secured. Holding for 10 seconds to simulate swarm delay...\n`);
                await new Promise(r => setTimeout(r, 10000));
                
                // 3. Sell the exact token back
                const secureSellAmount = Math.floor(parseInt(expectedOut) * 0.98).toString(); 
                await executeLiveSwap(finalTarget, WSOL_MINT, secureSellAmount, `SELL STAGE (${finalTarget.slice(0, 6)} -> wSOL)`);
                
                console.log(`\n=== 🎉 HARDWARE ROUTING TEST SUCCESSFUL ===\n`);
                process.exit(0);
                
            } catch (err) {
                console.error(err);
            }
        });
    });
}

runTest();
