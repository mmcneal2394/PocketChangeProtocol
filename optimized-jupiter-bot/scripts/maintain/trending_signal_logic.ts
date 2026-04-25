export interface NormalizedTrendingToken {
  mint: string;
  symbol: string;
  name?: string;
  dexId?: string;
  url?: string;
  source?: string;
  volume1h: number;
  volume5m: number;
  priceChange1h: number;
  priceChange5m: number;
  liquidityUsd: number;
  fdvUsd: number;
  marketCapUsd: number;
  buys1h: number;
  sells1h: number;
  buyRatio: number;
  pairCreatedAt?: number;
  smartMoney: number;
  holders: number;
  bagsSignal: boolean;
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toOptionalTimestamp(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

export function extractTrendingEntries(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray((raw as any).mints)) {
    return (raw as any).mints;
  }
  return [];
}

export function normalizeTrendingEntry(raw: any): NormalizedTrendingToken | null {
  if (!raw || typeof raw !== 'object') return null;

  const mint = raw.mint || raw.baseToken?.address;
  if (!mint || typeof mint !== 'string') return null;

  const symbol = raw.symbol || raw.baseToken?.symbol || `${mint.slice(0, 8)}...`;
  const name = raw.name || raw.baseToken?.name || symbol;
  const dexId = raw.dexId || raw.dex_id || undefined;
  const source =
    raw.source ||
    raw.meta?.source ||
    raw._gmgn?.source ||
    raw._bags?.source ||
    dexId ||
    undefined;

  const volume1h = toFiniteNumber(raw.volume1h ?? raw.volume?.h1);
  const volume5m = toFiniteNumber(raw.volume5m ?? raw.volume?.m5);
  const priceChange1h = toFiniteNumber(raw.priceChange1h ?? raw.priceChange?.h1);
  const priceChange5m = toFiniteNumber(raw.priceChange5m ?? raw.priceChange?.m5);
  const liquidityUsd = toFiniteNumber(raw.liquidityUsd ?? raw.liquidity?.usd);
  const marketCapUsd = toFiniteNumber(raw.marketCapUsd ?? raw.marketCap ?? raw.fdv);
  const fdvUsd = toFiniteNumber(raw.fdvUsd ?? raw.fdv ?? raw.marketCap);
  const buys1h = Math.max(0, Math.round(toFiniteNumber(raw.buys1h ?? raw.txns?.h1?.buys)));
  const sells1h = Math.max(0, Math.round(toFiniteNumber(raw.sells1h ?? raw.txns?.h1?.sells)));
  const inferredBuyRatio =
    buys1h > 0 ? buys1h / Math.max(1, sells1h) : 0;
  const buyRatio = Math.max(toFiniteNumber(raw.buyRatio, inferredBuyRatio), inferredBuyRatio);
  const pairCreatedAt = toOptionalTimestamp(raw.pairCreatedAt ?? raw.createdAt ?? raw.created_at);
  const smartMoney = toFiniteNumber(raw.smartMoney ?? raw._gmgn?.smartMoney);
  const holders = Math.max(0, Math.round(toFiniteNumber(raw.holders ?? raw._gmgn?.holders)));
  const bagsSignal =
    dexId === 'bags-fm' ||
    source === 'bags-swarm' ||
    source === 'ws_bagsfm';

  return {
    mint,
    symbol,
    name,
    dexId,
    url: raw.url || undefined,
    source,
    volume1h,
    volume5m,
    priceChange1h,
    priceChange5m,
    liquidityUsd,
    fdvUsd,
    marketCapUsd,
    buys1h,
    sells1h,
    buyRatio,
    pairCreatedAt,
    smartMoney,
    holders,
    bagsSignal,
  };
}

export function buildTrendingMap(raw: unknown): Map<string, NormalizedTrendingToken> {
  const map = new Map<string, NormalizedTrendingToken>();
  for (const entry of extractTrendingEntries(raw)) {
    const normalized = normalizeTrendingEntry(entry);
    if (!normalized) continue;
    map.set(normalized.mint, normalized);
  }
  return map;
}
