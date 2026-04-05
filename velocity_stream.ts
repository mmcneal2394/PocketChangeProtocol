import { Connection, PublicKey, Logs } from '@solana/web3.js';
import Redis from 'ioredis';
import { config } from 'dotenv';
import WebSocket from 'ws';

config();

const HELIUS_WSS = (process.env.RPC_WEBSOCKET || process.env.HELIUS_WSS_URL || 'wss://api.mainnet-beta.solana.com').trim();
const RPC_HTTP = (process.env.RPC_ENDPOINT || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com').trim();
const REDIS_URL = (process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim();

const redis = new Redis(REDIS_URL);
const connection = new Connection(RPC_HTTP, { wsEndpoint: HELIUS_WSS, commitment: 'confirmed' });

// Known AMM program IDs on Solana
const AMM_PROGRAMS = [
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium CPMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Orca
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora DLMM
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // Pump.fun — primary volume source, re-enabled after RPC fix
  '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', // Meteora Pools
].map(addr => new PublicKey(addr));

let currentSubId: number | null = null;
let rawMsgCount = 0;

// Cache to avoid refetching the exact same mint or signature constantly
const sigCache = new Set<string>();
const recentMints = new Set<string>();

async function fetchTxMint(signature: string): Promise<string | null> {
    try {
        const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        if (!tx) return null;
        
        const SKIP = new Set([
          'So11111111111111111111111111111111111111112', '11111111111111111111111111111111', 
          'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv',
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        ]);
        
        if (tx.meta && tx.meta.postTokenBalances) {
            for (const bal of tx.meta.postTokenBalances) {
                const mint = bal.mint;
                if (!SKIP.has(mint)) {
                    return mint;
                }
            }
        }
    } catch (e) {
        // RPC might fail or rate limit
    }
    return null;
}

const txMintQueue: { signature: string; context: any }[] = [];

async function processQueue() {
    if (txMintQueue.length > 0) {
        const item = txMintQueue.shift();
        if (item) {
            try {
                const mint = await fetchTxMint(item.signature);
                if (mint && !recentMints.has(mint)) {
                    recentMints.add(mint);
                    if (recentMints.size > 1000) {
                        const iter = recentMints.values();
                        recentMints.delete(iter.next().value!);
                    }
                    console.log(`[VELOCITY] SPIKE MINT ISOLATED: ${mint}`);
                    redis.publish('VELOCITY_SPIKE', JSON.stringify({ mints: [mint], slot: item.context.slot }));
                }
            } catch (e) {}
        }
    }
    setTimeout(processQueue, 500); // 2 TPS — conserve RPC credits
}
processQueue();

function handleLogs(logs: Logs, context: any) {
  try {
    if (logs.err) return;
    if (sigCache.has(logs.signature)) return;
    
    // Check if it's a valid swap or initialize event
    const isSwapEvent = logs.logs.some(l => l.includes('Swap') || l.includes('swap') || l.includes('Instruction: Buy') || l.includes('Initialize'));
    if (!isSwapEvent) return;
    
    sigCache.add(logs.signature);
    if (sigCache.size > 2000) {
        const iter = sigCache.values();
        sigCache.delete(iter.next().value!);
    }
    
    // Limit unbounded queue growth
    if (txMintQueue.length < 50) {
        txMintQueue.push({ signature: logs.signature, context });
    }
  } catch (err) {
    console.error('[VELOCITY] Error processing logs:', err);
  }
}

let subIds: number[] = [];

function subscribe() {
  if (subIds.length > 0) {
    subIds.forEach(id => connection.removeOnLogsListener(id).catch(() => {}));
    subIds = [];
  }

  for (const amm of AMM_PROGRAMS) {
      try {
          const subId = connection.onLogs(
            amm,
            handleLogs,
            'confirmed'
          );
          subIds.push(subId);
      } catch (err) {
          console.error('[VELOCITY] Subscription failed for', amm.toBase58(), err);
          setTimeout(subscribe, 5000);
          return;
      }
  }
  console.log(`[VELOCITY] Subscribed with ${subIds.length} listeners`);
}

subscribe();

// Optional: raw WebSocket logging for first 10 messages
const rawWs = new WebSocket(HELIUS_WSS);
rawWs.on('message', (data: Buffer) => {
  const str = data.toString();
  if (rawMsgCount++ < 10) console.log('[VELOCITY] RAW WS:', str.slice(0, 500));
});

// subscribe() only called once above — duplicate removed to halve WS connection & RPC burn

// Heartbeat every 10 seconds
setInterval(() => {
  redis.publish('HEARTBEAT', JSON.stringify({
    agent: 'velocity-stream',
    status: 'alive',
    lastMintMs: Date.now(),
    subId: currentSubId
  }));
}, 10000);
