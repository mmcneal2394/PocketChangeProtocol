require('dotenv').config();
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const { createJupiterApiClient } = require('@jup-ag/api');
const fs = require('fs');
const https = require('https');

async function sweep() {
    console.log("🧹 EMERGENCY SWEEPER: Exiting stranded positions back to SOL...");
    const connection = new Connection(process.env.RPC_ENDPOINT, { commitment: 'confirmed' });
    const jupiter = createJupiterApiClient({ basePath: process.env.JUPITER_ULTRA_ENDPOINT });
    const walletSecret = JSON.parse(fs.readFileSync(process.env.WALLET_KEYPAIR_PATH, 'utf-8'));
    const wallet = Keypair.fromSecretKey(new Uint8Array(walletSecret));

    const MEMORY_FILE = 'buys_memory.json';
    if (!fs.existsSync(MEMORY_FILE)) {
        console.log("✅ No positions found in memory.");
        return;
    }

    let memory = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
    const SOL_MINT = 'So11111111111111111111111111111111111111112';

    for (const [mint, pos] of Object.entries(memory)) {
        if (!pos.amountLamports) continue;
        console.log(`\n📦 Dumping Token: ${mint} (Spent ${pos.solSpent} SOL originally)`);
        try {
            const quote = await jupiter.quoteGet({
                inputMint: mint,
                outputMint: SOL_MINT,
                amount: pos.amountLamports.toString(),
                slippageBps: 200 // Higher slippage to ensure exit
            });
            
            console.log(`   Estimated Return: ${Number(quote.outAmount) / 1e9} SOL`);
            
            const swapRes = await jupiter.swapPost({
                swapRequest: { quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(), dynamicComputeUnitLimit: true }
            });

            const tx = VersionedTransaction.deserialize(Buffer.from(swapRes.swapTransaction, 'base64'));
            tx.sign([wallet]);

            const sig = await connection.sendTransaction(tx, { maxRetries: 5 });
            console.log(`   ✅ Transaction sent: https://solscan.io/tx/${sig}`);
            
            delete memory[mint];
            fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
            
            await new Promise(r => setTimeout(r, 2000));
        } catch (e) {
            console.error(`   ❌ Failed to dump ${mint}: ${e.message}`);
        }
    }
    console.log("\n✅ Bag Sweep completely resolved.");
}

sweep().catch(console.error);
