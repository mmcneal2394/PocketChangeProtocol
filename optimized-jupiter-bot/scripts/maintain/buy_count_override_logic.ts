type MaybeNumber = number | null | undefined;

function toFiniteNumber(value: MaybeNumber, fallback = 0): number {
  const numeric = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clampNumber(value: MaybeNumber, fallback: number, min: number, max: number): number {
  const numeric = toFiniteNumber(value, fallback);
  return Math.min(max, Math.max(min, numeric));
}

export interface BuyCountOverrideConfig {
  enabled: boolean;
  minBuys1hAbsolute: number;
  minBuys1hFractionOfReq: number;
  minBuys60s: number;
  minBuyRatio60s: number;
  minSolVolume60s: number;
  minVelocity: number;
  whaleFlowBuys60s: number;
  whaleFlowBuyRatio60s: number;
  whaleFlowSolVolume60s: number;
  maxTokenAgeSec: number;
}

export function normalizeBuyCountOverrideConfig(raw: any = {}): BuyCountOverrideConfig {
  return {
    enabled: raw.enabled !== false,
    minBuys1hAbsolute: Math.round(clampNumber(raw.minBuys1hAbsolute, 2, 1, 50)),
    minBuys1hFractionOfReq: clampNumber(raw.minBuys1hFractionOfReq, 0.25, 0.05, 1),
    minBuys60s: Math.round(clampNumber(raw.minBuys60s, 8, 3, 100)),
    minBuyRatio60s: clampNumber(raw.minBuyRatio60s, 0.8, 0.5, 1),
    minSolVolume60s: clampNumber(raw.minSolVolume60s, 3, 0.25, 100),
    minVelocity: clampNumber(raw.minVelocity, 10, 1, 200),
    whaleFlowBuys60s: Math.round(clampNumber(raw.whaleFlowBuys60s, 6, 3, 100)),
    whaleFlowBuyRatio60s: clampNumber(raw.whaleFlowBuyRatio60s, 0.9, 0.5, 1),
    whaleFlowSolVolume60s: clampNumber(raw.whaleFlowSolVolume60s, 8, 0.5, 200),
    maxTokenAgeSec: Math.round(clampNumber(raw.maxTokenAgeSec, 1200, 60, 86400)),
  };
}

export function shouldAllowBuyCountOverride(
  input: {
    buys1h?: MaybeNumber;
    reqBuys?: MaybeNumber;
    tokenAgeSec?: MaybeNumber;
    continuationApproved?: boolean | null;
    buys60s?: MaybeNumber;
    buyRatio60s?: MaybeNumber;
    velocity?: MaybeNumber;
    solVolume60s?: MaybeNumber;
  },
  config: BuyCountOverrideConfig,
): boolean {
  if (!config.enabled) return false;

  const buys1h = Math.max(0, toFiniteNumber(input.buys1h, 0));
  const reqBuys = Math.max(0, toFiniteNumber(input.reqBuys, 0));
  if (reqBuys <= 0 || buys1h >= reqBuys) return false;

  const buys60s = Math.max(0, toFiniteNumber(input.buys60s, 0));
  const buyRatio60s = Math.max(0, toFiniteNumber(input.buyRatio60s, 0));
  const velocity = Math.max(0, toFiniteNumber(input.velocity, 0));
  const solVolume60s = Math.max(0, toFiniteNumber(input.solVolume60s, 0));
  const tokenAgeSec = toFiniteNumber(input.tokenAgeSec, NaN);
  const freshEnough = !Number.isFinite(tokenAgeSec) || tokenAgeSec <= config.maxTokenAgeSec;
  const nearFloorHistory = buys1h >= Math.max(config.minBuys1hAbsolute, reqBuys * config.minBuys1hFractionOfReq);
  if (!nearFloorHistory) return false;

  const strongCurrentFlow =
    buys60s >= config.minBuys60s &&
    buyRatio60s >= config.minBuyRatio60s &&
    solVolume60s >= config.minSolVolume60s &&
    velocity >= config.minVelocity;
  const whaleFlow =
    buys60s >= config.whaleFlowBuys60s &&
    buyRatio60s >= config.whaleFlowBuyRatio60s &&
    solVolume60s >= config.whaleFlowSolVolume60s;

  if (whaleFlow) return true;
  if (input.continuationApproved && strongCurrentFlow) return true;
  return freshEnough && strongCurrentFlow;
}
