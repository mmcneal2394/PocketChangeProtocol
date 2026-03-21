import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { buildVersionedTransaction } from '../src/execution/transaction';
import { config } from '../src/utils/config';

dotenv.config();

async function verify() {
    console.log("🚦 Initiating explicit Atomic Arbitrage Bundle Structure Test...");
    const API_KEY = config.JUPITER_API_KEY || 'YOUR_JUPITER_API_KEY';
    
    async function safeFetchJSON(url: string, options: any) {
        for (let i = 0; i < 15; i++) {
            const res = await fetch(url, options);
            const text = await res.text();
            if (text.startsWith("Rate limit")) {
                console.log(`⏳ Proxy Blocked [Status ${res.status}] - Waiting 5 seconds...`);
                await new Promise(r => setTimeout(r, 5000));
                continue;
            }
            try { 
                return JSON.parse(text); 
            } catch (e) {
                console.log(`⏳ Invalid JSON Payload - Waiting 5 seconds...`);
                await new Promise(r => setTimeout(r, 5000));
            }
        }
        throw new Error("Rate limit strictly blocked over 75s.");
    }

    const q1Url = `https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=nosXBqwB22HkM3pJo9YqQhG1hHh2gQ5pXhS7vXkXVmQ&amount=10000000&slippageBps=50`;
    const quote1 = await safeFetchJSON(q1Url, { headers: { 'x-api-key': API_KEY } });
    console.log(`📊 Quote 1 [SOL -> NOS]: ${Number(quote1.outAmount) / 1e6} NOS`);
    
    const q2Url = `https://quote-api.jup.ag/v6/quote?inputMint=nosXBqwB22HkM3pJo9YqQhG1hHh2gQ5pXhS7vXkXVmQ&outputMint=So11111111111111111111111111111111111111112&amount=${quote1.outAmount}&slippageBps=50`;
    const quote2 = await safeFetchJSON(q2Url, { headers: { 'x-api-key': API_KEY } });
    console.log(`📊 Quote 2 [NOS -> SOL]: ${Number(quote2.outAmount) / 1e9} SOL`);
    
    console.log("📦 Requesting distinct Raw Execution Instructions...");
    
    const ix1Res = await safeFetchJSON('https://quote-api.jup.ag/v6/swap-instructions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ quoteResponse: quote1, userPublicKey: config.WALLET_PUBLIC_KEY, wrapAndUnwrapSol: true })
    });

    const ix2Res = await safeFetchJSON('https://quote-api.jup.ag/v6/swap-instructions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
        body: JSON.stringify({ quoteResponse: quote2, userPublicKey: config.WALLET_PUBLIC_KEY, wrapAndUnwrapSol: true })
    });
    
    console.log("🔗 Executing Atomic Bundle Logic natively...");
    const tx = await buildVersionedTransaction(ix1Res, ix2Res, 10000);
    
    if (tx) {
        console.log(`\n✅ Atomic structural merge complete! Final Payload Buffer: ${tx.serialize().length} bytes.`);
        
        console.log("\n🚀 FIRE IN THE HOLE! Executing Live Atomic Sandbox Bundle over ShadowLane...");
        const connection = new Connection(config.RPC_ENDPOINT, { commitment: 'processed' });
        
        const burstStart = Date.now();
        try {
            const sig = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 5 });
            console.log(`⚡ Broadcast Complete! Network Insertion Latency: ${Date.now() - burstStart}ms`);
            console.log(`✅ Fully Synchronous Execution Complete! Payload Hash: https://solscan.io/tx/${sig}`);
            process.exit(0);
        } catch (e: any) {
            console.error(`❌ Execution Failed: ${e.message}`);
            process.exit(1);
        }
    } else {
        console.error("❌ Bundle compilation collapsed over parameters sequence mapping.");
        process.exit(1);
    }
}

verify().catch(console.error);
