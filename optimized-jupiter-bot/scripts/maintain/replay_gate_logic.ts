function toFiniteNumber(value: any, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

type ReplayProfile = {
  active: boolean;
  filters: Record<string, any>;
  fitness: number;
  simulatedPnl: number;
  profitSeekingRatio: number;
  min5mChange: number;
  minVolume5m: number;
  minLiquidityUsd: number;
};

export function resolveReplayBackedStrategyProfile(rawParams: Record<string, any> | null | undefined): ReplayProfile {
  const params = (rawParams && typeof rawParams === 'object') ? rawParams : {};
  const filters = (params.recommended_filters && typeof params.recommended_filters === 'object')
    ? params.recommended_filters
    : params;
  const fitness = Math.max(
    toFiniteNumber(params.fitness, Number.NEGATIVE_INFINITY),
    toFiniteNumber(params.fitness_score, Number.NEGATIVE_INFINITY),
    toFiniteNumber(params.best_fitness, Number.NEGATIVE_INFINITY),
  );
  const simulatedPnl = Math.max(
    toFiniteNumber(params.simulated_pnl, Number.NEGATIVE_INFINITY),
    toFiniteNumber(params.total_pnl_sol, Number.NEGATIVE_INFINITY),
    toFiniteNumber(params.pnl_sol, Number.NEGATIVE_INFINITY),
  );
  const profitSeekingRatio = Math.max(
    toFiniteNumber(params.profit_seeking_ratio, Number.NEGATIVE_INFINITY),
    toFiniteNumber(params.profitSeekingRatio, Number.NEGATIVE_INFINITY),
    toFiniteNumber(params.simulated_psr, Number.NEGATIVE_INFINITY),
  );
  const min5mChange = Math.max(0, toFiniteNumber(filters.min_5m_change, 0));
  const minVolume5m = Math.max(0, toFiniteNumber(filters.min_volume_5m, 0));
  const minLiquidityUsd = Math.max(0, toFiniteNumber(filters.min_liquidity_usd, 0));
  const active =
    (Object.keys(filters).length > 0) &&
    (
      fitness > 0 ||
      simulatedPnl > 0.01 ||
      profitSeekingRatio >= 1.15
    );

  return {
    active,
    filters,
    fitness: Number.isFinite(fitness) ? fitness : 0,
    simulatedPnl: Number.isFinite(simulatedPnl) ? simulatedPnl : 0,
    profitSeekingRatio: Number.isFinite(profitSeekingRatio) ? profitSeekingRatio : 0,
    min5mChange,
    minVolume5m,
    minLiquidityUsd,
  };
}

export function evaluateReplayBackedRouteLiveOverride(args: {
  slopfestParams?: Record<string, any> | null;
  routeLive?: boolean;
  continuationReady?: boolean;
  missingMomentum1m?: boolean;
  priceChange5m?: number;
  liquidityUsd?: number;
  buys60s?: number;
  buyRatio60s?: number;
  velocity?: number;
  solVolume60s?: number;
  probeLikeFlowReady?: boolean;
}) {
  const profile = resolveReplayBackedStrategyProfile(args.slopfestParams);
  const priceChange5m = toFiniteNumber(args.priceChange5m, 0);
  const liquidityUsd = Math.max(0, toFiniteNumber(args.liquidityUsd, 0));
  const buys60s = Math.max(0, toFiniteNumber(args.buys60s, 0));
  const buyRatio60s = clamp(toFiniteNumber(args.buyRatio60s, 0), 0, 1);
  const velocity = Math.max(0, toFiniteNumber(args.velocity, 0));
  const solVolume60s = Math.max(0, toFiniteNumber(args.solVolume60s, 0));
  const replayMomentumFloor = Math.max(0, Math.min(5, profile.min5mChange));
  const strongFlow =
    buys60s >= 6 &&
    buyRatio60s >= 0.72 &&
    (velocity >= 6 || solVolume60s >= 0.9);
  const meetsReplayMomentum = priceChange5m >= replayMomentumFloor;
  const routeLiveSupported =
    profile.active &&
    args.routeLive === true &&
    args.probeLikeFlowReady === true &&
    strongFlow &&
    meetsReplayMomentum;
  const allowContinuationOverride =
    routeLiveSupported &&
    args.missingMomentum1m === true;
  const allowLowLiquidityColdStreakOverride =
    routeLiveSupported &&
    liquidityUsd > 0 &&
    liquidityUsd < 5000 &&
    (args.continuationReady === true || allowContinuationOverride);
  const reason =
    `replay-backed route-live flow matches the promoted profile ` +
    `(${priceChange5m.toFixed(1)}%/5m, ${buys60s} buys/60s, ratio ${buyRatio60s.toFixed(2)}, ${solVolume60s.toFixed(3)} SOL/60s)`;

  return {
    profile,
    strongFlow,
    meetsReplayMomentum,
    routeLiveSupported,
    allowContinuationOverride,
    allowLowLiquidityColdStreakOverride,
    reason,
  };
}

export function evaluateReplayBackedRecoveryProbe(args: {
  slopfestParams?: Record<string, any> | null;
  routeLive?: boolean;
  priceChange5m?: number;
  liquidityUsd?: number;
  buys60s?: number;
  buyRatio60s?: number;
  velocity?: number;
  solVolume60s?: number;
  probeLikeFlowReady?: boolean;
  openPositionCount?: number;
  consecutiveLosses?: number;
  lastProbeAtMs?: number;
  nowMs?: number;
}) {
  const profile = resolveReplayBackedStrategyProfile(args.slopfestParams);
  const nowMs = Math.max(0, toFiniteNumber(args.nowMs, Date.now()));
  const lastProbeAtMs = Math.max(0, toFiniteNumber(args.lastProbeAtMs, 0));
  const openPositionCount = Math.max(0, toFiniteNumber(args.openPositionCount, 0));
  const consecutiveLosses = Math.max(0, toFiniteNumber(args.consecutiveLosses, 0));
  const priceChange5m = toFiniteNumber(args.priceChange5m, 0);
  const liquidityUsd = Math.max(0, toFiniteNumber(args.liquidityUsd, 0));
  const buys60s = Math.max(0, toFiniteNumber(args.buys60s, 0));
  const buyRatio60s = clamp(toFiniteNumber(args.buyRatio60s, 0), 0, 1);
  const velocity = Math.max(0, toFiniteNumber(args.velocity, 0));
  const solVolume60s = Math.max(0, toFiniteNumber(args.solVolume60s, 0));
  const recoveryMomentumFloor = Math.max(0, profile.min5mChange - 1);
  const strongFlow =
    buys60s >= 5 &&
    buyRatio60s >= 0.68 &&
    (velocity >= 5 || solVolume60s >= 0.75);
  const meetsRecoveryMomentum = priceChange5m >= recoveryMomentumFloor;
  const routeLiveRecoveryShape =
    args.routeLive === true &&
    args.probeLikeFlowReady === true &&
    strongFlow &&
    meetsRecoveryMomentum &&
    liquidityUsd <= 5_000;
  let windowMs = 15 * 60_000;
  if (consecutiveLosses >= 8) windowMs = 45 * 60_000;
  else if (consecutiveLosses >= 6) windowMs = 20 * 60_000;
  else if (consecutiveLosses >= 4) windowMs = 15 * 60_000;
  const cooldownReady = (nowMs - lastProbeAtMs) >= windowMs;
  const allow =
    profile.active &&
    routeLiveRecoveryShape &&
    openPositionCount <= 0 &&
    consecutiveLosses >= 4 &&
    cooldownReady;

  return {
    profile,
    strongFlow,
    meetsRecoveryMomentum,
    routeLiveRecoveryShape,
    cooldownReady,
    windowMs,
    allow,
    reason:
      `empty-book recovery probe matches replay-backed route-live flow ` +
      `(${priceChange5m.toFixed(1)}%/5m, ${buys60s} buys/60s, ratio ${buyRatio60s.toFixed(2)}, ${solVolume60s.toFixed(3)} SOL/60s)`,
  };
}

module.exports = {
  resolveReplayBackedStrategyProfile,
  evaluateReplayBackedRouteLiveOverride,
  evaluateReplayBackedRecoveryProbe,
};
