/**
 * velocity_tracker.ts — Importable velocity detector (no file I/O for IPC)
 * ─────────────────────────────────────────────────────────────────────────────
 * Refactored from velocity_stream.ts to run in-process with the sniper.
 * Fires callbacks immediately when a mint starts accelerating — no polling lag.
 */

import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';

const WINDOW_MS  = 60_000;
const MIN_SWAPS  = 3;
const STALE_MS   = 120_000;

const WATCHED_PROGRAMS = [
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',   // Raydium AMM V4
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',    // Pump.fun
  'BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW',   // Pump.fun bonding curve
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',   // Raydium CLMM
];

const SKIP_ADDRS = new Set([
  'So11111111111111111111111111111111111111112',
  'So11111111111111111111111111111111111111111',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe8bv',
  'ComputeBudget111111111111111111111111111111',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'BSfD6SHZigAfDWSjzD5Q41jw8LmKwtmjskPH9XW1mrRW',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  'SysvarRent111111111111111111111111111111111',
  'SysvarC1ock11111111111111111111111111111111',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbPwdrsxGBK',
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
  // PumpSwap / AMM / Token programs that leak into mint detection
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',  // PumpSwap AMM v2
  'PSwapMdSai8tjrEXcxFeQth87xC4rRsa4VA5mhGhXkP',  // PumpSwap AMM v1
  'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',  // PumpFees
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',  // Token-2022
  'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95',   // Known false positive
  'AveaiuA1LHzaRmdFfFRzuak7vE3h5bcJy81oHgSm5T73',  // Known false positive
  'B3111yJCBTCGHDSShkVDNjTFcLCE97eaMVGGAF4GDPyV',  // Known false positive
  'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ5GEFDM97zC',  // Pump fee recipient
  '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg',  // Migration authority
  '2sMrGNK8i36YRkF5WWCwnaUYuwDJhHe1g2xA8aPvhkjM',  // Social claim authority
  'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjQ7d7TDEkHw',  // Pump global config
  'noopb9bkMVfRPU8Dw5BYtHCuzzwU6GeTyeCLrgq8P4M',   // Noop program
  'SysvarRecentB1ockHashes11111111111111111111',     // Sysvar
  'Sysvar1nstructions1111111111111111111111111',     // Sysvar
]);

interface SwapEvent { ts: number; isBuy: boolean; solAmt: number; }

export interface VelocityData {
  buys60s: number;
  sells60s: number;
  buyRatio60s: number;
  solVolume60s: number;
  velocity: number;
  isAccelerating: boolean;
  ageSec: number;
  firstSeen: number;
  lastSeen: number;
  createdAt: number | null; // when we saw the Create event (null if we missed it)
}

export type AcceleratingCallback = (mint: string, data: VelocityData) => void;
export type NewMintCallback = (mint: string, data: VelocityData) => void;

export class VelocityTracker {
  private rpcHttp: string;
  private wsUrl: string;
  private mintEvents = new Map<string, SwapEvent[]>();
  private mintFirstSeen = new Map<string, number>();
  private prevVelocity = new Map<string, number>();
  private wasAccelerating = new Set<string>();
  private notifiedNewMints = new Set<string>();  // mints we already fired newMint callback for
  private validatedMints = new Set<string>();    // mints confirmed as real tokens via pump.fun API
  private mintCreationTime = new Map<string, number>(); // mint → creation timestamp (when we saw Create event)
  private ws: WebSocket | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private computeInterval: NodeJS.Timeout | null = null;
  private onAccelCallbacks: AcceleratingCallback[] = [];
  private onNewMintCallbacks: NewMintCallback[] = [];
  private activeFetches = 0;
  private fetchQueue = new Set<string>();
  private processedSig = new Set<string>();

  totalEvents = 0;
  totalSwaps = 0;

  constructor(rpcHttp: string) {
    this.rpcHttp = rpcHttp;
    this.wsUrl = rpcHttp.replace('https://', 'wss://').replace('http://', 'ws://');
  }

  /** Register callback for when a mint starts accelerating */
  onAccelerating(cb: AcceleratingCallback) {
    this.onAccelCallbacks.push(cb);
  }

  /** Register callback for when a NEW mint is detected with buy pressure.
   *  Fires once per mint when it first accumulates 3+ buys with >55% buy ratio.
   *  This catches fresh pump.fun launches within seconds of first trade. */
  onNewMint(cb: NewMintCallback) {
    this.onNewMintCallbacks.push(cb);
  }

  /** Get current velocity data for a specific mint */
  getMintData(mint: string): VelocityData | null {
    const now = Date.now();
    const events = this.mintEvents.get(mint);
    if (!events) return null;
    const recent = events.filter(e => e.ts >= now - WINDOW_MS);
    if (recent.length < MIN_SWAPS) return null;
    return this.computeMint(mint, recent, now);
  }

