import { Connection, AddressLookupTableAccount, PublicKey } from '@solana/web3.js';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

let cachedBlockhash: string | null = null;
const connection = new Connection(config.RPC_ENDPOINT, { commitment: 'processed', confirmTransactionInitialTimeout: 5000 });

// ── ALT cache with 6h TTL eviction ──────────────────────────────────────────
// Prevents unbounded Map growth during long production sessions where many
// unique ALT addresses are encountered across thousands of route executions.
const ALT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
interface AltEntry { table: AddressLookupTableAccount; fetchedAt: number; }
let altCache: Map<string, AltEntry> = new Map();

// Evict stale ALT entries every 30 minutes
setInterval(() => {
  const cutoff = Date.now() - ALT_TTL_MS;
  for (const [addr, entry] of altCache) {
    if (entry.fetchedAt < cutoff) altCache.delete(addr);
  }
}, 30 * 60 * 1000);

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
  const cached = altCache.get(address);
  // Return cached entry if still within TTL and not force-refreshed
  if (!forceRefresh && cached && (Date.now() - cached.fetchedAt) < ALT_TTL_MS) {
    return cached.table;
  }

  try {
    const pubkey = new PublicKey(address);
    const lookupTable = await connection.getAddressLookupTable(pubkey);
    if (lookupTable.value) {
      altCache.set(address, { table: lookupTable.value, fetchedAt: Date.now() });
      return lookupTable.value;
    }
  } catch (error) {
    logger.error(`Failed to fetch ALT ${address}`, error);
  }

  return null;
}
