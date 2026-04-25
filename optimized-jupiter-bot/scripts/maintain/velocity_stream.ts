import { Connection, PublicKey, Logs } from '@solana/web3.js';
import Redis from 'ioredis';
import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';
import {
  classifyVelocityStreamError,
  resolveVelocityStreamReconnectDelayMs,
} from './velocity_stream_reconnect_logic';
import { buildCompositeVelocityEntries } from './velocity_fallback_logic';
import { hasVelocitySwapSignal } from './velocity_stream_event_logic';
import { normalizeVelocitySnapshot } from './velocity_snapshot_logic';

config();

const HELIUS_WSS = (process.env.RPC_WEBSOCKET || process.env.HELIUS_WSS_URL || 'wss://api.mainnet-beta.solana.com').trim();
const RPC_HTTP = (process.env.RPC_ENDPOINT || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com').trim();
const REDIS_URL = (process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim();

const redis = new Redis(REDIS_URL);
const connection = new Connection(RPC_HTTP, { commitment: 'confirmed', disableRetryOnRateLimit: true as any });
const SIGNALS_DIR = path.join(process.cwd(), 'signals');
const VELOCITY_FILE = path.join(SIGNALS_DIR, 'velocity.json');
const TRENDING_FILE = path.join(SIGNALS_DIR, 'trending.json');
const WALLET_SIGNALS_FILE = path.join(SIGNALS_DIR, 'wallet_signals.json');
const WebSocketImpl: any = require('ws');

// Known AMM program IDs on Solana
const AMM_PROGRAMS = [
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium CPMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Orca
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora DLMM
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',  // Pump.fun — primary volume source, re-enabled after RPC fix
  '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', // Meteora Pools
].map(addr => new PublicKey(addr));

let currentSubId: number | null = null;
let streamMode: 'grpc' | 'ws' | 'idle' = 'idle';
let lastStreamMessageAt = 0;
let wsReconnectAttempts = 0;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let wsClient: any = null;
let wsRequestId = 1;
let wsIntentionalClose = false;
let wsSubscriptionCount = 0;
const WS_BASE_RECONNECT_MS = 2_000;
const WS_RATE_LIMIT_RECONNECT_MS = 15_000;
const WS_IDLE_RECONNECT_MS = 45_000;
const WS_MAX_RECONNECT_MS = 120_000;
const COMPOSITE_FALLBACK_REFRESH_MS = 10_000;
let lastCompositeFallbackAt = 0;

// Cache to avoid refetching the exact same mint or signature constantly.
// Use TTL maps instead of ever-growing Sets so old entries age out naturally.
const SIG_CACHE_TTL_MS = 10 * 60_000;
const MINT_CACHE_TTL_MS = 20 * 60_000;
const SYNTHETIC_MINT_CACHE_TTL_MS = 45_000;
const MAX_SIG_CACHE = 600;
const MAX_MINT_CACHE = 300;
const MAX_QUEUE_LENGTH = 50;
const EVENT_WINDOW_MS = 60_000;
const ACCEL_WINDOW_MS = 20_000;
const sigCache = new Map<string, number>();
const recentMints = new Map<string, number>();
let lastVelocityPersistAt = 0;
type VelocityEvent = {
    ts: number;
    side: 'buy' | 'sell' | 'unknown';
    solVolume: number;
};
const velocityMints = new Map<string, {
    symbol: string;
    buys60s: number;
    sells60s: number;
    buyRatio60s: number;
    velocity: number;
    isAccelerating: boolean;
    solVolume60s: number;
    spikeOnly: boolean;
    lastSeenAt: number;
    isSynthetic?: boolean;
    refinementOnly?: boolean;
    syntheticSource?: string | null;
}>();
const mintEvents = new Map<string, VelocityEvent[]>();

function pruneTimedMap(map: Map<string, number>, ttlMs: number, maxEntries: number) {
    const now = Date.now();
    for (const [key, ts] of map) {
        if (now - ts > ttlMs) map.delete(key);
    }
    while (map.size > maxEntries) {
        const first = map.keys().next().value;
        if (!first) break;
        map.delete(first);
    }
}

function buildVelocityPayload(now = Date.now()) {
    const mints: Record<string, any> = {};
    for (const [mint, data] of velocityMints) {
        mints[mint] = {
            symbol: data.symbol,
            buys60s: data.buys60s,
            sells60s: data.sells60s,
            buyRatio60s: data.buyRatio60s,
            velocity: data.velocity,
            isAccelerating: data.isAccelerating,
            solVolume60s: data.solVolume60s,
            spikeOnly: data.spikeOnly,
            lastSeenAt: data.lastSeenAt,
            isSynthetic: Boolean(data.isSynthetic),
            refinementOnly: Boolean(data.refinementOnly),
            syntheticSource: data.syntheticSource || null,
        };
    }
    return {
        updatedAt: now,
        source: 'pcp-velocity',
        mints,
    };
}

function persistVelocitySnapshot() {
    try {
        const now = Date.now();
        if (now - lastVelocityPersistAt < 5_000) return;
        if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });
        const payload = normalizeVelocitySnapshot(buildVelocityPayload(now));
        fs.writeFileSync(VELOCITY_FILE, JSON.stringify(payload, null, 2), 'utf-8');
        lastVelocityPersistAt = now;
    } catch (err) {
        console.error('[VELOCITY] Failed to write velocity snapshot:', err);
    }
}

