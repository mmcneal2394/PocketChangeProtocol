/**
 * velocity_stream.ts — Real-time swap velocity detector via Chainstack WebSocket
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses standard Solana WebSocket `logsSubscribe` on Chainstack RPC to detect
 * Raydium V4 + Pump.fun swaps in real-time with sub-second latency.
 *
 * No Geyser tier required — works on standard Chainstack plans.
 * Writes signals/velocity.json every 2s for the sniper to consume.
 */

import WebSocket from 'ws';
import fs   from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: path.join(process.cwd(), '.env') });
import RedisBus from '../../src/utils/redis_bus';
import { CHANNELS } from '../../src/shared/redis_config';

// ── Config ────────────────────────────────────────────────────────────────────
const RPC_HTTP   = process.env.RPC_ENDPOINT!;   // Helius via .env
const WS_URL     = 'wss://api.mainnet-beta.solana.com/'; // Free public WSS to preserve Helius socket limits
const SIGNALS_DIR= path.join(process.cwd(), 'signals');
const WINDOW_MS  = 60_000;   // 60s rolling window
const WRITE_MS   = 2_000;    // Broadcast over Redis every 2s
const MIN_SWAPS  = 3;        // min events before tracking
const STALE_MS   = 120_000;  // purge mints with no activity for 2min

// ── Program IDs to watch ──────────────────────────────────────────────────────
const WATCHED_PROGRAMS = [
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',   // Raydium AMM V4
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',    // Pump.fun
  'BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW',   // Pump.fun bonding curve
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',   // Raydium CLMM
];

// ── In-memory swap event window ───────────────────────────────────────────────
interface SwapEvent { ts: number; isBuy: boolean; solAmt: number; }
const mintEvents    = new Map<string, SwapEvent[]>();
const mintFirstSeen = new Map<string, number>();
const prevVelocity  = new Map<string, number>();

let totalEventsReceived = 0;
let totalSwapsParsed    = 0;

function recordSwap(mint: string, isBuy: boolean, solAmt = 0) {
  if (!mintEvents.has(mint)) {
    mintEvents.set(mint, []);
    mintFirstSeen.set(mint, Date.now());
  }
  mintEvents.get(mint)!.push({ ts: Date.now(), isBuy, solAmt });
  totalSwapsParsed++;
}

// ── Signature fetch queue for mint resolution ─────────────────────────────────
// logsSubscribe gives us signature + logs but NOT account keys.
// We fetch tx details for swap signatures to extract the token mint.
// Rate-limited to 5 concurrent fetches to avoid Chainstack throttling.
const fetchQueue: Array<{sig: string, isBuy: boolean}> = []; // signatures pending fetch
const processedSig = new Set<string>(); // avoid double-processing
const MAX_CONCURRENT_FETCHES = 5; // Dropped to 5 to protect Helius HTTP rate limits!
let activeFetches = 0;

