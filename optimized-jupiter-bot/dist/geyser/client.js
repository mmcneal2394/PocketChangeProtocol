"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGeyserClient = createGeyserClient;
const config_1 = require("../utils/config");
const logger_1 = require("../utils/logger");
const events_1 = require("events");
const price_book_1 = require("../local_calc/price_book");
const arb_engine_1 = require("../local_calc/arb_engine");
async function createGeyserClient() {
    logger_1.logger.info(`Connecting natively to ${config_1.config.GEYSER_RPC}...`);
    try {
        const Client = require('@triton-one/yellowstone-grpc').default || require('@triton-one/yellowstone-grpc');
        const client = new Client(config_1.config.GEYSER_RPC, config_1.config.GEYSER_API_TOKEN, undefined);
        await client.connect();
        const stream = await client.subscribe();
        stream.write({
            accounts: {
                raydium_pools: {
                    account: ["58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUvbMT12EzEQBd"],
                    owner: [],
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
        stream.on('data', async (data) => {
            if (data?.account) {
                price_book_1.globalPriceBook.updatePool(data.account);
                await arb_engine_1.globalArbEngine.runArbitrageScan();
            }
        });
        logger_1.logger.info("Successfully connected and subscribed to Geyser stream.");
        return { client, stream };
    }
    catch (error) {
        if (error.code === 'MODULE_NOT_FOUND' || (error.message && error.message.includes('native binding'))) {
            logger_1.logger.warn("Native Yellowstone gRPC bindings skipped. Injecting MOCK Geyser Stream to verify local structure.");
            const mockStream = new events_1.EventEmitter();
            mockStream.write = (req) => {
                logger_1.logger.info("[MOCK] Sent subscription request to Geyser.");
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
            mockStream.on('data', async (data) => {
                if (data?.account) {
                    price_book_1.globalPriceBook.updatePool(data.account);
                    await arb_engine_1.globalArbEngine.runArbitrageScan();
                }
            });
            return { client: null, stream: mockStream };
        }
        logger_1.logger.error("Failed to connect to Geyser stream:", error);
        throw error;
    }
}
