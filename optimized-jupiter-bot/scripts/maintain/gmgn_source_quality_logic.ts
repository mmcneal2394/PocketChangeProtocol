type MaybeNumber = number | null | undefined;

type EvaluateGmgnSourceQualityInput = {
  source?: string | null;
  priceChange5m?: MaybeNumber;
  priceChange1h?: MaybeNumber;
  volume5mUsd?: MaybeNumber;
  holders?: MaybeNumber;
  smartMoney?: MaybeNumber;
  pairCreatedAt?: MaybeNumber;
  now?: MaybeNumber;
  bagsSignal?: boolean | null;
  walletExecutable?: boolean | null;
};

function toFiniteNumber(value: MaybeNumber, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toOptionalAgeSeconds(pairCreatedAt: MaybeNumber, now: MaybeNumber): number | null {
  const createdAt = Number(pairCreatedAt);
  const nowTs = Number(now);
  if (!Number.isFinite(createdAt) || createdAt <= 0 || !Number.isFinite(nowTs) || nowTs <= 0) {
    return null;
  }

  const createdAtMs = createdAt > 1e12 ? createdAt : createdAt * 1000;
  const ageMs = nowTs - createdAtMs;
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  return ageMs / 1000;
}

export function evaluateGmgnSourceQuality(input: EvaluateGmgnSourceQualityInput) {
  const source = String(input.source || '').toLowerCase();
  const isGmgnSource = source.includes('gmgn');
  const bagsSignal = input.bagsSignal === true;
  const walletExecutable = input.walletExecutable === true;

  if (!isGmgnSource || bagsSignal || walletExecutable) {
    return {
      include: true,
      code: null,
      reason: null,
      metrics: null,
    };
  }

  const priceChange5m = toFiniteNumber(input.priceChange5m, 0);
  const priceChange1h = toFiniteNumber(input.priceChange1h, 0);
  const volume5mUsd = Math.max(0, toFiniteNumber(input.volume5mUsd, 0));
  const holders = Math.max(0, Math.round(toFiniteNumber(input.holders, 0)));
  const smartMoney = Math.max(0, toFiniteNumber(input.smartMoney, 0));
  const tokenAgeSec = toOptionalAgeSeconds(input.pairCreatedAt, input.now);

  const flat5m = Math.abs(priceChange5m) < 1;
  const flat1h = Math.abs(priceChange1h) <= 5;
  const lowVolume5m = volume5mUsd < 5_000;
  const lowHolderSupport = holders > 0 && holders < 80;
  const noSmartMoneySupport = smartMoney < 1;
  const staleEnough = tokenAgeSec === null || tokenAgeSec >= 10 * 60;

  if (flat5m && lowVolume5m) {
    return {
      include: false,
      code: 'gmgn_plateau_low_volume',
      reason: 'gmgn source is flat on 5m and still lacks fresh turnover',
      metrics: { priceChange5m, priceChange1h, volume5mUsd, holders, smartMoney, tokenAgeSec },
    };
  }

  if (flat5m && flat1h && noSmartMoneySupport && staleEnough) {
    return {
      include: false,
      code: 'gmgn_plateau_no_support',
      reason: 'gmgn source is flat across 5m/1h with no smart-money confirmation',
      metrics: { priceChange5m, priceChange1h, volume5mUsd, holders, smartMoney, tokenAgeSec },
    };
  }

  if (flat5m && lowHolderSupport && noSmartMoneySupport && staleEnough) {
    return {
      include: false,
      code: 'gmgn_low_holder_support',
      reason: 'gmgn source is flat and lacks holder breadth or smart-money support',
      metrics: { priceChange5m, priceChange1h, volume5mUsd, holders, smartMoney, tokenAgeSec },
    };
  }

  return {
    include: true,
    code: null,
    reason: null,
    metrics: { priceChange5m, priceChange1h, volume5mUsd, holders, smartMoney, tokenAgeSec },
  };
}
