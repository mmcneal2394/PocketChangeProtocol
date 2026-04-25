export interface MicroScoutProbeConfig {
  minRawBuys60s?: number;
  minRawBuyRatio60s?: number;
  minRawSolVolume60s?: number;
  minVelocity?: number;
}

export interface MicroScoutProbeInput {
  buys60s?: number;
  sells60s?: number;
  buyRatio60s?: number;
  velocity?: number;
  solVolume60s?: number;
}

export interface MicroScoutProbeDecision {
  shouldScout: boolean;
  rawVelocityException: boolean;
  whaleFlowException: boolean;
  limitingReason: string;
  thresholds: {
    buys60s: number;
    buyRatio60s: number;
    solVolume60s: number;
    velocity: number;
  };
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function evaluateNoDexMicroScoutProbe(
  input: MicroScoutProbeInput,
  rawConfig: MicroScoutProbeConfig = {},
): MicroScoutProbeDecision {
  const thresholds = {
    buys60s: Math.max(1, Math.round(toFiniteNumber(rawConfig.minRawBuys60s, 8))),
    buyRatio60s: Math.min(0.99, Math.max(0.5, toFiniteNumber(rawConfig.minRawBuyRatio60s, 0.7))),
    solVolume60s: Math.max(0.1, toFiniteNumber(rawConfig.minRawSolVolume60s, 1)),
    velocity: Math.max(1, toFiniteNumber(rawConfig.minVelocity, 8)),
  };

  const buys60s = Math.max(0, toFiniteNumber(input.buys60s, 0));
  const sells60s = Math.max(0, toFiniteNumber(input.sells60s, 0));
  const buyRatio60s = Math.max(0, toFiniteNumber(input.buyRatio60s, 0));
  const velocity = Math.max(0, toFiniteNumber(input.velocity, buys60s + sells60s));
  const solVolume60s = Math.max(0, toFiniteNumber(input.solVolume60s, 0));

  const rawVelocityException =
    buys60s >= thresholds.buys60s &&
    buyRatio60s >= thresholds.buyRatio60s &&
    solVolume60s >= thresholds.solVolume60s &&
    velocity >= thresholds.velocity;

  const whaleFlowException =
    solVolume60s >= Math.max(thresholds.solVolume60s * 2.5, 3) &&
    buys60s >= Math.max(6, thresholds.buys60s - 1) &&
    buyRatio60s >= Math.max(0.65, thresholds.buyRatio60s - 0.05) &&
    velocity >= Math.max(6, thresholds.velocity - 1);

  let limitingReason = 'qualified';
  if (!rawVelocityException && !whaleFlowException) {
    if (buys60s < thresholds.buys60s) limitingReason = 'buys_below_floor';
    else if (buyRatio60s < thresholds.buyRatio60s) limitingReason = 'buy_ratio_below_floor';
    else if (solVolume60s < thresholds.solVolume60s) limitingReason = 'sol_volume_below_floor';
    else if (velocity < thresholds.velocity) limitingReason = 'velocity_below_floor';
    else limitingReason = 'whale_flow_not_strong_enough';
  } else if (!rawVelocityException && whaleFlowException) {
    limitingReason = 'whale_flow_exception';
  } else if (rawVelocityException) {
    limitingReason = 'raw_velocity_exception';
  }

  return {
    shouldScout: rawVelocityException || whaleFlowException,
    rawVelocityException,
    whaleFlowException,
    limitingReason,
    thresholds,
  };
}
