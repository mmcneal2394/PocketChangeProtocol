import Redis from 'ioredis';

// Singleton instance to prevent multiple redundant connections
class RedisBus {
    private static publisher: Redis | null = null;
    private static subscriber: Redis | null = null;
    
    // Connects to a local Redis server (default 6379 natively or via Docker)
    private static readonly REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

    /**
     * Get the singleton Publisher instance (used for writing data fast)
     */
    static getPublisher(): Redis {
        if (!this.publisher) {
            this.publisher = new Redis(this.REDIS_URL, {
                retryStrategy: (times) => Math.min(times * 50, 2000),
                maxRetriesPerRequest: 3,
            });
            
            this.publisher.on('error', (err) => {
                console.error('[REDIS] ⚠️ Publisher connection error:', err.message);
            });
            this.publisher.on('connect', () => {
                console.log('[REDIS] ✅ Publisher connected natively');
            });
        }
        return this.publisher;
    }

    /**
     * Get the singleton Subscriber instance (requires an isolated connection for pub/sub)
     */
    static getSubscriber(): Redis {
        if (!this.subscriber) {
            this.subscriber = new Redis(this.REDIS_URL, {
                retryStrategy: (times) => Math.min(times * 50, 2000),
                maxRetriesPerRequest: 3,
            });

            this.subscriber.on('error', (err) => {
                console.error('[REDIS] ⚠️ Subscriber connection error:', err.message);
            });
            this.subscriber.on('connect', () => {
                console.log('[REDIS] ✅ Subscriber connected natively');
            });
        }
        return this.subscriber;
    }

    /**
     * Publishes a fully-typed JSON payload to the specified topic.
     * Replaces fs.writeFileSync entirely.
     */
    static async publish(channel: string, payload: any) {
        const pub = this.getPublisher();
        try {
            await pub.publish(channel, JSON.stringify(payload));
        } catch (e: any) {
            console.error(`[REDIS] Publish failed on ${channel}: ${e.message}`);
        }
    }
}

export default RedisBus;
