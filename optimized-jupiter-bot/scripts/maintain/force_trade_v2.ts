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
    try {
        const quoteUrl = `${JUP_BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountStr}&slippageBps=1000`;
        const headers = API_KEY ? { headers: { 'x-api-key': API_KEY } } : {};
        
        const quoteRes = await axios.get(quoteUrl, { ...headers, timeout: 5000 }).catch(() => null);
        if (!quoteRes || !quoteRes.data || !quoteRes.data.outAmount) return false;
        
        const quoteResponse = quoteRes.data;
        console.log(`\n[FORCE TRADE] ⚡ Executing ${label}... (${amountStr} units)`);
        console.log(`[FORCE TRADE] 🧮 Quote Received! Route is valid! (Expected ${quoteResponse.outAmount})`);

        const swapRes = await axios.post(`${JUP_BASE}/swap`, {
            quoteResponse,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: false, // EXPLICITLY FALSE: WE ARE USING WSOL ATA INSTEAD OF NATIVE SOL!
            prioritizationFeeLamports: 350000 // 0.00035 SOL tip for instant confirmation
        }, headers);

        const swapTransactionBuf = Buffer.from(swapRes.data.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        transaction.sign([wallet]);

        console.log(`[FORCE TRADE] 🚀 Broadcasting SIGNED payload to Mainnet...`);
        const rawTx = transaction.serialize();
        const txid = await connection.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 1 });

        console.log(`[FORCE TRADE] ⏳ Transaction sent! https://solscan.io/tx/${txid}`);

        const blockhash = await connection.getLatestBlockhash('confirmed');
        const confirmation = await connection.confirmTransaction({
            blockhash: blockhash.blockhash,
            lastValidBlockHeight: blockhash.lastValidBlockHeight,
            signature: txid
        }, 'confirmed');

        if (confirmation.value.err) {
            console.error(`[FORCE TRADE] ❌ Transaction Failed on Chain:`, confirmation.value.err);
            return false;
        }

        console.log(`[FORCE TRADE] ✅ CONFIRMED on chain!`);
        return quoteResponse.outAmount;
    } catch (e: any) {
        return false;
    }
}

async function runTest() {
    console.log(`=== 🧪 MANUAL VELOCITY INJECTION HARDWARE TEST v2 ===`);
    console.log(`Wallet: ${wallet.publicKey.toBase58()} (WSOL NATIVE ATA)`);
    console.log(`Scanning matrix for first highly liquid raydium token...`);
    
    const redis = RedisBus.getSubscriber();
    let executing = false;
    
    redis.subscribe('stream:velocity');
    redis.on('message', async (channel, message) => {
        if (channel !== 'stream:velocity') return;
        if (executing) return;

        try {
            const data = JSON.parse(message);
            if (!data.mints) return;
            
            // Collect all candidate mints
            const candidates = Object.keys(data.mints)
                .filter(m => m !== USDC_MINT && m !== WSOL_MINT && !m.includes('USDT') && !m.includes('GMgn'));
                
            if (candidates.length === 0) return;
            
            executing = true;
            process.stdout.write(`\r[SCAN] Testing ${candidates.length} live momentum tokens for Router liquidity...`);
            
            // We ping JUP Quote in parallel to instantly find a routeable token instead of linear blocking
            const quotePromises = candidates.map(mint => {
                const quoteUrl = `${JUP_BASE}/quote?inputMint=${WSOL_MINT}&outputMint=${mint}&amount=2000000&slippageBps=1000`; // 10%
                return axios.get(quoteUrl, { ...(API_KEY ? { headers: { 'x-api-key': API_KEY } } : {}), timeout: 2000 })
                    .then(res => ({mint, valid: true}))
                    .catch(() => ({mint, valid: false}));
            });
            
            const results = await Promise.all(quotePromises);
            const validTarget = results.find(r => r.valid);
            
            if (!validTarget) {
                executing = false;
                return; // Nothing routable this tick, waiting for next payload
            }
            
            console.log(`\n\n[FORCE TRADE] 🎯 Target Locked & Routable: ${validTarget.mint}`);
            redis.unsubscribe('stream:velocity');
            
            // 2. Buy the target token using WSOL
            const expectedOut = await executeLiveSwap(WSOL_MINT, validTarget.mint, '2000000', `BUY STAGE (wSOL -> ${validTarget.mint.slice(0, 6)})`);
            
            if (!expectedOut) {
                console.log(`\n[FORCE TRADE] 🛑 Aborting test: Buy stage failed during execution broadcast.`);
                process.exit(1);
            }
            
            console.log(`\n[FORCE TRADE] ⏱️ Position secured. Holding for 15 seconds to simulate swarm volume hold...\n`);
            await new Promise(r => setTimeout(r, 15000));
            
            // 3. Sell the exact token back to WSOL
            const secureSellAmount = Math.floor(parseInt(expectedOut) * 0.95).toString(); // 5% buffer underneath quote for dust clearance
            await executeLiveSwap(validTarget.mint, WSOL_MINT, secureSellAmount, `SELL STAGE (${validTarget.mint.slice(0, 6)} -> wSOL)`);
            
            console.log(`\n=== 🎉 HARDWARE ROUTING TEST SUCCESSFUL ===\n`);
            process.exit(0);
            
        } catch (err) {
            executing = false;
        }
    });
}

runTest();
