import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { performance } from "perf_hooks";

// Extracted from user's encrypted jarvis files
const LIVE_PRV_KEYS = (process.env.WALLET_SECRET_KEYS_B58 || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

// Extracted from user's arbitrabot_config.json
const RPC_ENDPOINT = "https://beta.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY";

console.log(`\n🚀 ArbitraSaaS Live API & Wallet Integration Test`);
console.log(`=================================================`);
console.log(`🔌 Trying RPC Cluster: ${RPC_ENDPOINT.split('?')[0]}`);

async function testLiveWallets() {
    try {
        if (LIVE_PRV_KEYS.length === 0) {
            console.log('No WALLET_SECRET_KEYS_B58 values provided. Skipping live wallet validation.');
            return;
        }
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
