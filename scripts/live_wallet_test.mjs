import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { performance } from "perf_hooks";

// Extracted from user's encrypted jarvis files
const LIVE_PRV_KEYS = [
    "5vewERBqeRo67iKyzbfKqydTiwUFZLn8TUNexoDhuAaCWWzHjnPQJ34kspW3SGFkwaA51evwJW7Fm6uHXgGWKjMH",
    "3S9RdpPiLEKkdfPh2ZUbtqiEVqwzaj36MpkERYJTSwcpFSusJaGPa2v2g77UPpBn3SaivnZeKCUNBoq17yJXovC5",
    "2Ky7YpR5cScjrHzrhbqDASpCjJ5ZwKhiBk8PG1q7J6oj7KHKgGUJL8zJPFR75uh2RmqZc1JZp9nWfW6Xv5smSYUQ",
    "5PiLJZzuFcoudP4muKgC9zBuS5st17W5vi1tZgrysFH8J5cQquWkHQ17b6WFQcukW5xmxh9ZBRao3ZR1FQfwwZcn",
    "gbjgBYYSUGGupd28N9Pk9syHiUeGerKdtR2Md9iG39RcajPPtGUn8cxa88tYjkANjiDuyoheYx7TZXcS6GtdAbw",
    "5mtN9ZxktTX1WJx5dpEvkPcmHQ6JwxLU3WYPEamjYZTBE91r6kx7gPZnm6tZSZfFWtn8gUJhxTEciFebhoKMsSXf"
];

// Extracted from user's arbitrabot_config.json
const RPC_ENDPOINT = "https://beta.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY";

console.log(`\n🚀 ArbitraSaaS Live API & Wallet Integration Test`);
console.log(`=================================================`);
console.log(`🔌 Trying RPC Cluster: ${RPC_ENDPOINT.split('?')[0]}`);

async function testLiveWallets() {
    try {
        const connection = new Connection(RPC_ENDPOINT, "confirmed");
        
        // 1. Check RPC latency
        console.log(`\n[1] Pinging RPC provider...`);
        const startRpc = performance.now();
        const blockhash = await connection.getLatestBlockhash();
        const rpcLat = (performance.now() - startRpc).toFixed(2);
        console.log(`✅ Fetched Latest Blockhash: ${blockhash.blockhash} (Latency: ${rpcLat}ms)`);

        // 2. Hydrate SaaS wallets manually
        console.log(`\n[2] Checking live on-chain balances for SaaS wallets...`);
        let wallets = [];
        
        for (let i = 0; i < LIVE_PRV_KEYS.length; i++) {
            try {
                const keypair = Keypair.fromSecretKey(bs58.decode(LIVE_PRV_KEYS[i]));
                const pubKey = keypair.publicKey;
                
                const balStart = performance.now();
                const balLamps = await connection.getBalance(pubKey);
                const balLat = (performance.now() - balStart).toFixed(2);
                
                const sol = (balLamps / 1e9).toFixed(4);
                
                wallets.push({
                    pubKey: pubKey.toString(),
                    sol,
                    latency: balLat
                });
                
                console.log(`   🔸 Tenant ${i+1}: ${pubKey.toString()} | Balance: ${sol} SOL (Fetched in ${balLat}ms)`);
            } catch (err) {
                console.log(`   ❌ Key ${i+1} Failed: ${err.message}`);
            }
        }
        
        console.log(`\n✅ Successfully validated ${wallets.length} private keys on mainnet!`);
        
    } catch (e) {
        console.error(`❌ Critical Failure connecting to Solana network: `, e);
    }
}

testLiveWallets();
