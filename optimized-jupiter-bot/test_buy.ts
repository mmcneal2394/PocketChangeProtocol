import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import fetch from 'node-fetch';
import fs from 'fs';
import { config } from './src/utils/config';

const JUPITER_API = 'https://lite-api.jup.ag';

async function testBuy() {
    console.log('⚡ Constructing physical test transaction (0.001 SOL -> USDC)...');
    
    // 1. Get Wallet
    const secretKeyStr = fs.readFileSync(config.WALLET_KEYPAIR_PATH, 'utf8');
    const secretKeyArr = Uint8Array.from(JSON.parse(secretKeyStr));
    const wallet = Keypair.fromSecretKey(secretKeyArr);
    const connection = new Connection(config.RPC_ENDPOINT, 'confirmed');

    const API_KEY = config.JUPITER_API_KEY || 'YOUR_JUPITER_API_KEY';

    // 2. Quote & Swap Ix via Ultra API
    const orderRes = await fetch(`${JUPITER_API}/ultra/v1/order?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50&taker=${wallet.publicKey.toString()}`);
    
    if (!orderRes.ok) {
        console.error("Jupiter Order Error:", await orderRes.text());
        return;
    }
    
    const orderData: any = await orderRes.json();
    const swapTransaction = orderData.swapTransaction;
    const requestId = orderData.requestId;
    
    // 3. Sign
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);
    
    // 4. Send via Ultra Execute
    console.log('🚀 Pushing to Jupiter Ultra RPC-less server...');
    const signedTransaction = Buffer.from(transaction.serialize()).toString('base64');
    
    try {
        const executeRes = await fetch(`${JUPITER_API}/ultra/v1/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                signedTransaction,
                requestId
            })
        });
        
        if (!executeRes.ok) {
            console.error("Jupiter Execute Error:", await executeRes.text());
            return;
        }
        
        const executeData = await executeRes.text();
        const txid = executeData.replace(/["\n]/g, ''); // Could be generic string or part of JSON depending on implementation. Usually string for txid.
        console.log(`\n✅ Transaction Landed Successfully!`);
        console.log(`🔗 Verification Link: https://solscan.io/tx/${txid}`);
    } catch(e) {
        console.error("Execution Error:", e);
    }
}

testBuy();
