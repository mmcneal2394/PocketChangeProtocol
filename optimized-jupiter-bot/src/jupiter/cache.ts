import { Connection, AddressLookupTableAccount, PublicKey } from '@solana/web3.js';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

let cachedBlockhash: string | null = null;
const connection = new Connection(config.RPC_ENDPOINT, { commitment: 'processed', confirmTransactionInitialTimeout: 5000 });

let altCache: Map<string, AddressLookupTableAccount> = new Map();

async function fetchRecentBlockhash() {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2500);
        // Standard HTTP Fetch wrapper for blockhash to force timeout bypass if Web3 hangs on TCP drop!
        const response = await fetch(config.RPC_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [{"commitment":"confirmed"}] }),
            signal: controller.signal
        });
        clearTimeout(timeout);
        const data = await response.json();
        if (data?.result?.value?.blockhash) {
            cachedBlockhash = data.result.value.blockhash;
        } else {
            logger.warn("RPC Failed Blockhash Fetch: " + JSON.stringify(data));
        }
    } catch (e: any) {
        logger.error(`Failed to update recent blockhash: ${e.message}`);
    }
}
setInterval(fetchRecentBlockhash, 2000);
fetchRecentBlockhash();

export function getCachedBlockhash() {
    if (!cachedBlockhash) {
        throw new Error("No cached blockhash available");
    }
    return cachedBlockhash;
}

export async function getAddressLookupTable(address: string, forceRefresh = false) {
  if (!forceRefresh && altCache.has(address)) {
    return altCache.get(address);
  }

  try {
    const pubkey = new PublicKey(address);
    const lookupTable = await connection.getAddressLookupTable(pubkey);
    if (lookupTable.value) {
      altCache.set(address, lookupTable.value);
      return lookupTable.value;
    }
  } catch (error) {
    logger.error(`Failed to fetch ALT ${address}`, error);
  }

  return null;
}