async function fetchAndParseMint(signature: string, isBuy: boolean) {
  if (processedSig.has(signature)) return;
  if (activeFetches >= MAX_CONCURRENT_FETCHES) { 
      if (fetchQueue.length < 1000) fetchQueue.push({sig: signature, isBuy}); 
      return; 
  }

  processedSig.add(signature);
  activeFetches++;

  try {
    const res = await fetch(RPC_HTTP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTransaction',
        params: [signature, { encoding: 'json', maxSupportedTransactionVersion: 0 }]
      }),
      signal: AbortSignal.timeout(5000),
    });
    const data: any = await res.json();
    const tx = data?.result;
    if (!tx) return;

    const staticKeys: string[] = tx?.transaction?.message?.accountKeys || [];
    const writableKeys: string[] = tx?.meta?.loadedAddresses?.writable || [];
    const allKeys = [...staticKeys, ...writableKeys];

    const SKIP = new Set([
      'So11111111111111111111111111111111111111112',   // WSOL
      'So11111111111111111111111111111111111111111',   // native SOL (some pools use this variant)
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  // USDT
      'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
      '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',  // ETH (Wormhole)
      '11111111111111111111111111111111',                // System program
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',   // Token program
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv',   // ATA program
    ]);

    // Find the most likely token mint — an account key that's not SOL/USDC/system
    // For Pump.fun: mint is usually at index 2 or 3 in accountKeys
    // For Raydium: coin_mint is at index 8
    let mint: string | null = null;
    for (let i = 0; i < allKeys.length; i++) {
      const k = allKeys[i];
      if (k && k.length >= 32 && !SKIP.has(k) && !k.startsWith('1111')) {
        mint = k;
        break;
      }
    }

    if (mint) {
      recordSwap(mint, isBuy, 0);
    }
  } catch { /* non-fatal */ } finally {
    activeFetches--;
    // Drain queue
    const nextItem = fetchQueue.shift();
    if (nextItem) fetchAndParseMint(nextItem.sig, nextItem.isBuy);
  }
}

// ── Parse log subscription message ───────────────────────────────────────────
function parsePumpLog(logs: string[], signature: string): void {
  if (!logs || !signature) return;

  // Determine direction from logs
  const isBuy  = logs.some(l => l.includes('Instruction: Buy'));
  const isSell = logs.some(l => l.includes('Instruction: Sell'));
  if (!isBuy && !isSell) return;

  // Always fetch from RPC since Pump.fun no longer guarantees mint in logs
  fetchAndParseMint(signature, isBuy).catch(() => {});
}

function parseRaydiumLog(logs: string[], signature: string): void {
  if (!logs || !signature) return;
  const isBuy = logs.some(l => l.includes('SwapBaseIn') || l.includes('swap_base_in'));
  const isSell = logs.some(l => l.includes('SwapBaseOut') || l.includes('swap_base_out'));
  if (!isBuy && !isSell) return;
  // Always fetch for Raydium since logs don't include mint
  fetchAndParseMint(signature, isBuy).catch(() => {});
}


// ── Compute velocity snapshot for writing ─────────────────────────────────────
function computeAndWrite() {
  const now   = Date.now();
  const since = now - WINDOW_MS;
  const out: Record<string, any> = {};

  for (const [mint, events] of mintEvents) {
    const recent = events.filter(e => e.ts >= since);
    mintEvents.set(mint, recent);

    if (recent.length < MIN_SWAPS) continue;

    const lastSeen = Math.max(...recent.map(e => e.ts));
    if (now - lastSeen > STALE_MS) { mintEvents.delete(mint); mintFirstSeen.delete(mint); continue; }

    const buys  = recent.filter(e => e.isBuy);
    const total = recent.length;
    const vol   = recent.reduce((s, e) => s + e.solAmt, 0);
    const winMs = Math.min(WINDOW_MS, now - (mintFirstSeen.get(mint) || now));
    const vel   = winMs > 0 ? (total / (winMs / 1000)) * 60 : 0;
    const prev  = prevVelocity.get(mint) || 0;
    prevVelocity.set(mint, vel);

    out[mint] = {
      buys60s:        buys.length,
      sells60s:       total - buys.length,
      buyRatio60s:    total > 0 ? parseFloat((buys.length / total).toFixed(3)) : 0,
      solVolume60s:   parseFloat(vol.toFixed(4)),
      velocity:       parseFloat(vel.toFixed(1)),
      firstSeen:      mintFirstSeen.get(mint)!,
      lastSeen,
      isAccelerating: vel > prev * 1.2,
      ageSec:         Math.floor((now - (mintFirstSeen.get(mint) || now)) / 1000),
    };
  }

  const hotCount = Object.keys(out).length;
  if (hotCount > 0) {
      const pub = RedisBus.getPublisher();
      pub.sadd('active:mints', ...Object.keys(out)).catch(() => {});
  }
  if (hotCount > 0 || totalEventsReceived % 100 === 0) {
    process.stdout.write(`\r[VELOCITY] Events:${totalEventsReceived} Swaps:${totalSwapsParsed} Hot:${hotCount} | ${new Date().toISOString().slice(11,19)}  `);
  }

  // Publish to Redis instead of disk
  RedisBus.publish(CHANNELS.VELOCITY_SPIKE, { updatedAt: now, mintCount: hotCount, mints: out });
}

