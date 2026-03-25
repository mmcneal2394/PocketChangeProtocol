import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';
import { globalPriceBook } from '../local_calc/price_book';
import { globalArbEngine } from '../local_calc/arb_engine';

// ── Geyser subscription request (shared between connect attempts) ─────────────
const SUBSCRIPTION_REQUEST = {
  accounts: {
    raydium_pools: { account: ["58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUvbMT12EzEQBd"], owner: [], filters: [] },
    orca_pools:    { account: [], owner: ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"], filters: [] },
    meteora_pools: { account: [], owner: ["Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"], filters: [] },
  },
  slots: {}, transactions: {}, transactionsStatus: {}, blocks: {}, blocksMeta: {},
  entry: {}, accountsDataSlice: [], ping: undefined, commitment: 1, // Processed
};

// ── Data handler — wired to both real and mock streams ────────────────────────
async function onGeyserData(data: any) {
  if (data?.account) {
    globalPriceBook.updatePool(data.account);
    await globalArbEngine.runArbitrageScan();
  }
}

// ── Real Geyser connection with exponential-backoff reconnect ─────────────────
async function connectWithReconnect(Client: any, attempt = 0): Promise<{ client: any; stream: any }> {
  const delayMs = Math.min(2000 * Math.pow(2, attempt), 30_000); // 2s → 4s → 8s → 30s cap
  if (attempt > 0) {
    logger.warn(`[GEYSER] Reconnect attempt #${attempt} in ${delayMs / 1000}s…`);
    await new Promise(r => setTimeout(r, delayMs));
  }

  try {
    // v0.6.0 API: Client(endpoint_with_https, xToken, channelOptions)
    // No .connect() method — call .subscribe() directly
    const endpoint = config.GEYSER_RPC.startsWith('http')
      ? config.GEYSER_RPC
      : `https://${config.GEYSER_RPC}`;
    const client = new Client(endpoint, config.GEYSER_API_TOKEN, undefined);
    const stream = await client.subscribe();
    stream.write(SUBSCRIPTION_REQUEST);

    // ── Reconnect triggers ─────────────────────────────────────────────────────
    stream.on('error', (err: any) => {
      logger.error(`[GEYSER] Stream error: ${err?.message || err} — reconnecting…`);
      stream.destroy?.();
      connectWithReconnect(Client, attempt + 1).catch(() => {});
    });
    stream.on('end', () => {
      logger.warn('[GEYSER] Stream ended — reconnecting…');
      connectWithReconnect(Client, attempt + 1).catch(() => {});
    });
    stream.on('close', () => {
      logger.warn('[GEYSER] Stream closed — reconnecting…');
      connectWithReconnect(Client, attempt + 1).catch(() => {});
    });

    stream.on('data', onGeyserData);
    if (attempt > 0) logger.info(`[GEYSER] Reconnected successfully after ${attempt} attempt(s).`);
    else             logger.info('[GEYSER] Connected and subscribed to Geyser stream.');

    return { client, stream };
  } catch (err: any) {
    logger.error(`[GEYSER] Connection failed (attempt ${attempt}): ${err?.message || err}`);
    return connectWithReconnect(Client, attempt + 1);
  }
}

export async function createGeyserClient() {
  logger.info(`Connecting natively to ${config.GEYSER_RPC}…`);

  try {
    const Client = require('@triton-one/yellowstone-grpc').default
                || require('@triton-one/yellowstone-grpc');
    return await connectWithReconnect(Client);

  } catch (error: any) {
    if (error.code === 'MODULE_NOT_FOUND' || (error.message && error.message.includes('native binding'))) {
      logger.warn('[GEYSER] Native bindings not found — injecting MOCK stream.');

      const mockStream = new EventEmitter();
      (mockStream as any).write = () => logger.info('[MOCK] Sent subscription request to Geyser.');

      setInterval(async () => {
        mockStream.emit('data', { account: { account: { owner: Buffer.from('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') }, pubkey: Buffer.from('RAYDIUM_MOCK_POOL') } });
        mockStream.emit('data', { account: { account: { owner: Buffer.from('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc') },  pubkey: Buffer.from('ORCA_MOCK_POOL') } });
      }, 100);

      mockStream.on('data', onGeyserData);
      return { client: null, stream: mockStream };
    }

    logger.error('[GEYSER] Unrecoverable startup error:', error);
    throw error;
  }
}