  /** Get all currently hot mints */
  getAllHot(): Map<string, VelocityData> {
    const now = Date.now();
    const result = new Map<string, VelocityData>();
    for (const [mint, events] of this.mintEvents) {
      const recent = events.filter(e => e.ts >= now - WINDOW_MS);
      if (recent.length < MIN_SWAPS) continue;
      const data = this.computeMint(mint, recent, now);
      if (data) result.set(mint, data);
    }
    return result;
  }

  start() {
    console.log('[VELOCITY] Starting in-process velocity tracker');
    this.connect();
    this.computeInterval = setInterval(() => this.computeAndNotify(), 2000);
  }

  stop() {
    if (this.ws) this.ws.close();
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.computeInterval) clearInterval(this.computeInterval);
  }

  /** Validate a mint against pump.fun API, then fire newMint callbacks if real */
  private async validateAndNotifyNewMint(mint: string, data: VelocityData, ageSec: number) {
    try {
      const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        // Not on pump.fun — try DexScreener as fallback
        const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (dexRes.ok) {
          const dexData: any = await dexRes.json();
          if (dexData.pairs && dexData.pairs.length > 0) {
            const pair = dexData.pairs[0];
            if (pair.chainId === 'solana') {
              this.validatedMints.add(mint);
              this.notifiedNewMints.add(mint);
              const symbol = pair.baseToken?.symbol || mint.slice(0, 8);
              console.log(`[VELOCITY] NEW MINT (DexScreener): ${symbol} | ${data.buys60s}B/${data.sells60s}S | tracked ${ageSec.toFixed(0)}s`);
              for (const cb of this.onNewMintCallbacks) {
                try { cb(mint, data); } catch (e: any) {
                  console.error('[VELOCITY] NewMint callback error:', e.message);
                }
              }
              return;
            }
          }
        }
        // Neither pump.fun nor DexScreener — not a real tradeable token
        this.notifiedNewMints.add(mint); // don't retry non-tokens
        console.log(`[VELOCITY] SKIP ${mint.slice(0,8)}... — not found on pump.fun or DexScreener`);
        return;
      }

      const pumpData: any = await res.json();
      if (!pumpData.symbol) {
        this.notifiedNewMints.add(mint);
        console.log(`[VELOCITY] SKIP ${mint.slice(0,8)}... — pump.fun returned no symbol`);
        return;
      }

      this.validatedMints.add(mint);
      this.notifiedNewMints.add(mint);
      const symbol = pumpData.symbol;
      const mcap = pumpData.usd_market_cap || 0;
      console.log(`[VELOCITY] NEW MINT: ${symbol} (${mint.slice(0,8)}) | mcap:$${(mcap/1000).toFixed(1)}k | ${data.buys60s}B/${data.sells60s}S | tracked ${ageSec.toFixed(0)}s`);

      // Publish to Redis for cross-project velocity sharing (Artemis subscribes)
      this.publishToRedis(mint, symbol, mcap, data);

      for (const cb of this.onNewMintCallbacks) {
        try { cb(mint, data); } catch (e: any) {
          console.error('[VELOCITY] NewMint callback error:', e.message);
        }
      }
    } catch (e: any) {
      console.error(`[VELOCITY] Validation error for ${mint.slice(0,8)}: ${e.message}`);
    }
  }

  /** Publish new mint signal to Redis for cross-project sharing */
  private async publishToRedis(mint: string, symbol: string, mcap: number, data: VelocityData) {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) return;
    try {
      const Redis = (await import('ioredis')).default;
      const redis = new Redis(redisUrl, { lazyConnect: true });
      await redis.connect();
      const realSol = data.solVolume60s; // approximate
      const curveProgress = mcap > 0 ? Math.min(100, (mcap / 120000) * 100) : 0; // rough estimate
      await redis.publish('velocity:new-mints', JSON.stringify({
        mint,
        symbol,
        mcap,
        buys60s: data.buys60s,
        sells60s: data.sells60s,
        buyRatio60s: data.buyRatio60s,
        velocity: data.velocity,
        isAccelerating: data.isAccelerating,
        curveProgress,
        timestamp: Date.now(),
        source: 'pcp-sniper',
      }));
      await redis.disconnect();
    } catch { /* non-fatal */ }
  }

  private computeMint(mint: string, recent: SwapEvent[], now: number): VelocityData {
    const buys = recent.filter(e => e.isBuy);
    const total = recent.length;
    const vol = recent.reduce((s, e) => s + e.solAmt, 0);
    const winMs = Math.min(WINDOW_MS, now - (this.mintFirstSeen.get(mint) || now));
    const vel = winMs > 0 ? (total / (winMs / 1000)) * 60 : 0;
    const prev = this.prevVelocity.get(mint) || 0;

    return {
      buys60s: buys.length,
      sells60s: total - buys.length,
      buyRatio60s: total > 0 ? parseFloat((buys.length / total).toFixed(3)) : 0,
      solVolume60s: parseFloat(vol.toFixed(4)),
      velocity: parseFloat(vel.toFixed(1)),
      isAccelerating: vel > prev * 1.2,
      ageSec: Math.floor((now - (this.mintFirstSeen.get(mint) || now)) / 1000),
      firstSeen: this.mintFirstSeen.get(mint)!,
      lastSeen: Math.max(...recent.map(e => e.ts)),
      createdAt: this.mintCreationTime.get(mint) || null,
    };
  }

  private computeAndNotify() {
    const now = Date.now();
    let hotCount = 0;

    for (const [mint, events] of this.mintEvents) {
      const recent = events.filter(e => e.ts >= now - WINDOW_MS);
      this.mintEvents.set(mint, recent);

      if (recent.length < MIN_SWAPS) continue;
      const lastSeen = Math.max(...recent.map(e => e.ts));
      if (now - lastSeen > STALE_MS) {
        this.mintEvents.delete(mint);
        this.mintFirstSeen.delete(mint);
        this.wasAccelerating.delete(mint);
        continue;
      }

      const data = this.computeMint(mint, recent, now);
      this.prevVelocity.set(mint, data.velocity);
      hotCount++;

      // Quick validation: skip known non-token patterns
      // Real pump.fun mints end with "pump", real SPL mints are 32-44 chars base58
      const looksLikeMint = mint.length >= 32 && mint.length <= 44 && !mint.startsWith('1111');
      if (!looksLikeMint) continue;

      // NEW MINT detection — fires ONCE per mint when it first shows buy pressure
      // Lowered thresholds: let more through, scorer + exit logic handles quality
      const trackingSecs = (now - data.firstSeen) / 1000;
      const hasSells = data.sells60s >= 1;
      if (!this.notifiedNewMints.has(mint) && data.buys60s >= 3 && data.buyRatio60s >= 0.50 && trackingSecs >= 5 && hasSells) {
        // Don't add to notifiedNewMints yet — only after validation succeeds
        // This allows retry if pump.fun API is flaky
        const ageSec = (now - data.firstSeen) / 1000;
        this.validateAndNotifyNewMint(mint, data, ageSec);
      }

      // ACCELERATION detection — fires when existing mint velocity increases
      // Only fire for mints that already passed new-mint validation
      if (data.isAccelerating && data.buys60s >= 5 && data.buyRatio60s >= 0.60) {
        if (!this.wasAccelerating.has(mint) && this.validatedMints.has(mint)) {
          this.wasAccelerating.add(mint);
          for (const cb of this.onAccelCallbacks) {
            try { cb(mint, data); } catch (e: any) {
              console.error('[VELOCITY] Accel callback error:', e.message);
            }
          }
        }
      } else {
        this.wasAccelerating.delete(mint);
      }
    }

    // Status line
    if (hotCount > 0 || this.totalEvents % 500 === 0) {
      process.stdout.write(`\r[VELOCITY] Events:${this.totalEvents} Swaps:${this.totalSwaps} Hot:${hotCount} | ${new Date().toISOString().slice(11, 19)}  `);
    }

    // Also write file for debugging (non-blocking)
    this.writeDebugFile(now);
  }

  private writeDebugFile(now: number) {
    try {
      const dir = path.join(process.cwd(), 'signals');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const out: Record<string, any> = {};
      for (const [mint, data] of this.getAllHot()) {
        out[mint] = data;
      }
      fs.writeFileSync(
        path.join(dir, 'velocity.json'),
        JSON.stringify({ updatedAt: now, mintCount: Object.keys(out).length, mints: out })
      );
    } catch { /* non-fatal */ }
  }

  private recordSwap(mint: string, isBuy: boolean, solAmt = 0) {
    if (!this.mintEvents.has(mint)) {
      this.mintEvents.set(mint, []);
      this.mintFirstSeen.set(mint, Date.now());
    }
    this.mintEvents.get(mint)!.push({ ts: Date.now(), isBuy, solAmt });
    this.totalSwaps++;
  }

  private async fetchAndParseMint(signature: string, isBuy: boolean) {
    if (this.processedSig.has(signature) || this.fetchQueue.has(signature)) return;
    if (this.activeFetches >= 5) { this.fetchQueue.add(signature); return; }

    this.fetchQueue.delete(signature);
    this.processedSig.add(signature);
    this.activeFetches++;

    try {
      const res = await fetch(this.rpcHttp, {
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

      for (const k of allKeys) {
        if (k && k.length >= 32 && !SKIP_ADDRS.has(k) && !k.startsWith('1111')) {
          this.recordSwap(k, isBuy, 0);
          break;
        }
      }
    } catch { /* non-fatal */ } finally {
      this.activeFetches--;
      const next = this.fetchQueue.values().next().value;
      if (next) this.fetchAndParseMint(next, true);
    }
  }

  private handleMessage(raw: string) {
    try {
      const msg = JSON.parse(raw);
      if (msg.result && typeof msg.result === 'number') return;

      const value = msg?.params?.result?.value;
      if (!value) return;

      this.totalEvents++;
      const { logs, err, signature } = value;
      if (err || !signature) return;

      const isPump = logs?.some((l: string) =>
        l.includes('pump') || l.includes('Pump') || l.includes('BSfD6') || l.includes('6EF8')
      );
      const isRaydium = logs?.some((l: string) =>
        l.includes('675kPX9') || l.includes('Raydium') || l.includes('ray_log')
      );

      if (isPump) {
        const isBuy = logs.some((l: string) => l.includes('Instruction: Buy'));
        const isSell = logs.some((l: string) => l.includes('Instruction: Sell'));
        const isCreate = logs.some((l: string) => l.includes('Instruction: Create') || l.includes('Instruction: Initialize'));

        if (!isBuy && !isSell && !isCreate) return;

        // Extract mint from log data lines
        // Pump.fun logs contain "Program data:" followed by base64, and
        // "Program log:" lines that sometimes contain the mint address.
        // The most reliable method: fetch the tx to get account keys.
        // For pump.fun, the token mint is typically at accountKeys index 2-4.
        //
        // But first, try the fast path: pump.fun mints end with "pump"
        const mintRegex = /\b([1-9A-HJ-NP-Za-km-z]{38,44}pump)\b/g;
        for (const log of logs) {
          let match;
          while ((match = mintRegex.exec(log)) !== null) {
            const candidate = match[1];
            if (!SKIP_ADDRS.has(candidate) && candidate.length >= 38) {
              if (isCreate) {
                // TOKEN CREATION EVENT — record with special flag
                console.log(`[VELOCITY] TOKEN CREATED: ${candidate.slice(0,12)}... | sig:${signature.slice(0,8)}`);
                this.recordSwap(candidate, true, 0); // treat as a buy
                this.mintCreationTime.set(candidate, Date.now());
              } else {
                this.recordSwap(candidate, isBuy, 0);
              }
              return;
            }
          }
        }

        // Fallback: try any base58 address not in skip list
        const anyMintRegex = /\b([1-9A-HJ-NP-Za-km-z]{43,44})\b/g;
        for (const log of logs) {
          let match;
          while ((match = anyMintRegex.exec(log)) !== null) {
            const candidate = match[1];
            if (!SKIP_ADDRS.has(candidate) && candidate.length >= 43) {
              if (isCreate) {
                this.mintCreationTime.set(candidate, Date.now());
              }
              this.recordSwap(candidate, isBuy || isCreate, 0);
              return;
            }
          }
        }

        // Last resort: fetch tx to resolve mint
        this.fetchAndParseMint(signature, isBuy || isCreate).catch(() => {});
      } else if (isRaydium) {
        const isBuy = logs.some((l: string) => l.includes('SwapBaseIn') || l.includes('swap_base_in'));
        this.fetchAndParseMint(signature, isBuy).catch(() => {});
      }
    } catch { /* non-fatal */ }
  }

  private connect() {
    const masked = this.wsUrl.replace(this.rpcHttp.split('/').slice(-1)[0], '***');
    console.log(`[VELOCITY] Connecting to ${masked}`);
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on('open', () => {
      console.log('[VELOCITY] WS connected');
      let id = 1;
      for (const prog of WATCHED_PROGRAMS) {
        this.ws!.send(JSON.stringify({
          jsonrpc: '2.0', id: id++,
          method: 'logsSubscribe',
          params: [{ mentions: [prog] }, { commitment: 'processed' }]
        }));
      }
      console.log(`[VELOCITY] Subscribed to ${WATCHED_PROGRAMS.length} programs`);

      if (this.pingInterval) clearInterval(this.pingInterval);
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN)
          this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'getHealth' }));
      }, 30_000);
    });

    this.ws.on('message', (data: Buffer) => this.handleMessage(data.toString()));

    this.ws.on('close', (code, reason) => {
      console.log(`\n[VELOCITY] WS closed: ${code} ${reason} — reconnecting in 3s`);
      if (this.pingInterval) clearInterval(this.pingInterval);
      setTimeout(() => this.connect(), 3_000);
    });

    this.ws.on('error', (e: any) => console.error('[VELOCITY] WS error:', e.message));
  }
}
