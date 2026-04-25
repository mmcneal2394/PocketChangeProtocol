type EntryMode = 'normal' | 'last-stand' | 'micro-scout';

type FdvLiquidityGuardConfig = {
  enabled: boolean;
  warnFdvToLiquidityRatio: number;
  normalBlockFdvToLiquidityRatio: number;
  microScoutBlockFdvToLiquidityRatio: number;
  lastStandBlockFdvToLiquidityRatio: number;
  matureFallbackBlockFdvToLiquidityRatio: number;
  minLiquidityUsdToApply: number;
  minValuationUsdToApply: number;
  cooldownWarnSeconds: number;
  cooldownBlockSeconds: number;
};

type EvaluateFdvLiquidityGuardInput = {
  entryMode?: EntryMode | null;
  sourceLane?: string | null;
  valuationUsd?: number | null;
  liquidityUsd?: number | null;
};

function toFiniteNumber(value: any, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function resolveBlockRatio(input: EvaluateFdvLiquidityGuardInput, config: FdvLiquidityGuardConfig): number {
  if (input.sourceLane === 'mature-fallback') {
    return config.matureFallbackBlockFdvToLiquidityRatio;
  }
  if (input.entryMode === 'micro-scout') {
    return config.microScoutBlockFdvToLiquidityRatio;
  }
  if (input.entryMode === 'last-stand') {
    return config.lastStandBlockFdvToLiquidityRatio;
  }
  return config.normalBlockFdvToLiquidityRatio;
}

export function evaluateFdvLiquidityGuard(
  input: EvaluateFdvLiquidityGuardInput,
  rawConfig: Partial<FdvLiquidityGuardConfig> | null | undefined,
) {
  const config: FdvLiquidityGuardConfig = {
    enabled: rawConfig?.enabled !== false,
    warnFdvToLiquidityRatio: Math.max(1, toFiniteNumber(rawConfig?.warnFdvToLiquidityRatio, 12)),
    normalBlockFdvToLiquidityRatio: Math.max(1, toFiniteNumber(rawConfig?.normalBlockFdvToLiquidityRatio, 18)),
    microScoutBlockFdvToLiquidityRatio: Math.max(1, toFiniteNumber(rawConfig?.microScoutBlockFdvToLiquidityRatio, 28)),
    lastStandBlockFdvToLiquidityRatio: Math.max(1, toFiniteNumber(rawConfig?.lastStandBlockFdvToLiquidityRatio, 22)),
    matureFallbackBlockFdvToLiquidityRatio: Math.max(1, toFiniteNumber(rawConfig?.matureFallbackBlockFdvToLiquidityRatio, 16)),
    minLiquidityUsdToApply: Math.max(0, toFiniteNumber(rawConfig?.minLiquidityUsdToApply, 5000)),
    minValuationUsdToApply: Math.max(0, toFiniteNumber(rawConfig?.minValuationUsdToApply, 50000)),
    cooldownWarnSeconds: Math.max(10, Math.round(toFiniteNumber(rawConfig?.cooldownWarnSeconds, 180))),
    cooldownBlockSeconds: Math.max(30, Math.round(toFiniteNumber(rawConfig?.cooldownBlockSeconds, 900))),
  };

  const valuationUsd = Math.max(0, toFiniteNumber(input.valuationUsd, 0));
  const liquidityUsd = Math.max(0, toFiniteNumber(input.liquidityUsd, 0));
  const fdvToLiquidityRatio = liquidityUsd > 0 ? valuationUsd / liquidityUsd : Infinity;
  const liquidityToFdvRatio = valuationUsd > 0 ? liquidityUsd / valuationUsd : 0;
  const blockRatio = resolveBlockRatio(input, config);
  const applicable =
    config.enabled &&
    valuationUsd >= config.minValuationUsdToApply &&
    liquidityUsd >= config.minLiquidityUsdToApply;

  const shouldWarn = applicable && fdvToLiquidityRatio >= config.warnFdvToLiquidityRatio;
  const shouldBlock = applicable && fdvToLiquidityRatio >= blockRatio;

  return {
    shouldWarn,
    shouldBlock,
    cooldownSeconds: shouldBlock ? config.cooldownBlockSeconds : config.cooldownWarnSeconds,
    blockRatio,
    config,
    metrics: {
      valuationUsd,
      liquidityUsd,
      fdvToLiquidityRatio,
      liquidityToFdvRatio,
    },
  };
}

module.exports = {
  evaluateFdvLiquidityGuard,
};
