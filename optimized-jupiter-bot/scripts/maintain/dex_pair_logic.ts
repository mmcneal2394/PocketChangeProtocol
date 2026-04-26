function toFiniteNumber(value: any, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export type NormalizedDexScreenerPair = {
  liquidity: number;
  marketCap: number;
  fdv: number;
  priceChange1m: number;
  priceChange5m: number;
  priceChange1h: number;
  volume5m: number;
  volume1h: number;
  volume6h: number;
  boosted: boolean;
  pairCreatedAt?: number;
};

export function normalizeDexScreenerPair(pair: any): NormalizedDexScreenerPair {
  return {
    liquidity: toFiniteNumber(pair?.liquidity?.usd, 0),
    marketCap: toFiniteNumber(pair?.marketCap, 0),
    fdv: toFiniteNumber(pair?.fdv ?? pair?.marketCap, 0),
    priceChange1m: toFiniteNumber(pair?.priceChange?.m1, 0),
    priceChange5m: toFiniteNumber(pair?.priceChange?.m5, 0),
    priceChange1h: toFiniteNumber(pair?.priceChange?.h1, 0),
    volume5m: toFiniteNumber(pair?.volume?.m5, 0),
    volume1h: toFiniteNumber(pair?.volume?.h1, 0),
    volume6h: toFiniteNumber(pair?.volume?.h6, 0),
    boosted: Boolean(pair?.boosts?.active && pair.boosts.active > 0),
    pairCreatedAt: pair?.pairCreatedAt || pair?.createdAt || undefined,
  };
}

module.exports = {
  normalizeDexScreenerPair,
};
