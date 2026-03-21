import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import fs from 'fs';

const JUPITER_API = 'https://lite-api.jup.ag';
const RPC_ENDPOINT = 'https://solana-mainnet.core.chainstack.com/95d603f3d634acfbf2ac5a57a32baf97';

async function testBuy() {
    console.log('⚡ Constructing physical test transaction via Droplet (0.001 SOL -> RAY)...');
    
    // 1. Get Wallet
    const secretKeyStr = fs.readFileSync('c:/pcprotocol/optimized-jupiter-bot/new_wallet.json', 'utf8');
    const secretKeyArr = Uint8Array.from(JSON.parse(secretKeyStr));
    const wallet = Keypair.fromSecretKey(secretKeyArr);
    const connection = new Connection(RPC_ENDPOINT, 'confirmed');

    console.log('Wallet Base58 Pubkey:', wallet.publicKey.toString());
    const balance = await connection.getBalance(wallet.publicKey);
    console.log('Confirmed Droplet Balance:', balance / 1000000000, 'SOL');

    // 2. Quote & build order via Ultra API
    console.log('Fetching Premium Swap Pro Quote via Ultra API...');
    const orderRes = await fetch(`${JUPITER_API}/ultra/v1/order?inputMint=So11111111111111111111111111111111111111112&outputMint=EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYtM2wYSzLz&amount=1000000&slippageBps=50&taker=${wallet.publicKey.toString()}`);
    
    if (!orderRes.ok) {
         console.error('[QUOTE API ERROR]', await orderRes.text());
         return;
    }
    
    const orderData = await orderRes.json();
    const swapTransaction = orderData.swapTransaction;
    const requestId = orderData.requestId;
    
    // 3. Sign
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    var transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    transaction.sign([wallet]);
    
    // 4. Send
    console.log('🚀 Pushing to Jupiter Ultra RPC-less server out of DigitalOcean...');
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
        const txid = executeData.replace(/["\n]/g, '');
        
        console.log(`\n✅ Transaction Broadcasted!`);
        console.log(`🔗 Verification Link: https://solscan.io/tx/${txid}`);

        // Wait strictly for network confirmation
        console.log(`⏳ Awaiting strict validator confirmation barrier...`);
        const latestBlockHash = await connection.getLatestBlockhash();
        const confirmation = await connection.confirmTransaction({
             blockhash: latestBlockHash.blockhash,
             lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
             signature: txid
        });

        if (confirmation.value.err) {
             console.error(`❌ Transaction failed on chain:`, confirmation.value.err);
        } else {
             console.log(`✨ TRANSACTION CONFIRMED AT BLOCK `, await connection.getSlot());
        }

    } catch(e) {
        console.error("Execution Error:", e);
    }
}

testBuy();
