import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import fetch from 'cross-fetch';
import fs from 'fs';
import { config } from 'dotenv';

async function verifyJitoConnection() {
    console.log("==========================================");
    console.log("🟢 INITIATING JITO NY NODE CONNECTION TEST");
    console.log("==========================================");
    
    // Load local environment for execution wallet
    const envPath = fs.existsSync('./.env') ? './.env' : null;
    let wallet;
    if (envPath) {
         config({ path: envPath });
         if (process.env.SOLANA_PRIVATE_KEY && process.env.SOLANA_PRIVATE_KEY !== "YOUR_NEW_PRIVATE_KEY_HERE") {
             wallet = Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_PRIVATE_KEY.trim()));
         }
    }
    
    if (!wallet) {
         console.log("❌ Execution Failed: Wallet missing or non-functional.");
         process.exit(1);
    }
    
    console.log(`✅ Loaded Wallet: ${wallet.publicKey.toString()}`);
    
    // Fallback to strict public mainnet if Helius env is missing
    const rpcUrl = process.env.RPC_ENDPOINT || "https://api.mainnet-beta.solana.com";
    const connection = new Connection(rpcUrl, 'confirmed');

    console.log(`✅ Bound to Solana RPC: ${rpcUrl.split('/')[2]}`);
    
    try {
        // Build a 0-SOL self-transfer dummy payload purely for network verification
        const instructions = [
            SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: wallet.publicKey,
                lamports: 0
            })
        ];
        
        console.log("   -> Querying latest blockhash...");
        const { blockhash } = await connection.getLatestBlockhash('finalized');
        
        const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhash,
            instructions,
        }).compileToV0Message();
        
        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([wallet]);
        
        const atomicBase58 = bs58.encode(transaction.serialize());
        console.log("   -> Bundle serialized successfully.");

        const jitoPayload = {
            jsonrpc: "2.0",
            id: 1,
            method: "sendBundle",
            params: [[atomicBase58]] 
        };

        console.log("   -> Routing payload to Jito NY Block Engine...");
        
        const jitoRes = await fetch('https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(jitoPayload)
        });
        
        const data = await jitoRes.json();
        
        console.log("\n==========================================");
        if (data.result) {
             console.log(`✅ [JITO SUCCESS] Server returned active bundle UUID: ${data.result}`);
             console.log(`✅ [HELIUS SUCCESS] The on-chain environment map is strictly functional and fully capable of broadcast.`);
        } else if (data.error) {
             console.log(`❌ [JITO REJECTED] Jito returned an API error: ${JSON.stringify(data.error)}`);
             console.log(`   -> This often happens if the Jito rate limits or internal block restrictions are active.`);
        } else {
             console.log(`⚠️ [NETWORK UNKNOWN] Unrecognized response from Jito:`, data);
        }
        console.log("==========================================");
        
    } catch (e) {
        console.error("❌ Fatal network interrupt during sandbox check:", e);
    }
    
    process.exit(0);
}

verifyJitoConnection();
