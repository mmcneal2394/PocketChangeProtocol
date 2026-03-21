require('dotenv').config();
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const { createJupiterApiClient } = require('@jup-ag/api');
const fs = require('fs');

async function checkSpeeds() {
    console.log("🚦 Initiating explicit Ultra Architecture Latency Test...");
    
    const connection = new Connection(process.env.RPC_ENDPOINT, { commitment: 'processed' });
    const jupiter = createJupiterApiClient({ basePath: process.env.JUPITER_ULTRA_ENDPOINT });
    
    const walletSecret = JSON.parse(fs.readFileSync(process.env.WALLET_KEYPAIR_PATH, 'utf-8'));
    const wallet = Keypair.fromSecretKey(new Uint8Array(walletSecret));
    
    console.log("💳 Wallet:", wallet.publicKey.toBase58());
    
    // 1. Get Quote
    console.log("📊 Quoting SOL -> USDC (0.001 SOL)...");
    const quote = await jupiter.quoteGet({
        inputMint: "So11111111111111111111111111111111111111112",
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        amount: 1000000, // 0.001 SOL
        slippageBps: 50,
        onlyDirectRoutes: false,
        asLegacyTransaction: false
    });
    
    // 2. Build Transaction
    console.log("📦 Building payload...");
    const swapRes = await jupiter.swapPost({
        swapRequest: {
            quoteResponse: quote,
            userPublicKey: wallet.publicKey.toBase58(),
            dynamicComputeUnitLimit: true
        }
    });
    
    const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, 'base64'));
    tx.sign([wallet]);
    
    // 3. Execution Timers
    console.log("🚀 Firing transaction into ShadowLane...");
    const broadcastStart = Date.now();
    const signature = await connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    const broadcastEnd = Date.now();
    
    console.log(`\n\t⚡ Broadcast Latency: ${broadcastEnd - broadcastStart}ms`);
    
    const confirmStart = Date.now();
    const latestBlockhash = await connection.getLatestBlockhash('processed');
    await connection.confirmTransaction({
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
    }, 'processed');
    const confirmEnd = Date.now();
    
    console.log(`\t⚡ Inclusion Latency: ${confirmEnd - confirmStart}ms`);
    console.log(`\n✅ Speed Test Complete! TX: ${signature}`);
    process.exit(0);
}

checkSpeeds().catch(e => {
    console.error(e);
    process.exit(1);
});
