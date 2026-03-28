/**
 * birdeye.ts — Birdeye API client for token enrichment
 * ─────────────────────────────────────────────────────────────────────────────
 * Paid tier: 5M CUs/mo, 15 rps. Using ~7 rps for PCP.
 * Provides: token overview, security, price, holder data
 * ─────────────────────────────────────────────────────────────────────────────
 */

const API_KEY = process.env.BIRDEYE_API_KEY || '';
const BASE = 'https://public-api.birdeye.so';

// Rate limiter: max 7 rps for this project
let lastCallMs = 0;
const MIN_INTERVAL_MS = 143; // ~7 rps

async function rateLimitedFetch(url: string): Promise<any> {
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastCallMs));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCallMs = Date.now();

  const res = await fetch(url, {
    headers: {
      'X-API-KEY': API_KEY,
      'X-Chain': 'solana',
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const data: any = await res.json();
  return data.data || data;
}

export interface TokenOverview {
  price: number;
  mcap: number;
  liquidity: number;
  holders: number;
  volume24h: number;
  priceChange1h: number;
  priceChange24h: number;
  buy24h: number;
  sell24h: number;
  uniqueWallets24h: number;
}

export interface TokenSecurity {
  isHoneypot: boolean;
  top10HolderPct: number;
  creatorPct: number;
  isMutable: boolean;
  hasFreezeAuthority: boolean;
  hasMintAuthority: boolean;
}

/** Get comprehensive token overview — price, mcap, liq, holders, volume */
export async function getTokenOverview(mint: string): Promise<TokenOverview | null> {
  if (!API_KEY) return null;
  try {
    const d = await rateLimitedFetch(`${BASE}/defi/token_overview?address=${mint}`);
    if (!d) return null;
    return {
      price: d.price || 0,
      mcap: d.mc || d.realMc || 0,
      liquidity: d.liquidity || 0,
      holders: d.holder || 0,
      volume24h: d.v24hUSD || 0,
      priceChange1h: d.priceChange1hPercent || 0,
      priceChange24h: d.priceChange24hPercent || 0,
      buy24h: d.buy24h || 0,
      sell24h: d.sell24h || 0,
      uniqueWallets24h: d.uniqueWallet24h || 0,
    };
  } catch { return null; }
}

/** Get token security info — rug detection */
export async function getTokenSecurity(mint: string): Promise<TokenSecurity | null> {
  if (!API_KEY) return null;
  try {
    const d = await rateLimitedFetch(`${BASE}/defi/token_security?address=${mint}`);
    if (!d) return null;
    return {
      isHoneypot: d.isHoneypot === true,
      top10HolderPct: d.top10HolderPercent || 0,
      creatorPct: d.creatorPercentage || 0,
      isMutable: d.mutableMetadata === true,
      hasFreezeAuthority: d.freezeAuthority !== null && d.freezeAuthority !== undefined,
      hasMintAuthority: d.mintAuthority !== null && d.mintAuthority !== undefined,
    };
  } catch { return null; }
}

/** Get current price — fast, for observer checks */
export async function getPrice(mint: string): Promise<number | null> {
  if (!API_KEY) return null;
  try {
    const d = await rateLimitedFetch(`${BASE}/defi/price?address=${mint}`);
    if (!d) return null;
    return d.value || 0;
  } catch { return null; }
}

/** Get multiple prices in one call — batch efficiency */
export async function getMultiPrice(mints: string[]): Promise<Record<string, number>> {
  if (!API_KEY || mints.length === 0) return {};
  try {
    const list = mints.join(',');
    const d = await rateLimitedFetch(`${BASE}/defi/multi_price?list_address=${list}`);
    if (!d) return {};
    const result: Record<string, number> = {};
    for (const [mint, data] of Object.entries(d as Record<string, any>)) {
      result[mint] = (data as any).value || 0;
    }
    return result;
  } catch { return {}; }
}

/** Full enrichment: overview + security in 2 calls */
export async function enrichToken(mint: string): Promise<{
  overview: TokenOverview | null;
  security: TokenSecurity | null;
}> {
  const [overview, security] = await Promise.all([
    getTokenOverview(mint),
    getTokenSecurity(mint),
  ]);
  return { overview, security };
}

/** Check if Birdeye API is configured */
export function isConfigured(): boolean {
  return API_KEY.length > 0;
}
