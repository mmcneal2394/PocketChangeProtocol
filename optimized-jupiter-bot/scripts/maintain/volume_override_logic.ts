type MaybeNumber = number | null | undefined;

function toFiniteNumber(value: MaybeNumber, fallback = 0): number {
  const numeric = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(numeric) ? numeric : fallback;
}

interface VelocityVolumeOverrideInput {
  tokenAgeSec?: MaybeNumber;
  momentum5m?: MaybeNumber;
  momentum1m?: MaybeNumber;
  poolLiquidityUsd?: MaybeNumber;
  volume1hUsd?: MaybeNumber;
  normalLaneMinVolume1hUsd?: MaybeNumber;
  buys60s?: MaybeNumber;
  buyRatio60s?: MaybeNumber;
  velocity?: MaybeNumber;
  solVolume60s?: MaybeNumber;
  continuationApproved?: boolean;
}

function shouldAllowVelocityVolumeOverride(input: VelocityVolumeOverrideInput): boolean {
  const tokenAgeSec = Math.max(0, toFiniteNumber(input.tokenAgeSec, 0));
  const momentum5m = toFiniteNumber(input.momentum5m, 0);
  const momentum1m = toFiniteNumber(input.momentum1m, 0);
  const poolLiquidityUsd = Math.max(0, toFiniteNumber(input.poolLiquidityUsd, 0));
  const volume1hUsd = Math.max(0, toFiniteNumber(input.volume1hUsd, 0));
  const normalLaneMinVolume1hUsd = Math.max(0, toFiniteNumber(input.normalLaneMinVolume1hUsd, 0));
  const buys60s = Math.max(0, toFiniteNumber(input.buys60s, 0));
  const buyRatio60s = Math.max(0, toFiniteNumber(input.buyRatio60s, 0));
  const velocity = Math.max(0, toFiniteNumber(input.velocity, 0));
  const solVolume60s = Math.max(0, toFiniteNumber(input.solVolume60s, 0));
  const continuationApproved = Boolean(input.continuationApproved);

  const ageOk = tokenAgeSec === 0 || tokenAgeSec <= 15 * 60;
  const liquidityOk = poolLiquidityUsd >= 5000;
  const flowOk = buys60s >= 8 && buyRatio60s >= 0.85 && (solVolume60s >= 3 || velocity >= 10);
  const momentumOk = momentum5m >= 5;
  const nearFloorVolumeOk =
    normalLaneMinVolume1hUsd <= 0 || volume1hUsd >= normalLaneMinVolume1hUsd * 0.8;
  const strongerFlowOk = buys60s >= 12 && buyRatio60s >= 0.88 && (solVolume60s >= 5 || velocity >= 14);
  const gmgnBurstFlowOk = buys60s >= 9 && buyRatio60s >= 0.9 && velocity >= 10 && solVolume60s >= 2.2;
  const continuationOk =
    continuationApproved &&
    momentum5m >= -1 &&
    nearFloorVolumeOk &&
    (momentum1m > 0 || strongerFlowOk || gmgnBurstFlowOk);

  return ageOk && liquidityOk && flowOk && (momentumOk || continuationOk);
}

module.exports = {
  shouldAllowVelocityVolumeOverride,
};

export {};