// ── WebSocket subscription manager ───────────────────────────────────────────
let ws: WebSocket | null = null;
let pingInterval: NodeJS.Timeout | null = null;
let writeInterval: NodeJS.Timeout | null = null;
let subIds: number[] = [];

function subscribe(wsConn: WebSocket) {
  let id = 1;
  for (const prog of WATCHED_PROGRAMS) {
    const req = {
      jsonrpc: '2.0',
      id: id++,
      method: 'logsSubscribe',
      params: [{ mentions: [prog] }, { commitment: 'processed' }]
    };
    wsConn.send(JSON.stringify(req));
  }
  console.log(`\n[VELOCITY] ✅ Subscribed to ${WATCHED_PROGRAMS.length} programs via logsSubscribe`);
}

function handleMessage(raw: string) {
  try {
    const msg = JSON.parse(raw);

    // Subscription confirmation
    if (msg.result && typeof msg.result === 'number') {
      subIds.push(msg.result);
      return;
    }

    // Normal logsSubscribe notification
    const value = msg?.params?.result?.value;
    if (!value) return;

    totalEventsReceived++;
    const { logs, err, signature } = value;

    if (err) return; // skip failed txns
    if (!signature) return;

    // Determine which program was invoked
    const isRaydium = logs?.some((l: string) =>
      l.includes('675kPX9') || l.includes('Raydium') || l.includes('ray_log')
    );
    const isPump = logs?.some((l: string) =>
      l.includes('pump') || l.includes('Pump') || l.includes('BSfD6') || l.includes('6EF8')
    );

    if (isPump)       parsePumpLog(logs, signature);
    else if (isRaydium) parseRaydiumLog(logs, signature);

  } catch { /* non-fatal parse error */ }
}


function connect() {
  console.log(`[VELOCITY] Connecting to ${WS_URL.replace(RPC_HTTP.split('/').slice(-1)[0], '***')}`);
  ws = new WebSocket(WS_URL);

  ws.on('open', () => {
    console.log('[VELOCITY] WS connected');
    subscribe(ws!);
    // Keep-alive ping every 30s
    if (pingInterval) clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ jsonrpc:'2.0', id:99, method:'getHealth' }));
    }, 30_000);
  });

  ws.on('message', (data: Buffer) => handleMessage(data.toString()));

  ws.on('close', (code, reason) => {
    console.log(`\n[VELOCITY] WS closed: ${code} ${reason} — reconnecting in 5s`);
    if (pingInterval) clearInterval(pingInterval);
    setTimeout(connect, 5_000);
  });

  ws.on('error', (e: any) => console.error('[VELOCITY] WS error:', e.message));
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log('╔══════════════════════════════════════════════════╗');
console.log('║  PCP VELOCITY STREAM — WebSocket logsSubscribe  ║');
console.log('║  Real-time swap detection → Redis (stream:velocity)║');
console.log('╚══════════════════════════════════════════════════╝');

connect();
writeInterval = setInterval(computeAndWrite, WRITE_MS);

// Supervisor Heartbeat Array
setInterval(() => {
  RedisBus.publish('heartbeat:agent', { agent: 'pcp-velocity', timestamp: Date.now() });
}, 30000);

process.on('SIGINT', () => {
  if (ws) ws.close();
  if (pingInterval) clearInterval(pingInterval);
  if (writeInterval) clearInterval(writeInterval);
  process.exit(0);
});
