import { Connection, PublicKey } from '@solana/web3.js';
import Redis from 'ioredis';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const WS_RPC = process.env.RPC_WEBSOCKET || process.env.RPC_ENDPOINT?.replace('https', 'wss') || 'wss://api.mainnet-beta.solana.com';
const HTTP_RPC = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';

const connection = new Connection(HTTP_RPC, {
    wsEndpoint: WS_RPC,
    commitment: 'processed'
});

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const RAYDIUM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

let interceptCount = 0;

console.log(`[SNIPER] 🚀 Pump.fun "Migration" Sub-Zero Sniper Online.`);
console.log(`[SNIPER] 📡 WebSocket Subscribed: ${WS_RPC.slice(0, 30)}...`);

connection.onLogs(RAYDIUM_V4, async (log) => {
    if (log.err) return; // Ignore failed instructions
    
    const logs = log.logs;
    const isInitialization = logs.some(l => l.includes('InitializeInstruction2') || l.includes('GetStructure'));

    if (isInitialization) {
        interceptCount++;
        console.log(`[SNIPER] 🚨 BLOCK 0 DETECTION! Raydium v4 InitializeInstruction intercepted in tx: ${log.signature}`);

        try {
            // Rapid fetch the transaction to extract the Mint (Wait ~1500ms since 'processed' WS logs might pre-date the RPC database by a tick)
            await new Promise(r => setTimeout(r, 1500));

            const tx = await connection.getParsedTransaction(log.signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
            if (!tx || !tx.transaction.message.accountKeys) return;
            
            const accounts = tx.transaction.message.accountKeys.map(a => a.pubkey.toBase58());
            
            const wsol = "So11111111111111111111111111111111111111112";
            const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
            
            // Look explicitly for pump.fun mint sequences traversing Raydium pools
            const potentialMints = accounts.filter(a => a !== wsol && a !== usdc && a !== RAYDIUM_V4.toBase58() && a.endsWith('pump'));

            if (potentialMints.length > 0) {
                const targetMint = potentialMints[0];
                console.log(`[SNIPER] 💉 EXTRACTED MIGRATION MINT: ${targetMint}`);
                
                // Blast to momentum_sniper natively bypassing validation
                const payload = {
                    mint: targetMint,
                    buys60s: 999, // Extreme forced velocity priority
                    sells60s: 0,
                    velocity: 99.9,
                    buyRatio60s: 1.0,
                    solVolume60s: 50,
                    isAccelerating: true
                };

                await redis.publish('stream:velocity', JSON.stringify(payload));
                console.log(`[SNIPER] 🚀 TARGET VECTOR LAUNCHED TO SWARM CORE: ${targetMint}`);
            }

        } catch (e: any) {
            console.error(`[SNIPER] ⚠️ Error deserializing Block 0 Target: ${e.message}`);
        }
    }
}, 'processed');