function loadJsonSafe(filePath: string): any {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return null;
    }
}

function clearWsReconnectTimer() {
    if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
    }
}

function detachWsClient() {
    if (!wsClient) return;
    try {
        wsIntentionalClose = true;
        if (typeof wsClient.removeAllListeners === 'function') {
            wsClient.removeAllListeners();
        }
        if (typeof wsClient.terminate === 'function') {
            wsClient.terminate();
        }
        if (typeof wsClient.close === 'function') {
            wsClient.close();
        }
    } catch {}
    wsClient = null;
}

function markStreamHealthy(mode: 'grpc' | 'ws') {
    streamMode = mode;
    lastStreamMessageAt = Date.now();
    if (mode === 'ws') {
        wsReconnectAttempts = 0;
    }
}

function refreshCompositeFallback() {
    const now = Date.now();
    if (now - lastCompositeFallbackAt < COMPOSITE_FALLBACK_REFRESH_MS) return;
    const rawTrending = loadJsonSafe(TRENDING_FILE);
    const walletSignalsDocument = loadJsonSafe(WALLET_SIGNALS_FILE);
    const compositeEntries = buildCompositeVelocityEntries({
        rawTrending,
        walletSignalsDocument,
        solPriceUsd: Number(process.env.SOL_PRICE_USD || 150),
        now,
    });
    const count = Object.keys(compositeEntries).length;
    if (count === 0) return;
    velocityMints.clear();
    for (const [mint, data] of Object.entries(compositeEntries)) {
        velocityMints.set(mint, data as any);
    }
    lastCompositeFallbackAt = now;
    console.warn(`[VELOCITY] Using composite fallback feed with ${count} candidate(s) from trending + wallet intel.`);
    persistVelocitySnapshot();
}

function scheduleWsReconnect(reason: any) {
    const classified = classifyVelocityStreamError(reason);
    if (wsReconnectTimer) return;
    detachWsClient();
    streamMode = 'idle';
    const delayMs = resolveVelocityStreamReconnectDelayMs({
        attempt: wsReconnectAttempts,
        rateLimited: classified.rateLimited,
        idleTimeout: classified.idleTimeout,
        baseMs: WS_BASE_RECONNECT_MS,
        rateLimitedBaseMs: WS_RATE_LIMIT_RECONNECT_MS,
        idleBaseMs: 5_000,
        maxMs: WS_MAX_RECONNECT_MS,
    });
    wsReconnectAttempts += 1;
    const jitteredDelayMs = Math.round(delayMs * (0.85 + (Math.random() * 0.3)));
    const reasonLabel = classified.message || 'unknown error';
    console.warn(`[VELOCITY] WS reconnect scheduled in ${Math.ceil(jitteredDelayMs / 1000)}s (${reasonLabel})`);
    wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        subscribe().catch((err) => {
            console.error('[VELOCITY] subscribe retry failed:', err);
            scheduleWsReconnect(err);
        });
    }, jitteredDelayMs);
}

