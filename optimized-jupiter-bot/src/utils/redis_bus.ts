import Redis from 'ioredis';

let publisher: Redis | null = null;
let subscriber: Redis | null = null;

function createRedisClient(): Redis {
  if (process.env.REDIS_URL) {
    return new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }

  return new Redis({
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB || 0),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}

const RedisBus = {
  getPublisher(): Redis {
    if (!publisher) publisher = createRedisClient();
    return publisher;
  },

  getSubscriber(): Redis {
    if (!subscriber) subscriber = createRedisClient();
    return subscriber;
  },

  async publish(channel: string, payload: any): Promise<void> {
    const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
    await RedisBus.getPublisher().publish(channel, message);
  },
};

export default RedisBus;
module.exports = RedisBus;
