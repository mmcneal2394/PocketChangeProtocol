import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import fetch from 'node-fetch';
import fs from 'fs';
import { config } from './src/utils/config';

const JUPITER_API = 'https://public.jupiterapi.com';

async function testBuy() {
    console.log('⚡ Constructing physical test transaction (0.001 SOL -> USDC)...');
    
    // 1. Get Wallet
    const secretKeyStr = fs.readFileSync(config.WALLET_KEYPAIR_PATH, 'utf8');
    const secretKeyArr = Uint8Array.from(JSON.parse(secretKeyStr));
    const wallet = Keypair.fromSecretKey(secretKeyArr);
    const connection = new Connection(config.RPC_ENDPOINT, 'confirmed');

    // 2. Quote
    const quoteRes = await fetch(`${JUPITER_API}/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000&slippageBps=50`);
    const quoteData = await quoteRes.json();
    
    // 3. Swap Ix
    const swapRes = await fetch(`${JUPITER_API}/swap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            quoteResponse: quoteData,
            userPublicKey: wallet.publicKey.toString(),
            wrapAndUnwrapSol: true,
            prioritizationFeeLamports: 10000
        })
    });
    
    if (!swapRes.ok) {
        console.error("Jupiter Swap Error:", await swapRes.text());
        return;
    }
    
    const swapData: any = await swapRes.json();
    const swapTransaction = swapData.swapTransaction;
    
    // 4. Send
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);
    
    console.log('🚀 Pushing to Chainstack RPC Mainnet...');
    const rawTransaction = transaction.serialize();
    
    try {
        const txid = await connection.sendRawTransaction(rawTransaction, {
            skipPreflight: true,
            maxRetries: 2
        });
        
        console.log(`\n✅ Transaction Landed Successfully!`);
        console.log(`🔗 Verification Link: https://solscan.io/tx/${txid}`);
    } catch(e) {
        console.error("RPC Error:", e);
    }
}

testBuy();