function pruneVelocitySnapshot() {
    const now = Date.now();
    for (const [mint, data] of velocityMints) {
        const ttlMs = data.isSynthetic ? SYNTHETIC_MINT_CACHE_TTL_MS : MINT_CACHE_TTL_MS;
        if (now - data.lastSeenAt > ttlMs) velocityMints.delete(mint);
    }
    for (const [mint, events] of mintEvents) {
        const fresh = events.filter((event) => now - event.ts <= EVENT_WINDOW_MS);
        if (fresh.length === 0) mintEvents.delete(mint);
        else mintEvents.set(mint, fresh);
    }
}

function inferSideFromLogs(logs: string[]): 'buy' | 'sell' | 'unknown' {
    const joined = logs.join(' ').toLowerCase();
    if (joined.includes('instruction: buy') || joined.includes(' buy ')) return 'buy';
    if (joined.includes('instruction: sell') || joined.includes(' sell ')) return 'sell';
    return 'unknown';
}

function inferSignerLamportDelta(tx: any): number {
    try {
        const accountKeys = tx?.transaction?.message?.accountKeys || [];
        const signerIndex = accountKeys.findIndex((k: any) => {
            if (typeof k === 'string') return false;
            return !!k?.signer;
        });
        if (signerIndex < 0) return 0;
        const pre = Number(tx?.meta?.preBalances?.[signerIndex] || 0);
        const post = Number(tx?.meta?.postBalances?.[signerIndex] || 0);
        return (pre - post) / 1e9;
    } catch {
        return 0;
    }
}

function updateMintVelocity(mint: string, side: 'buy' | 'sell' | 'unknown', solVolume: number, symbol?: string) {
    const now = Date.now();
    const events = mintEvents.get(mint) || [];
    events.push({ ts: now, side, solVolume: Math.max(0, solVolume) });
    const fresh = events.filter((event) => now - event.ts <= EVENT_WINDOW_MS);
    mintEvents.set(mint, fresh);

    const buys60s = fresh.filter((event) => event.side === 'buy').length;
    const sells60s = fresh.filter((event) => event.side === 'sell').length;
    const totalTx = fresh.length;
    const solVolume60s = fresh.reduce((sum, event) => sum + event.solVolume, 0);
    const recent = fresh.filter((event) => now - event.ts <= ACCEL_WINDOW_MS).length;
    const prior = fresh.filter((event) => {
        const age = now - event.ts;
        return age > ACCEL_WINDOW_MS && age <= ACCEL_WINDOW_MS * 2;
    }).length;
    const buyRatio60s = totalTx > 0 ? buys60s / totalTx : 0;
    const velocity = totalTx;
    const existing = velocityMints.get(mint);
    velocityMints.set(mint, {
        symbol: symbol || existing?.symbol || `${mint.slice(0, 8)}...`,
        buys60s,
        sells60s,
        buyRatio60s,
        velocity,
        isAccelerating: recent > prior && recent >= 2,
        solVolume60s: Number(solVolume60s.toFixed(6)),
        spikeOnly: false,
        lastSeenAt: now,
        isSynthetic: false,
        refinementOnly: false,
        syntheticSource: null,
    });
}

async function fetchTxEvent(signature: string, logs: string[]): Promise<{ mint: string; side: 'buy' | 'sell' | 'unknown'; solVolume: number; symbol?: string } | null> {
    try {
        const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
        if (!tx) return null;

        const SKIP = new Set([
          'So11111111111111111111111111111111111111112', '11111111111111111111111111111111',
          'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv',
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
        ]);

        if (tx.meta && tx.meta.postTokenBalances) {
            for (const bal of tx.meta.postTokenBalances) {
                const mint = bal.mint;
                if (!SKIP.has(mint)) {
                    const side = inferSideFromLogs(logs);
                    const solDelta = Math.abs(inferSignerLamportDelta(tx));
                    const symbol = `${mint.slice(0, 8)}...`;
                    return { mint, side, solVolume: solDelta, symbol };
                }
            }
        }
    } catch (e) {
        // RPC might fail or rate limit
    }
    return null;
}

