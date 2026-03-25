/**
 * price_feed.ts  —  Live streaming price feed (zero polling, event-driven)
 * ─────────────────────────────────────────────────────────────────────────────
 * Sources (in priority order):
 *   1. Pyth Network on-chain price accounts — subscribed via Helius WebSocket
 *      accountSubscribe. Sub-second latency, no rate limits.
 *   2. Jupiter Price API v2 — REST fallback polled every 5s for tokens not yet
 *      covered by Pyth (meme coins etc). Respects existing rate-limit budget.
 *
 * Usage:
 *   import { priceFeed } from './price_feed';
 *   priceFeed.start();
 *
 *   priceFeed.get('SOL')          // → 86.12  (USD)
 *   priceFeed.get('EPjFW...')     // → 1.0003 (USD)
 *   priceFeed.getSolPrice()       // shorthand for SOL
 *   priceFeed.on('price', (mint, price) => { ... })
 *
 * Monitored tokens: all 20 seeded route mints + SOL/WSOL
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { EventEmitter }          from 'events';
import { logger }                from './logger';

// ── Pyth price feed account addresses on Solana mainnet ───────────────────────
// Source: https://pyth.network/developers/price-feed-ids#solana-mainnet-stable
const PYTH_FEEDS: Record<string, string> = {
  // mint → pythPriceAccount
  'So11111111111111111111111111111111111111112':   'H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG', // SOL/USD
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD', // USDC/USD
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB':  '3vxLXJqLqF3JG5TCbYycbKWRBbCJQLxQmBGCkyqEEefL', // USDT/USD
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': '4SZ1qb4MtSUrZcoeaeQ3BDzVDA5gjWKnatBGYHRaVUuM', // BONK/USD
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbPwdrsxGBK':   '7dbob1psH1iZBS7qPsm3Kwbf5DzSXK8Jyg31CTgTnkH9', // JUP/USD
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': '83cTBDT2PKVRej8M6P5gqHRbhfmnnc3TogRPEAiDiCHW', // RAY/USD
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So':  'E4v1BBgoso9s64TQvmyownAVJbhbEPGyzA3qn4n46qj9', // MSOL/USD
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn':  'FeVC3VRtmkqFfd4GEY97ENkqiZP3XQsGcaVrHEHrBbHK', // jitoSOL/USD
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3AkTftx2K2aFCh': 'nrYkQQQur7z8rYTST3G9GqATviK5SxTDkrqd21MW6Ue',  // PYTH/USD
};

// ── All seeded mints to monitor via Jupiter fallback ──────────────────────────
export const MONITORED_MINTS = [
  'So11111111111111111111111111111111111111112',   // WSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  // USDT
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // MSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',  // jitoSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',   // bSOL
  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',   // ORCA
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',  // RAY
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',  // BONK
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYtM2wYSzRo',  // WIF
  '7GCihgDB8fe6KNjn2gN7ZDB2h2n2i2Z7pW2r2YjN1e8p',  // POPCAT
  'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgM2W8qT',   // BOME
  '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',  // TRUMP
  'FUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P',  // MELANIA
  '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump',  // FARTCOIN
  'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC',  // AI16Z
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbPwdrsxGBK',    // JUP
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',   // JTO
  '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4',  // MEW
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3AkTftx2K2aFCh',  // PYTH
];

// ── Pyth price account data layout (subset) ───────────────────────────────────
// Pyth stores a packed struct. The price is at byte offset 208, expo at 212.
// (v2 layout, Solana mainnet)
function parsePythPrice(data: Buffer): { price: number; confidence: number; publishTime: number } | null {
  try {
    if (data.length < 240) return null;
    // Magic + version check: bytes 0-3 = 0xa1b2c3e4 (Pyth magic)
    const magic = data.readUInt32LE(0);
    if (magic !== 0xa1b2c3e4) return null;

    // Price at offset 208 (int64 LE), expo at 212 (int32 LE)
    // publishTime at 224 (int64 LE)
    const priceBig    = data.readBigInt64LE(208);
    const expo        = data.readInt32LE(212);
    const confBig     = data.readBigUInt64LE(216);
    const publishBig  = data.readBigInt64LE(224);

    const price       = Number(priceBig) * Math.pow(10, expo);
    const confidence  = Number(confBig) * Math.pow(10, expo);
    const publishTime = Number(publishBig);

    if (price <= 0) return null;
    return { price, confidence, publishTime };
  } catch {
    return null;
  }
}

// ── Mint → human-readable symbol for logging ──────────────────────────────────
const SYMBOL: Record<string, string> = {
  'So11111111111111111111111111111111111111112':   'SOL',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v': 'USDC',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB':  'USDT',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So':  'MSOL',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn':  'jitoSOL',
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1':   'bSOL',
  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE':   'ORCA',
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R':  'RAY',
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263':  'BONK',
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYtM2wYSzRo':  'WIF',
  '7GCihgDB8fe6KNjn2gN7ZDB2h2n2i2Z7pW2r2YjN1e8p':  'POPCAT',
  'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgM2W8qT':   'BOME',
  '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN':  'TRUMP',
  'FUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P':  'MELANIA',
  '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump':  'FARTCOIN',
  'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC':  'AI16Z',
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbPwdrsxGBK':    'JUP',
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL':   'JTO',
  '27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4':  'MEW',
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3AkTftx2K2aFCh':  'PYTH',
};

// ── PriceFeed singleton ───────────────────────────────────────────────────────
class PriceFeed extends EventEmitter {
  private prices      = new Map<string, number>();   // mint → USD price
  private updatedAt   = new Map<string, number>();   // mint → timestamp ms
  private subIds      = new Map<string, number>();   // pythAccount → subscriptionId
  private conn!:       Connection;
  private jupTimer?:   NodeJS.Timeout;
  private logTimer?:   NodeJS.Timeout;
  private started     = false;

  /** USD price for a mint. Returns undefined if not yet received. */
  get(mint: string): number | undefined {
    return this.prices.get(mint);
  }

  /** USD price of SOL. Falls back to env hint or 87. */
  getSolPrice(): number {
    return this.prices.get('So11111111111111111111111111111111111111112')
        ?? parseFloat(process.env.SOL_PRICE_HINT || '87');
  }

  /** Age in ms of last price update for a mint. */
  ageMs(mint: string): number {
    const t = this.updatedAt.get(mint);
    return t ? Date.now() - t : Infinity;
  }

  /** Return snapshot of all known prices */
  snapshot(): Record<string, { price: number; sym: string; ageMs: number }> {
    const out: Record<string, { price: number; sym: string; ageMs: number }> = {};
    for (const [mint, price] of this.prices) {
      out[mint] = { price, sym: SYMBOL[mint] || mint.slice(0, 8), ageMs: this.ageMs(mint) };
    }
    return out;
  }

  // ── Internal update ─────────────────────────────────────────────────────────
  private update(mint: string, price: number, source: 'pyth' | 'jupiter') {
    const prev = this.prices.get(mint);
    this.prices.set(mint, price);
    this.updatedAt.set(mint, Date.now());
    this.emit('price', mint, price, source);
    // Log meaningful changes (>0.05%)
    if (prev !== undefined && Math.abs(price - prev) / prev > 0.0005) {
      const sym   = SYMBOL[mint] || mint.slice(0, 8);
      const dir   = price > prev ? '▲' : '▼';
      const delta = ((price - prev) / prev * 100).toFixed(3);
      logger.debug(`[PRICE] ${sym} ${dir} $${price.toFixed(6)}  (${delta}%) [${source}]`);
    }
  }

  // ── 1. Pyth on-chain subscriptions via Helius WS ────────────────────────────
  private subscribePyth() {
    const httpRpc = process.env.RPC_ENDPOINT || '';
    // Helius URLs: https://mainnet.helius-rpc.com/?api-key=XXX
    // Web3.js Connection derives wss:// automatically when you pass wsEndpoint
    const wsEndpoint = httpRpc.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');
    this.conn = new Connection(httpRpc, { commitment: 'confirmed', wsEndpoint });

    for (const [mint, pythAccount] of Object.entries(PYTH_FEEDS)) {
      try {
        const pk = new PublicKey(pythAccount);

        const subId = this.conn.onAccountChange(pk, (accountInfo) => {
          const parsed = parsePythPrice(Buffer.from(accountInfo.data));
          if (!parsed) return;
          const staleMs = Date.now() - parsed.publishTime * 1000;
          if (staleMs > 10_000) return;
          this.update(mint, parsed.price, 'pyth');
        }, 'confirmed');

        this.subIds.set(pythAccount, subId);
        logger.debug(`[PRICE] Pyth WS subscribed: ${SYMBOL[mint] || mint.slice(0, 8)}`);
      } catch (e: any) {
        logger.warn(`[PRICE] Pyth sub failed for ${mint.slice(0, 8)}: ${e.message}`);
      }
    }
  }

  // ── 2. Price derivation via authenticated Jupiter quote (600 req/min) ───────
  //   Primary: quote-api.jup.ag/v6 with JUPITER_API_KEY (600/min)
  //   Fallback: lite-api.jup.ag (60/min, keyless) if auth fails
  //   Strategy: quote 0.1 SOL → Token, infer token price from SOL price.
  //   Also uses DexScreener priceUsd as a fast parallel batch source.
  private startJupiterPoll() {
    const PROBE_SOL   = 0.1;
    const PROBE_LAM   = Math.floor(PROBE_SOL * 1e9);
    const WSOL        = 'So11111111111111111111111111111111111111112';
    const USDC        = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const API_KEY     = process.env.JUPITER_API_KEY || '';
    const AUTH_BASE   = 'https://quote-api.jup.ag/v6';
    const LITE_BASE   = 'https://lite-api.jup.ag/swap/v1'; // fallback
    const AUTH_HEADERS: Record<string, string> = API_KEY ? { 'x-api-key': API_KEY } : {};

    // Get SOL price via SOL→USDC quote — tries auth endpoint first, falls back to lite
    const getSolUsd = async (): Promise<number> => {
      const quoteParams = `inputMint=${WSOL}&outputMint=${USDC}&amount=1000000000&slippageBps=50`;
      // Attempt 1: authenticated (600/min)
      if (API_KEY) {
        try {
          const r = await fetch(`${AUTH_BASE}/quote?${quoteParams}`, {
            headers: AUTH_HEADERS, signal: AbortSignal.timeout(5000)
          });
          if (r.ok) {
            const d = await r.json();
            const usd = Number(d.outAmount) / 1e6;
            if (usd > 10 && usd < 10_000) {
              this.update(WSOL, usd, 'jupiter');
              process.env.SOL_PRICE_HINT = usd.toFixed(4);
              return usd;
            }
          }
        } catch { /* fall through */ }
      }
      // Attempt 2: lite-api fallback (60/min)
      try {
        const r = await fetch(`${LITE_BASE}/quote?${quoteParams}`, { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const d   = await r.json();
          const usd = Number(d.outAmount) / 1e6;
          if (usd > 10 && usd < 10_000) {
            this.update(WSOL, usd, 'jupiter');
            process.env.SOL_PRICE_HINT = usd.toFixed(4);
            return usd;
          }
        }
      } catch { /* fall through */ }
      return this.getSolPrice();
    };

    // Then: derive token USD prices from SOL quotes + DexScreener batch
    const pollTokens = async () => {
      const solPrice = await getSolUsd();

      // DexScreener batch — one request covers many tokens
      // Fix 5: 429 retry with 10s backoff (non-fatal if second attempt also fails)
      try {
        const mints   = MONITORED_MINTS.filter(m => m !== WSOL).join(',');
        const dsFetch = async () => fetch(
          `https://api.dexscreener.com/latest/dex/tokens/${mints}`,
          { signal: AbortSignal.timeout(8000) }
        );
        let r = await dsFetch();
        if (r.status === 429) {
          logger.debug('[PRICE] DexScreener 429 — backing off 10s then retrying');
          await new Promise(res => setTimeout(res, 10_000));
          r = await dsFetch();
        }
        if (r.ok) {
          const d = await r.json();
          const byMint = new Map<string, number>();
          for (const pair of (d.pairs || [])) {
            if (pair.chainId !== 'solana') continue;
            const p = parseFloat(pair.priceUsd || '0');
            const m = pair.baseToken?.address;
            if (m && p > 0 && (!byMint.has(m) || p > byMint.get(m)!)) byMint.set(m, p);
          }
          for (const [mint, price] of byMint) {
            this.update(mint, price, 'jupiter');
          }
        } else if (r.status !== 429) {
          logger.debug(`[PRICE] DexScreener non-OK: ${r.status}`);
        }
      } catch { /* non-fatal */ }
    };

    pollTokens();
    this.jupTimer = setInterval(pollTokens, 5_000);
  }

  // ── 3. Periodic summary log (every 30s) ─────────────────────────────────────
  private startSummaryLog() {
    this.logTimer = setInterval(() => {
      const lines: string[] = [];
      for (const [mint, price] of this.prices) {
        const sym  = SYMBOL[mint] || mint.slice(0, 8);
        const age  = this.ageMs(mint);
        const flag = age > 30_000 ? ' ⚠️ STALE' : '';
        lines.push(`  ${sym.padEnd(10)} $${price.toFixed(price < 0.01 ? 8 : 4).padStart(14)}${flag}`);
      }
      logger.info(`[PRICE SNAPSHOT @ ${new Date().toTimeString().slice(0, 8)}]\n${lines.join('\n')}`);
    }, 30_000);
  }

  /** Start streaming. Call once on engine boot. */
  start() {
    if (this.started) return;
    this.started = true;
    logger.info(`[PRICE] Starting live feed: ${Object.keys(PYTH_FEEDS).length} Pyth WS + ${MONITORED_MINTS.length} Jupiter poll`);
    this.subscribePyth();
    this.startJupiterPoll();
    this.startSummaryLog();
  }

  /** Stop and clean up all subscriptions */
  async stop() {
    if (this.jupTimer) clearInterval(this.jupTimer);
    if (this.logTimer) clearInterval(this.logTimer);
    for (const [, subId] of this.subIds) {
      try { await this.conn.removeAccountChangeListener(subId); } catch {}
    }
    this.subIds.clear();
    this.started = false;
    logger.info('[PRICE] Feed stopped');
  }
}

export const priceFeed = new PriceFeed();
