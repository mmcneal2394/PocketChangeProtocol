import { Connection, PublicKey } from '@solana/web3.js';
import Redis from 'ioredis';
import { RateLimiter } from 'limiter';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

// 15 requests per second to safely stay under Helius 50 limit and free-tier latency ceilings
const limiter = new RateLimiter({ tokensPerInterval: 15, interval: 'second' });

// Rotate around available RPC nodes
const endpoints = [
  process.env.RPC_ENDPOINT,
].filter(Boolean) as string[];

if (endpoints.length === 0) {
    endpoints.push('https://api.mainnet-beta.solana.com');
}

let currentEndpoint = 0;

function getConnection() {
  return new Connection(endpoints[currentEndpoint % endpoints.length], 'confirmed');
}

function reviveParams(params: any[]) {
    return params.map(p => {
        // Automatically convert valid base58 strings back to PublicKeys
        if (typeof p === 'string' && p.length >= 32 && p.length <= 44 && !p.includes(' ')) {
            try { return new PublicKey(p); } catch (e) { return p; }
        }
        if (typeof p === 'object' && p !== null) {
             if (p.programId && typeof p.programId === 'string') {
                 try { p.programId = new PublicKey(p.programId); } catch(e){}
             }
             if (p.mint && typeof p.mint === 'string') {
                 try { p.mint = new PublicKey(p.mint); } catch(e){}
             }
        }
        return p;
    });
}

async function handleRequest(method: keyof Connection, params: any[]): Promise<any> {
  await limiter.removeTokens(1); // blocks until a token is available
  const conn = getConnection();
  const revivedParams = reviveParams(params);
  try {
    const fn = conn[method] as unknown as Function;
    const result = await fn.apply(conn, revivedParams);
    
    // Rotate dynamically on success so we distribute load globally if there are multiple limits
    currentEndpoint++; 
    return result;
  } catch (e: any) {
    if (e.message?.includes('429')) {
         console.warn(`[RPC GATEWAY] 429 Too Many Requests -> Rotating Endpoint`);
         currentEndpoint++;
         const conn2 = getConnection();
         const fn2 = conn2[method] as unknown as Function;
         return await fn2.apply(conn2, params);
    }
    throw e;
  }
}

async function startGatewayLoop() {
  console.log(`[RPC GATEWAY] 🛡️ Online! Managing limits across ${endpoints.length} nodes (50 TPS max). Listening to rpc:queue...`);
  
  const processQueue = async () => {
    try {
      // brpop blocks for 1 second max
      const reply = await redis.brpop('rpc:queue', 1);
      if (reply) {
        const payloadStr = reply[1];
        const payload = JSON.parse(payloadStr);

        if (payload.id && payload.method && payload.params) {
            handleRequest(payload.method as keyof Connection, payload.params)
               .then((result) => {
                   redis.publish(`rpc:response:${payload.id}`, JSON.stringify({ success: true, result }));
               })
               .catch((error) => {
                   redis.publish(`rpc:response:${payload.id}`, JSON.stringify({ success: false, error: error.message }));
               });
        }
      }
    } catch (e: any) {
       console.error(`[RPC GATEWAY] Queue Processing Error:`, e.message);
    } finally {
       // Re-enter event loop immediately
       setImmediate(processQueue);
    }
  };

  processQueue();
}

startGatewayLoop();