function handleWsMessage(rawMessage: any) {
    try {
        const payload = typeof rawMessage === 'string'
            ? rawMessage
            : Buffer.isBuffer(rawMessage)
                ? rawMessage.toString('utf-8')
                : String(rawMessage ?? '');
        if (!payload) return;
        const parsed = JSON.parse(payload);
        if (parsed?.method === 'logsNotification') {
            const value = parsed?.params?.result?.value;
            const context = parsed?.params?.result?.context || parsed?.params?.context || {};
            markStreamHealthy('ws');
            if (value?.signature) {
                handleLogs({
                    err: value?.err || null,
                    signature: value.signature,
                    logs: value.logs || [],
                } as any, context);
            }
            return;
        }
        if (parsed?.result && parsed?.id) {
            wsSubscriptionCount += 1;
            currentSubId = wsSubscriptionCount;
        }
    } catch (err) {
        console.error('[VELOCITY] Failed to parse WS payload:', err);
    }
}

async function subscribeViaWebSocket() {
    clearWsReconnectTimer();
    detachWsClient();
    wsSubscriptionCount = 0;
    wsIntentionalClose = false;
    streamMode = 'ws';
    const ws = new WebSocketImpl(HELIUS_WSS);
    wsClient = ws;

    ws.on('open', () => {
        console.log('[VELOCITY] WS connected; subscribing to AMM logs');
        markStreamHealthy('ws');
        for (const amm of AMM_PROGRAMS) {
            ws.send(JSON.stringify({
                jsonrpc: '2.0',
                id: wsRequestId++,
                method: 'logsSubscribe',
                params: [
                    { mentions: [amm.toBase58()] },
                    { commitment: 'processed' },
                ],
            }));
        }
    });

    ws.on('message', (data: any) => {
        handleWsMessage(data);
    });

    ws.on('error', (error: any) => {
        const classified = classifyVelocityStreamError(error);
        console.error(`[VELOCITY] ws error: ${classified.message || error}`);
        scheduleWsReconnect(classified.message || error);
    });

    ws.on('close', (code: number, reason: Buffer) => {
        const reasonText = Buffer.isBuffer(reason) ? reason.toString('utf-8') : String(reason || '');
        const reasonLabel = `ws close code=${code ?? 'unknown'} reason=${reasonText}`.trim();
        if (wsIntentionalClose) return;
        console.warn(`[VELOCITY] ${reasonLabel}`);
        scheduleWsReconnect(reasonLabel);
    });
}

const txMintQueue: { signature: string; context: any; logs: string[] }[] = [];

async function processQueue() {
    pruneTimedMap(sigCache, SIG_CACHE_TTL_MS, MAX_SIG_CACHE);
    pruneTimedMap(recentMints, MINT_CACHE_TTL_MS, MAX_MINT_CACHE);
    pruneVelocitySnapshot();
    if (velocityMints.size === 0 && (streamMode === 'idle' || (Date.now() - lastStreamMessageAt) > 15_000)) {
        refreshCompositeFallback();
    }
    persistVelocitySnapshot();
    if (txMintQueue.length > 0) {
        const item = txMintQueue.shift();
        if (item) {
            try {
                const event = await fetchTxEvent(item.signature, item.logs);
                if (event) {
                    updateMintVelocity(event.mint, event.side, event.solVolume, event.symbol);
                    if (!recentMints.has(event.mint)) {
                        recentMints.set(event.mint, Date.now());
                        console.log(`[VELOCITY] SPIKE MINT ISOLATED: ${event.mint}`);
                        redis.publish('velocity:spike', JSON.stringify({ mints: [event.mint], slot: item.context.slot }));
                    }
                    persistVelocitySnapshot();
                }
            } catch (e: any) { console.error(`[SWARM FAIL-CLOSED] Caught empty bypass vector -> Dropping logic chain.`); return null; }
        }
    }
    setTimeout(processQueue, 250); // 4 TPS — Helius paid plan can handle this
}
processQueue();

