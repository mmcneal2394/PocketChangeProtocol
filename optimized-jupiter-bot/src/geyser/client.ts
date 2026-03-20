import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';
import { globalPriceBook } from '../local_calc/price_book';
import { globalArbEngine } from '../local_calc/arb_engine';

export async function createGeyserClient() {
  const endpoint = config.GEYSER_ENDPOINT;
  const token = config.GEYSER_API_TOKEN;

  logger.info(`Connecting to Geyser at: ${endpoint}`);
  
  try {
    const Client = require('@triton-one/yellowstone-grpc').default || require('@triton-one/yellowstone-grpc');
    const client = new Client(endpoint, token, undefined);
    await client.connect();
    
    const stream = await client.subscribe();
    
    stream.write({
      accounts: {
        raydium_pools: {
          account: [],
          owner: ["675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"],
          filters: [],
        },
        orca_pools: {
          account: [],
          owner: ["whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"],
          filters: [],
        },
        meteora_pools: {
          account: [],
          owner: ["Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB"],
          filters: [],
        }
      },
      slots: {},
      transactions: {},
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      ping: undefined,
      commitment: 1, // Processed
    });

    stream.on('data', async (data: any) => {
        if (data?.account) {
            globalPriceBook.updatePool(data.account);
            await globalArbEngine.runArbitrageScan();
        }
    });

    logger.info("Successfully connected and subscribed to Geyser stream.");

    return { client, stream };
  } catch (error: any) {
    if (error.code === 'MODULE_NOT_FOUND' || (error.message && error.message.includes('native binding'))) {
        logger.warn("Native Yellowstone gRPC bindings skipped. Injecting MOCK Geyser Stream to verify local structure.");
        
        const mockStream = new EventEmitter();
        (mockStream as any).write = (req: any) => {
            logger.info("[MOCK] Sent subscription request to Geyser.");
        };

        // Emit a fake pool account update every 100ms for testing the pipeline locally
        setInterval(async () => {
            // logger.info("[MOCK] Injecting simulated DEX pool update from Geyser.");
            mockStream.emit('data', {
                account: {
                    account: {
                        owner: Buffer.from("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8")
                    },
                    pubkey: Buffer.from("RAYDIUM_MOCK_POOL")
                }
            });
            mockStream.emit('data', {
                account: {
                    account: {
                        owner: Buffer.from("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc")
                    },
                    pubkey: Buffer.from("ORCA_MOCK_POOL")
                }
            });
        }, 100);

        mockStream.on('data', async (data: any) => {
            if (data?.account) {
                globalPriceBook.updatePool(data.account);
                await globalArbEngine.runArbitrageScan();
            }
        });

        return { client: null, stream: mockStream };
    }
    
    logger.error("Failed to connect to Geyser stream:", error);
    throw error;
  }
}
