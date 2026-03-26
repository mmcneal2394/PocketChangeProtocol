/**
 * trending_injector.ts  v2
 * ─────────────────────────────────────────────────────────────────────────────
 * Targets LOW-CAP volatile tokens ($5k–$150k mcap) from DexScreener's
 * latest pairs endpoint. Pulls buy/sell txn counts as momentum signal.
 *
 * Edge: At $15k mcap, buy:sell ratio of 3:1 means real demand vs bots.
 * A token with 80 buys and 12 sells in the last hour is a far stronger
 * signal than one with $500k volume but balanced order flow.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs   from 'fs';
import path from 'path';

const SIGNALS_DIR   = path.join(process.cwd(), 'signals');
const OUT_FILE      = path.join(SIGNALS_DIR, 'trending.json');
const POLL_MS       = 60_000;  // every 60s — lower than before for faster signals
const TOP_N         = 20;

// DexScreener new pairs endpoint (most volatile, newest launches)
const NEW_PAIRS_SOL = 'https://api.dexscreener.com/latest/dex/search?q=SOL&chainId=solana';
const BOOSTED_URL   = 'https://api.dexscreener.com/token-boosts/latest/v1';
const PAIRS_URL     = 'https://api.dexscreener.com/latest/dex/tokens/';

// Low-cap filter params
const MIN_LIQ_USD    = 1_000;    // $1k min liquidity
const MAX_LIQ_USD    = 500_000;  // $500k max
const MIN_VOL_1H     = 1_000;    // $1k min 1h volume — aggressive mode
const MIN_BUYS_1H    = 8;        // 8 buy txns minimum
const MIN_BUY_RATIO  = 1.2;      // 1.2x — enough buy pressure to be directional

export interface TrendingMint {
  mint:           string;
  symbol:         string;
  volume1h:       number;
  priceChange1h:  number;
  priceChange5m?: number;   // sub-5min freshness — key for entry timing
  priceChange1m?: number;   // 1-min momentum for ultra-fresh entries
  pairCreatedAt?: number;   // unix ms — age gate in sniper
  liquidity:      number;
  dexCount:       number;
  buys1h:         number;
  sells1h:        number;
  buyRatio:       number;   // buys / sells — higher = more buy pressure
  mcapUsd:        number;
  source:         string;
}

interface TrendingSignal {
  mints:     TrendingMint[];
  updatedAt: number;
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function scoreMint(m: TrendingMint): number {
  // Score = buy ratio * price momentum + log(volume) - log(liquidity)
  // Higher score = more volatile, more buy pressure, smaller cap
  const momentumScore = m.buyRatio * Math.abs(m.priceChange1h);
  const volScore      = Math.log10(m.volume1h + 1) * 5;
  const capPenalty    = Math.log10(m.liquidity + 1) * 2; // penalise larger caps
  return momentumScore + volScore - capPenalty;
}

async function processPair(pair: any): Promise<TrendingMint | null> {
  try {
    // Skip non-Solana
    if (pair.chainId !== 'solana') return null;

    const mint    = pair.baseToken?.address;
    const symbol  = pair.baseToken?.symbol || '?';
    const liq     = pair.liquidity?.usd || 0;
    const vol1h   = pair.volume?.h1 || 0;
    const pc1h    = pair.priceChange?.h1 || 0;
    const mcap    = pair.marketCap || pair.fdv || liq * 10; // rough estimate

    // Liquidity gate — must be tradeable
    if (liq < MIN_LIQ_USD || liq > MAX_LIQ_USD) return null;
    if (vol1h < MIN_VOL_1H) return null;
    if (!mint) return null;

    // Buy/sell txn counts
    const buys1h  = pair.txns?.h1?.buys  || 0;
    const sells1h = pair.txns?.h1?.sells || 1; // avoid div/0
    const buyRatio = buys1h / sells1h;

    if (buys1h < MIN_BUYS_1H)     return null;
    if (buyRatio < MIN_BUY_RATIO) return null;
    // Removed: pc1h <= 0 hard block — sniper's own filters handle direction

    const pc5m    = pair.priceChange?.m5  ?? undefined;  // 5-min freshness
    const pc1m    = pair.priceChange?.m1  ?? undefined;  // 1-min momentum
    const createdAt = pair.pairCreatedAt  ? Number(pair.pairCreatedAt) : undefined;

    return { mint, symbol, volume1h: vol1h, priceChange1h: pc1h,
             priceChange5m: pc5m, priceChange1m: pc1m, pairCreatedAt: createdAt,
             liquidity: liq, dexCount: 1, buys1h, sells1h, buyRatio,
             mcapUsd: mcap, source: 'DexScreener-NewPairs' };
  } catch { return null; }
}

async function collectMints(): Promise<TrendingMint[]> {
  const seen = new Map<string, TrendingMint>();

  // Source 1: Latest Solana pairs (new launches, high volatility)
  try {
    const data  = await fetchJson('https://api.dexscreener.com/token-profiles/latest/v1');
    const mints = (data as any[]).filter(t => t.chainId === 'solana').slice(0, 30);

    // Fetch full pair data for each profiled token
    await Promise.allSettled(mints.map(async (t: any) => {
      try {
        const pairData = await fetchJson(`${PAIRS_URL}${t.tokenAddress}`);
        const pairs: any[] = (pairData?.pairs || []).filter((p: any) => p.chainId === 'solana');
        if (!pairs.length) return;

        // Take the pair with highest 1h volume
        const best = pairs.sort((a: any, b: any) => (b.volume?.h1 || 0) - (a.volume?.h1 || 0))[0];
        const entry = await processPair({ ...best, baseToken: { address: t.tokenAddress, symbol: pairs[0]?.baseToken?.symbol } });
        if (entry) {
          seen.set(t.tokenAddress, { ...entry, dexCount: new Set(pairs.map((p: any) => p.dexId)).size });
        }
      } catch { /* skip */ }
    }));
  } catch (e: any) {
    console.warn('[TRENDING] Profile fetch failed:', e.message);
  }

  // Source 2: Search for active Solana pairs directly
  try {
    const searches = [
      'https://api.dexscreener.com/latest/dex/search?q=pump',
      'https://api.dexscreener.com/latest/dex/search?q=solana',
    ];
    for (const url of searches) {
      const data   = await fetchJson(url);
      const pairs: any[] = (data?.pairs || []).filter((p: any) => p.chainId === 'solana');
      for (const pair of pairs) {
        if (seen.has(pair.baseToken?.address)) continue;
        const entry = await processPair(pair);
        if (entry) seen.set(entry.mint, entry);
      }
    }
  } catch (e: any) {
    console.warn('[TRENDING] Search fetch failed:', e.message);
  }

  // Source 3: DexScreener boosted (paid attention = community watching)
  try {
    const boosted: any[] = await fetchJson(BOOSTED_URL);
    const solMints = boosted.filter(t => t.chainId === 'solana').slice(0, 15);
    await Promise.allSettled(solMints.map(async (t: any) => {
      if (seen.has(t.tokenAddress)) return;
      try {
        const pairData = await fetchJson(`${PAIRS_URL}${t.tokenAddress}`);
        const pairs: any[] = (pairData?.pairs || []).filter((p: any) => p.chainId === 'solana');
        if (!pairs.length) return;
        const best = pairs.sort((a: any, b: any) => (b.volume?.h1 || 0) - (a.volume?.h1 || 0))[0];
        const entry = await processPair({ ...best, baseToken: { address: t.tokenAddress, symbol: pairs[0]?.baseToken?.symbol } });
        if (entry) seen.set(t.tokenAddress, { ...entry, dexCount: new Set(pairs.map((p: any) => p.dexId)).size, source: 'DexScreener-Boosted' });
      } catch { /* skip */ }
    }));
  } catch { /* skip */ }

  // Sort by score (buy pressure × momentum)
  const sorted = [...seen.values()].sort((a, b) => scoreMint(b) - scoreMint(a));
  return sorted.slice(0, TOP_N);
}

async function run() {
  if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });

  const poll = async () => {
    try {
      console.log('[TRENDING] Scanning low-cap tokens with buy/sell pressure...');
      const mints = await collectMints();

      const signal: TrendingSignal = { mints, updatedAt: Date.now() };
      fs.writeFileSync(OUT_FILE, JSON.stringify(signal, null, 2));

      console.log(`[TRENDING] ✅ ${mints.length} qualifying tokens:`);
      mints.slice(0, 10).forEach(m =>
        console.log(
          `  ${m.symbol.padEnd(12)} | $${(m.mcapUsd/1000).toFixed(0)}k mcap | ` +
          `+${m.priceChange1h.toFixed(0)}%/1h | ` +
          `buys:${m.buys1h} sells:${m.sells1h} ratio:${m.buyRatio.toFixed(1)}x | ` +
          `liq:$${(m.liquidity/1000).toFixed(0)}k [${m.source}]`
        )
      );
    } catch (e: any) {
      console.error('[TRENDING] Poll failed:', e.message);
    }
  };

  await poll();
  setInterval(poll, POLL_MS);
  process.on('SIGTERM', () => process.exit(0));
}

run();
