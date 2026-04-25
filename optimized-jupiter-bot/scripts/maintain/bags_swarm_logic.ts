export interface BagsDexPair {
  mint: string;
  symbol: string;
  name?: string;
  url?: string;
  dexId: string;
  liquidityUsd: number;
  volume1h: number;
  volume5m: number;
  priceChange1h: number;
  priceChange5m: number;
  fdvUsd: number;
  pairCreatedAt?: number;
  buys1h: number;
  sells1h: number;
}

const QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2r3aMc2SGte1qNbfXDnpa9kku',
]);

function toFiniteNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function extractCandidateMintsFromParsedTx(parsedTx: any): string[] {
  const balances = [
    ...(Array.isArray(parsedTx?.meta?.postTokenBalances) ? parsedTx.meta.postTokenBalances : []),
    ...(Array.isArray(parsedTx?.meta?.preTokenBalances) ? parsedTx.meta.preTokenBalances : []),
  ];

  const mints = new Set<string>();
  for (const balance of balances) {
    const mint = balance?.mint;
    if (!mint || typeof mint !== 'string') continue;
    if (QUOTE_MINTS.has(mint)) continue;
    mints.add(mint);
  }
  return [...mints];
}

export function buildBagsTrendingEntry(
  pair: BagsDexPair,
  meta: { source: string; signature: string; launchpad: string; updatedAt?: number },
) {
  return {
    chainId: 'solana',
    dexId: pair.dexId || 'bags-fm',
    url: pair.url,
    baseToken: {
      address: pair.mint,
      name: pair.name || pair.symbol,
      symbol: pair.symbol,
    },
    quoteToken: {
      address: 'So11111111111111111111111111111111111111112',
      symbol: 'SOL',
    },
    priceUsd: '0',
    volume: {
      h1: pair.volume1h,
      m5: pair.volume5m,
    },
    priceChange: {
      h1: pair.priceChange1h,
      m5: pair.priceChange5m,
    },
    liquidity: {
      usd: pair.liquidityUsd,
    },
    fdv: pair.fdvUsd,
    txns: {
      h1: {
        buys: pair.buys1h,
        sells: pair.sells1h,
      },
    },
    pairCreatedAt: pair.pairCreatedAt,
    _bags: {
      source: meta.source,
      signature: meta.signature,
      launchpad: meta.launchpad,
      updatedAt: meta.updatedAt || Date.now(),
    },
  };
}

export function estimateBagsVelocitySignal(
  pair: BagsDexPair,
  now = Date.now(),
  solPriceUsd = 150,
) {
  const ageMinutes = pair.pairCreatedAt
    ? Math.max(1, Math.min(60, (now - pair.pairCreatedAt) / 60_000))
    : 60;
  const buys60s = Math.max(1, Math.ceil(pair.buys1h / ageMinutes));
  const sells60s = Math.max(0, Math.ceil(pair.sells1h / ageMinutes));
  const total60s = Math.max(1, buys60s + sells60s);
  const volumeUsdPerMinute = pair.volume5m > 0 ? pair.volume5m / 5 : pair.volume1h / 60;
  const solVolume60s = Math.max(0.1, volumeUsdPerMinute / Math.max(1, solPriceUsd));

  return {
    buys60s,
    sells60s,
    buyRatio60s: buys60s / total60s,
    velocity: total60s,
    isAccelerating: true,
    solVolume60s,
    source: 'bags-swarm',
    symbol: pair.symbol,
  };
}
