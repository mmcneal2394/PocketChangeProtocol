"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createGeyserClient = createGeyserClient;
const config_1 = require("../utils/config");
const logger_1 = require("../utils/logger");
const events_1 = require("events");
async function createGeyserClient() {
    const endpoint = config_1.config.GEYSER_ENDPOINT;
    const token = config_1.config.GEYSER_API_TOKEN;
    logger_1.logger.info(`Connecting to Geyser at: ${endpoint}`);
    try {
        const Client = require('@triton-one/yellowstone-grpc').default || require('@triton-one/yellowstone-grpc');
        const client = new Client(endpoint, token, undefined);
        await client.connect();
        const stream = await client.subscribe();
        stream.write({
            accounts: {
                jupiter: {
                    account: [],
                    owner: ["JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"],
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
            // Emit a fake Jupiter account update every 3 seconds for testing the pipeline
            setInterval(() => {
                logger_1.logger.info("[MOCK] Injecting simulated Jupiter account update from Geyser.");
                mockStream.emit('data', {
                    filters: ['jupiter'],
                    account: {
                        account: {
                            pubkey: Buffer.from("MOCK_PUBKEY_JUPITER")
                        }
                    }
                });
            }, 3000);
            return { client: null, stream: mockStream };
        }
        logger_1.logger.error("Failed to connect to Geyser stream:", error);
        throw error;
    }
}
