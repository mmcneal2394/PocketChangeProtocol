"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCachedBlockhash = getCachedBlockhash;
exports.getAddressLookupTable = getAddressLookupTable;
const web3_js_1 = require("@solana/web3.js");
const config_1 = require("../utils/config");
const logger_1 = require("../utils/logger");
let cachedBlockhash = null;
const connection = new web3_js_1.Connection(config_1.config.RPC_ENDPOINT, { commitment: 'processed', confirmTransactionInitialTimeout: 5000 });
let altCache = new Map();
async function fetchRecentBlockhash() {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2500);
        // Standard HTTP Fetch wrapper for blockhash to force timeout bypass if Web3 hangs on TCP drop!
        const response = await fetch(config_1.config.RPC_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{ "commitment": "confirmed" }] }),
            signal: controller.signal
        });
        clearTimeout(timeout);
        const data = await response.json();
        if (data?.result?.value?.blockhash) {
            cachedBlockhash = data.result.value.blockhash;
        }
        else {
            logger_1.logger.warn("RPC Failed Blockhash Fetch: " + JSON.stringify(data));
        }
    }
    catch (e) {
        logger_1.logger.error(`Failed to update recent blockhash: ${e.message}`);
    }
}
setInterval(fetchRecentBlockhash, 2000);
fetchRecentBlockhash();
function getCachedBlockhash() {
    if (!cachedBlockhash) {
        throw new Error("No cached blockhash available");
    }
    return cachedBlockhash;
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
