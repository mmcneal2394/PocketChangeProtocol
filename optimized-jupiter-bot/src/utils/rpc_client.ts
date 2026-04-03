import Redis from 'ioredis';
import { randomUUID } from 'crypto';

let redis: Redis | null = null;
function getRedis() {
    if (!redis) {
        redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null });
        redis.connect().catch(() => {});
    }
    return redis;
}

/**
 * Asynchronously calls the central RPC Gateway handling Helius rate-limits.
 */
export async function callRpcGateway(method: string, params: any[]): Promise<any> {
    const id = randomUUID();
    const payload = { id, method, params };

    return new Promise((resolve, reject) => {
        // Subscribe to our specific response channel
        const sub = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
        
        let timeout: NodeJS.Timeout;

        sub.subscribe(`rpc:response:${id}`, (err) => {
            if (err) {
                clearTimeout(timeout);
                sub.disconnect();
                return reject(err);
            }

            // Push the request to the central queue
            getRedis().lpush('rpc:queue', JSON.stringify(payload));
        });

        sub.on('message', (channel, message) => {
            if (channel === `rpc:response:${id}`) {
                clearTimeout(timeout);
                sub.unsubscribe(`rpc:response:${id}`);
                sub.disconnect();

                try {
                    const data = JSON.parse(message);
                    if (data.success) {
                        resolve(data.result);
                    } else {
                        reject(new Error(data.error));
                    }
                } catch (e) {
                    reject(e);
                }
            }
        });

        // 10s timeout mechanism
        timeout = setTimeout(() => {
            sub.unsubscribe(`rpc:response:${id}`);
            sub.disconnect();
            reject(new Error(`[RPC CLIENT] Gateway Timeout for method ${method}`));
        }, 10_000);
    });
}