function handleLogs(logs: Logs, context: any) {
  try {
    if (logs.err) return;
    if (sigCache.has(logs.signature)) return;

    const isSwapEvent = hasVelocitySwapSignal(logs.logs || []);
    if (!isSwapEvent) return;

    sigCache.set(logs.signature, Date.now());

    // Limit unbounded queue growth
    if (txMintQueue.length < MAX_QUEUE_LENGTH) {
        txMintQueue.push({ signature: logs.signature, context, logs: logs.logs || [] });
    }
  } catch (err) {
    console.error('[VELOCITY] Error processing logs:', err);
  }
}

const geyserUrl = process.env.GEYSER_RPC ? (process.env.GEYSER_RPC.includes('://') ? process.env.GEYSER_RPC : `https://${process.env.GEYSER_RPC}`) : undefined;
const geyserToken = process.env.GEYSER_API_TOKEN || undefined;

let grpcStream: any = null;

async function subscribe() {
  clearWsReconnectTimer();
  detachWsClient();

  if (geyserToken && geyserUrl) {
    try {
      const Client = require('@triton-one/yellowstone-grpc').default;
      const { CommitmentLevel } = require('@triton-one/yellowstone-grpc');
      const client = new Client(geyserUrl, geyserToken, undefined);
      await client.connect();
      grpcStream = await client.subscribe();

      grpcStream.on('data', (data: any) => {
          markStreamHealthy('grpc');
          if (data.transaction && data.transaction.transaction) {
               const tx = data.transaction.transaction;
               let logs = [];
               if (tx.meta && tx.meta.logMessages) {
                   logs = tx.meta.logMessages;
               }

               const signatureObj = tx.signature;
               let sigStr = '';
               try {
                  const bs58 = require('bs58');
                  sigStr = bs58.encode(signatureObj);
               } catch (e: any) { console.error(`[SWARM FAIL-CLOSED] Caught empty bypass vector -> Dropping logic chain.`); return null; }

               if (sigStr) {
                   handleLogs({ err: tx.meta?.err || null, signature: sigStr, logs: logs } as any, { slot: data.transaction.slot });
               }
          }
      });
      grpcStream.on('error', (error: any) => {
          console.error('[VELOCITY] gRPC stream error; falling back to WS', error);
          scheduleWsReconnect(error);
      });
      grpcStream.on('close', () => {
          console.warn('[VELOCITY] gRPC stream closed; falling back to WS');
          scheduleWsReconnect('grpc close');
      });
      grpcStream.on('end', () => {
          console.warn('[VELOCITY] gRPC stream ended; falling back to WS');
          scheduleWsReconnect('grpc end');
      });

      const request = {
          accounts: {},
          slots: {},
          transactions: {
              amm: {
                  vote: false,
                  failed: false,
                  signature: undefined,
                  accountInclude: AMM_PROGRAMS.map(pk => pk.toBase58()),
                  accountExclude: [],
                  accountRequired: []
              }
          },
          transactionsStatus: {},
          blocks: {},
          blocksMeta: {},
          entry: {},
          commitment: 1, // PROCESSED = 1
          accountsDataSlice: []
      };

      await new Promise<void>((resolve, reject) => {
          grpcStream.write(request, (err: any) => {
              if (err) reject(err); else resolve();
          });
      });

      console.log('[VELOCITY] 🚀 Subscribed to Yellowstone gRPC at PROCESSED commitment');
      return;
    } catch (e) {
      console.error('[VELOCITY] ⚠️ gRPC failed, falling back to WS', e);
    }
  }

  await subscribeViaWebSocket();
}

subscribe();

// Heartbeat every 10 seconds
setInterval(() => {
  if (streamMode === 'ws' && lastStreamMessageAt > 0 && (Date.now() - lastStreamMessageAt) > WS_IDLE_RECONNECT_MS) {
    scheduleWsReconnect('stream idle timeout');
  }
  redis.publish('HEARTBEAT', JSON.stringify({
    agent: 'velocity-stream',
    status: 'alive',
    lastMintMs: Date.now(),
    subId: currentSubId,
    streamMode,
    lastStreamMessageAt,
  }));
}, 10000);
