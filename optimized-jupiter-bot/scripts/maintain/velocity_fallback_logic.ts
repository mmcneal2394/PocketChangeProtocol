import { extractTrendingEntries, normalizeTrendingEntry } from './trending_signal_logic';
import { evaluateGmgnSourceQuality } from './gmgn_source_quality_logic';

function clampNumber(value: any, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function toBuyRatioFraction(value: any, fallback = 0.65): number {
  const ratio = Number(value);
  if (!Number.isFinite(ratio) || ratio <= 0) return fallback;
  return clampNumber(ratio / (1 + ratio), fallback, 0.5, 0.99);
}

function computeTrendingScore(token: any, walletSignal: any): number {
  const bagsBoost = token?.bagsSignal ? 1.5 : 1;
  const walletBoost = walletSignal?.executable ? 2 : walletSignal ? 1.3 : 1;
  const momentumBoost = Math.max(1, Number(token?.priceChange5m || 0) / 10);
  const volumeBoost = Math.max(1, Number(token?.volume5m || 0) / 5_000);
  return bagsBoost * walletBoost * momentumBoost * volumeBoost;
}

function shouldIncludeCompositeTrendingToken(token: any, walletSignal: any): boolean {
  if (!token?.mint) return false;
  const gmgnSourceQuality = evaluateGmgnSourceQuality({
    source: token?.source,
    priceChange5m: token?.priceChange5m,
    priceChange1h: token?.priceChange1h,
    volume5mUsd: token?.volume5m,
    holders: token?.holders,
    smartMoney: token?.smartMoney,
    pairCreatedAt: token?.pairCreatedAt,
    now: Date.now(),
    bagsSignal: token?.bagsSignal,
    walletExecutable: walletSignal?.executable,
  });
  if (!gmgnSourceQuality.include) return false;

  if (token?.bagsSignal || walletSignal?.executable) return true;
  if (String(token?.source || '').toLowerCase() !== 'onchain-launchpad') return true;

  const buysPerMinute = Number(token?.buys1h || 0) / 60;
  const strongDexEvidence =
    Number(token?.liquidityUsd || 0) >= 20_000 &&
    Number(token?.volume5m || 0) >= 10_000 &&
    Number(token?.priceChange5m || 0) >= 5 &&
    Number(token?.priceChange1h || 0) >= 0 &&
    buysPerMinute >= 8 &&
    Number(token?.buyRatio || 0) >= 1.35;

  return strongDexEvidence;
}

function resolveSyntheticSource(token: any, walletSignal: any): string {
  const source = String(token?.source || '').toLowerCase();
  if (walletSignal) {
    return source === 'onchain-launchpad'
      ? 'composite-onchain-launchpad-wallet'
      : 'composite-trending-wallet';
  }
  return source === 'onchain-launchpad'
    ? 'composite-onchain-launchpad'
    : 'composite-trending';
}

export function buildCompositeVelocityEntries(input: {
  rawTrending?: unknown;
  walletSignalsDocument?: any;
  solPriceUsd?: number;
  now?: number;
  limit?: number;
} = {}): Record<string, any> {
  const now = Number(input.now || Date.now());
  const solPriceUsd = clampNumber(input.solPriceUsd, 150, 1, 10_000);
  const limit = Math.round(clampNumber(input.limit, 60, 1, 500));
  const walletSignals: any[] = Array.isArray(input.walletSignalsDocument?.buy_signals)
    ? input.walletSignalsDocument.buy_signals
    : [];
  const walletByMint = new Map<string, any>(walletSignals.map((signal: any) => [String(signal?.mint || ''), signal]));
  const composite = new Map<string, any>();

  const normalizedTrending: any[] = extractTrendingEntries(input.rawTrending)
    .map((entry) => normalizeTrendingEntry(entry))
    .filter(Boolean)
    .filter((token: any) => shouldIncludeCompositeTrendingToken(token, walletByMint.get(token.mint)))
    .sort((left: any, right: any) => {
      const rightScore = computeTrendingScore(right, walletByMint.get(right.mint));
      const leftScore = computeTrendingScore(left, walletByMint.get(left.mint));
      return rightScore - leftScore;
    })
    .slice(0, limit);

  for (const token of normalizedTrending) {
    const walletSignal = walletByMint.get(token.mint);
    const buyRatio60s = Math.max(
      toBuyRatioFraction(token.buyRatio, token.bagsSignal ? 0.72 : 0.65),
      walletSignal?.executable ? 0.75 : 0,
    );
    const walletBuysBoost = walletSignal?.executable ? (walletSignal.sizeUp ? 8 : 5) : 0;
    const buys60s = Math.round(clampNumber(
      Math.max((token.buys1h || 0) / 60, walletBuysBoost, token.bagsSignal ? 6 : 0),
      5,
      3,
      60,
    ));
    const sells60s = Math.round(clampNumber(
      Math.max((token.sells1h || 0) / 60, buys60s * ((1 - buyRatio60s) / Math.max(0.01, buyRatio60s))),
      1,
      0,
      60,
    ));
    const velocity = Math.round(clampNumber(
      Math.max(((token.buys1h || 0) + (token.sells1h || 0)) / 60, buys60s + sells60s),
      8,
      5,
      90,
    ));
    const solVolume60s = Number(clampNumber(
      Math.max(
        (token.volume5m || 0) / Math.max(1, solPriceUsd) / 5,
        Number(walletSignal?.swapSolAmount || 0),
      ),
      0.5,
      0.1,
      25,
    ).toFixed(6));

    composite.set(token.mint, {
      symbol: token.symbol,
      buys60s,
      sells60s,
      buyRatio60s,
      velocity,
      isAccelerating: Boolean(
        token.priceChange5m >= 5 ||
        token.bagsSignal ||
        walletSignal?.executable
      ),
      solVolume60s,
      spikeOnly: false,
      lastSeenAt: now,
      isSynthetic: true,
      refinementOnly: true,
      syntheticSource: resolveSyntheticSource(token, walletSignal),
    });
  }

  for (const signal of walletSignals) {
    const mint = String(signal?.mint || '');
    if (!mint || composite.has(mint) || signal?.expired) continue;
    if (!signal?.executable && !signal?.sizeUp) continue;
    const buyRatio60s = signal?.sizeUp ? 0.9 : 0.82;
    const buys60s = signal?.sizeUp ? 12 : 8;
    const sells60s = signal?.sizeUp ? 1 : 2;
    composite.set(mint, {
      symbol: signal?.symbol || `${mint.slice(0, 8)}...`,
      buys60s,
      sells60s,
      buyRatio60s,
      velocity: signal?.sizeUp ? 16 : 10,
      isAccelerating: true,
      solVolume60s: Number(clampNumber(signal?.swapSolAmount, 0.75, 0.25, 250).toFixed(6)),
      spikeOnly: false,
      lastSeenAt: now,
      isSynthetic: true,
      refinementOnly: true,
      syntheticSource: 'composite-wallet',
    });
  }

  return Object.fromEntries(composite);
}

module.exports = {
  buildCompositeVelocityEntries,
};

export {};
