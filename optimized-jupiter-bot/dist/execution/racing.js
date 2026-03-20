"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitTransactionWithRacing = submitTransactionWithRacing;
const web3_js_1 = require("@solana/web3.js");
const config_1 = require("../utils/config");
const logger_1 = require("../utils/logger");
const connection = new web3_js_1.Connection(config_1.config.RPC_ENDPOINT, {
    wsEndpoint: config_1.config.RPC_WEBSOCKET,
    commitment: 'processed'
});
async function submitTransactionWithRacing(transaction) {
    logger_1.logger.info('Executing MEV Bundle securely via High-Speed Chainstack Node for ultimate throughput...');
    const submitToRPC = async () => {
        try {
            const startMs = Date.now();
            const rawTx = transaction.serialize();
            const signature = await connection.sendRawTransaction(rawTx, {
                skipPreflight: false,
                maxRetries: 3
            });
            logger_1.logger.info(`🔄 [RPC] Transaction dispatched in ${Date.now() - startMs}ms. Awaiting Blockchain confirmation for ${signature}...`);
            const latestBlockhash = await connection.getLatestBlockhash('processed');
            const confirmation = await connection.confirmTransaction({
                signature,
                blockhash: latestBlockhash.blockhash,
                lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
            }, 'confirmed');
            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${confirmation.value.err.toString()}`);
            }
            return { success: true, provider: 'rpc', signature: signature, latency: Date.now() - startMs };
        }
        catch (e) {
            return { success: false, provider: 'rpc', error: e.message };
        }
    };
    const results = await Promise.allSettled([
        submitToRPC()
    ]);
    results.forEach(res => {
        if (res.status === 'fulfilled') {
            if (res.value.success) {
                logger_1.logger.info(`✅ Executed successfully! Signature: https://solscan.io/tx/${res.value.signature}`);
            }
            else {
                logger_1.logger.warn(`Failed to submit via RPC Mempool: ${res.value.error}`);
            }
        }
        else {
            logger_1.logger.error('Provider submission rejected:', res.reason);
        }
    });
    return results;
}
