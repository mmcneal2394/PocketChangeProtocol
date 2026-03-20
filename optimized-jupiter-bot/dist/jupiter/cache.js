"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchRecentBlockhash = fetchRecentBlockhash;
exports.getCachedBlockhash = getCachedBlockhash;
exports.startBlockhashCache = startBlockhashCache;
exports.getAddressLookupTable = getAddressLookupTable;
const web3_js_1 = require("@solana/web3.js");
const config_1 = require("../utils/config");
const logger_1 = require("../utils/logger");
const connection = new web3_js_1.Connection(config_1.config.RPC_ENDPOINT, {
    wsEndpoint: config_1.config.RPC_WEBSOCKET,
    commitment: 'processed'
});
let recentBlockhash = null;
let altCache = new Map();
async function fetchRecentBlockhash() {
    try {
        const { blockhash } = await connection.getLatestBlockhash('processed');
        recentBlockhash = blockhash;
        return blockhash;
    }
    catch (error) {
        logger_1.logger.error('Failed to update recent blockhash', error);
    }
}
function getCachedBlockhash() {
    return recentBlockhash;
}
async function startBlockhashCache() {
    await fetchRecentBlockhash();
    setInterval(fetchRecentBlockhash, 200); // 200ms updates per PRD
}
async function getAddressLookupTable(address, forceRefresh = false) {
    if (!forceRefresh && altCache.has(address)) {
        return altCache.get(address);
    }
    try {
        const pubkey = new web3_js_1.PublicKey(address);
        const lookupTable = await connection.getAddressLookupTable(pubkey);
        if (lookupTable.value) {
            altCache.set(address, lookupTable.value);
            return lookupTable.value;
        }
    }
    catch (error) {
        logger_1.logger.error(`Failed to fetch ALT ${address}`, error);
    }
    return null;
}
