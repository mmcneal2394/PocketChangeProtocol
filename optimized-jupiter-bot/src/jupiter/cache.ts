import { Connection, AddressLookupTableAccount, PublicKey } from '@solana/web3.js';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

const connection = new Connection(config.RPC_ENDPOINT, {
  wsEndpoint: config.RPC_WEBSOCKET,
  commitment: 'processed'
});

let recentBlockhash: string | null = null;
let altCache: Map<string, AddressLookupTableAccount> = new Map();

export async function fetchRecentBlockhash() {
  try {
    const { blockhash } = await connection.getLatestBlockhash('processed');
    recentBlockhash = blockhash;
    return blockhash;
  } catch (error) {
    logger.error('Failed to update recent blockhash', error);
  }
}

export function getCachedBlockhash() {
  return recentBlockhash;
}

export async function startBlockhashCache() {
  await fetchRecentBlockhash();
  setInterval(fetchRecentBlockhash, 200); // 200ms updates per PRD
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
