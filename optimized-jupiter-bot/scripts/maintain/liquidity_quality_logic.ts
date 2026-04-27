export interface LiquidityQualityInput {
  entryMode?: string;
  sourceLane?: string;
  liquidityUsd?: number;
  marketCapUsd?: number;
  fdvUsd?: number;
  volume1hUsd?: number;
  momentum5m?: number;
  minLiquidityUsd?: number;
  routeLive?: boolean | null;
  routeOutAmount?: number | string | null;
  walletConfirmed?: boolean;
  strongRecentFlowConfirmed?: boolean;
  allowUnconfirmedMicroProbe?: boolean;
  routeLiveFastTrack?: boolean;
  probeLikeEntry?: boolean;
}

export interface LiquidityQualityConfig {
  enabled?: boolean;
  minLiquidityUsd?: number;
  hardNoRouteCooldownSeconds?: number;
  lowLiquidityCooldownSeconds?: number;
  lowLiquidityRatioForHold?: number;
  missedRouteRankBoost?: number;
  fdvToLiquidityWarnRatio?: number;
  fdvToLiquidityPenaltyRatio?: number;
}

export interface LiquidityQualityDecision {
  enabled: boolean;
  score: number;
  grade: 'blocked' | 'thin' | 'probing' | 'healthy' | 'prime';
  shouldHold: boolean;
  shouldBlock: boolean;
  code: string;
  reason: string;
  cooldownSeconds: number;
  positionMultiplier: number;
  rankMultiplier: number;
  rankPenalty: number;
  metrics: {
    liquidityUsd: number;
    marketCapUsd: number;
    fdvUsd: number;
    volume1hUsd: number;
    minLiquidityUsd: number;
    liquidityRatio: number;
    fdvToLiquidityRatio: number | null;
    turnoverToLiquidityRatio: number | null;
    routeLive: boolean;
    walletConfirmed: boolean;
    strongRecentFlowConfirmed: boolean;
  };
}

const DEFAULT_CONFIG: Required<LiquidityQualityConfig> = {
  enabled: process.env.LIQUIDITY_QUALITY_ENABLED !== 'false',
  minLiquidityUsd: 25_000,
  hardNoRouteCooldownSeconds: 60,
  lowLiquidityCooldownSeconds: 180,
  lowLiquidityRatioForHold: 0.65,
  missedRouteRankBoost: 0.12,
  fdvToLiquidityWarnRatio: 35,
  fdvToLiquidityPenaltyRatio: 75,
};

function toFiniteNumber(value: any, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeString(value: any, fallback = 'unknown'): string {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || fallback;
}

function normalizeConfig(config?: LiquidityQualityConfig): Required<LiquidityQualityConfig> {
  return {
    ...DEFAULT_CONFIG,
    ...(config || {}),
  };
}

function resolveGrade(score: number, shouldHold: boolean, shouldBlock: boolean): LiquidityQualityDecision['grade'] {
  if (shouldBlock) return 'blocked';
  if (shouldHold) return 'thin';
  if (score >= 1.15) return 'prime';
  if (score >= 0.92) return 'healthy';
  return 'probing';
}

export function scoreLiquidityQuality(
  input: LiquidityQualityInput = {},
  options?: { config?: LiquidityQualityConfig },
): LiquidityQualityDecision {
  const config = normalizeConfig(options?.config);
  const liquidityUsd = Math.max(0, toFiniteNumber(input.liquidityUsd, 0));
  const marketCapUsd = Math.max(0, toFiniteNumber(input.marketCapUsd, 0));
  const fdvUsd = Math.max(0, toFiniteNumber(input.fdvUsd || input.marketCapUsd, 0));
  const volume1hUsd = Math.max(0, toFiniteNumber(input.volume1hUsd, 0));
  const minLiquidityUsd = Math.max(1_000, toFiniteNumber(input.minLiquidityUsd, config.minLiquidityUsd));
  const routeLive = input.routeLive === true || toFiniteNumber(input.routeOutAmount, 0) > 0;
  const walletConfirmed = input.walletConfirmed === true;
  const strongRecentFlowConfirmed = input.strongRecentFlowConfirmed === true;
  const liquidityRatio = liquidityUsd / minLiquidityUsd;
  const fdvToLiquidityRatio = liquidityUsd > 0 && fdvUsd > 0 ? fdvUsd / liquidityUsd : null;
  const turnoverToLiquidityRatio = liquidityUsd > 0 && volume1hUsd > 0 ? volume1hUsd / liquidityUsd : null;
  const sourceLane = normalizeString(input.sourceLane || input.entryMode, 'unknown');
  const isProbeLike =
    input.probeLikeEntry === true ||
    input.entryMode === 'micro-scout' ||
    sourceLane.includes('velocity') ||
    sourceLane.includes('micro');

  let score = clamp(0.18 + Math.min(1.1, liquidityRatio) * 0.72, 0.05, 1.05);
  if (liquidityRatio >= 1.4) score += 0.10;
  if (routeLive) score += 0.18 + config.missedRouteRankBoost;
  if (walletConfirmed) score += 0.10;
  if (strongRecentFlowConfirmed) score += 0.10;
  if (turnoverToLiquidityRatio !== null && turnoverToLiquidityRatio >= 2.5) score += 0.07;
  if (toFiniteNumber(input.momentum5m, 0) >= 8) score += 0.05;
  if (fdvToLiquidityRatio !== null && fdvToLiquidityRatio >= config.fdvToLiquidityWarnRatio) {
    const severity = clamp(
      (fdvToLiquidityRatio - config.fdvToLiquidityWarnRatio) /
        Math.max(1, config.fdvToLiquidityPenaltyRatio - config.fdvToLiquidityWarnRatio),
      0,
      1.5,
    );
    score -= severity * 0.22;
  }
  score = clamp(score, 0.02, 1.35);

  let shouldHold = false;
  let shouldBlock = false;
  let code = 'liquidity_quality_ok';
  let reason = 'liquidity/routability quality is acceptable';
  let cooldownSeconds = 0;

  if (config.enabled && liquidityUsd <= 0 && !routeLive) {
    shouldHold = true;
    code = 'liquidity_quality_no_route';
    reason = 'no executable Dex liquidity and no Jupiter route confirmation';
    cooldownSeconds = config.hardNoRouteCooldownSeconds;
  } else if (config.enabled && liquidityRatio < config.lowLiquidityRatioForHold) {
    const confirmedByRouteAndFlow =
      routeLive &&
      (
        walletConfirmed ||
        strongRecentFlowConfirmed ||
        input.routeLiveFastTrack === true ||
        input.allowUnconfirmedMicroProbe === true
      );
    if (!confirmedByRouteAndFlow) {
      shouldHold = true;
      code = routeLive ? 'liquidity_quality_route_thin' : 'liquidity_quality_thin_pool';
      reason = routeLive
        ? 'route exists but pool liquidity is still below executable quality'
        : 'pool liquidity is below executable quality and no route/flow confirmation offset it';
      cooldownSeconds = config.lowLiquidityCooldownSeconds;
    }
  }

  if (
    config.enabled &&
    !shouldHold &&
    fdvToLiquidityRatio !== null &&
    fdvToLiquidityRatio >= config.fdvToLiquidityPenaltyRatio &&
    !routeLive &&
    !walletConfirmed &&
    !strongRecentFlowConfirmed
  ) {
    shouldHold = true;
    code = 'liquidity_quality_fdv_thin_pool';
    reason = 'valuation is too high relative to live liquidity without route or wallet confirmation';
    cooldownSeconds = config.lowLiquidityCooldownSeconds;
  }

  if (!config.enabled) {
    shouldHold = false;
    shouldBlock = false;
    code = 'liquidity_quality_disabled';
    reason = 'liquidity quality scoring disabled';
    cooldownSeconds = 0;
  }

  const grade = resolveGrade(score, shouldHold, shouldBlock);
  const rankPenalty = shouldHold || shouldBlock
    ? 0.000002
    : fdvToLiquidityRatio !== null && fdvToLiquidityRatio >= config.fdvToLiquidityWarnRatio
      ? 0.0000004
      : 0;
  const rankMultiplier = shouldBlock
    ? 0.05
    : shouldHold
      ? 0.18
      : clamp(0.62 + score * 0.42, 0.45, 1.22);
  const positionMultiplier = shouldBlock || shouldHold
    ? 0
    : clamp(0.58 + score * 0.42, isProbeLike ? 0.42 : 0.55, 1.12);

  return {
    enabled: config.enabled,
    score: Number(score.toFixed(6)),
    grade,
    shouldHold,
    shouldBlock,
    code,
    reason,
    cooldownSeconds,
    positionMultiplier: Number(positionMultiplier.toFixed(6)),
    rankMultiplier: Number(rankMultiplier.toFixed(6)),
    rankPenalty: Number(rankPenalty.toFixed(9)),
    metrics: {
      liquidityUsd: Number(liquidityUsd.toFixed(6)),
      marketCapUsd: Number(marketCapUsd.toFixed(6)),
      fdvUsd: Number(fdvUsd.toFixed(6)),
      volume1hUsd: Number(volume1hUsd.toFixed(6)),
      minLiquidityUsd: Number(minLiquidityUsd.toFixed(6)),
      liquidityRatio: Number(liquidityRatio.toFixed(6)),
      fdvToLiquidityRatio: fdvToLiquidityRatio === null ? null : Number(fdvToLiquidityRatio.toFixed(6)),
      turnoverToLiquidityRatio: turnoverToLiquidityRatio === null ? null : Number(turnoverToLiquidityRatio.toFixed(6)),
      routeLive,
      walletConfirmed,
      strongRecentFlowConfirmed,
    },
  };
}

export function resolveLiquidityGovernedRankScore(
  rankScore: number,
  decision?: Partial<LiquidityQualityDecision> | null,
): number {
  const base = toFiniteNumber(rankScore, 0);
  if (!decision || decision.enabled === false) return base;
  const rankMultiplier = clamp(toFiniteNumber(decision.rankMultiplier, 1), 0.01, 2);
  const rankPenalty = Math.max(0, toFiniteNumber(decision.rankPenalty, 0));
  if (base >= 0) {
    return Number((base * rankMultiplier - rankPenalty).toFixed(12));
  }
  return Number((base / Math.max(0.01, rankMultiplier) - rankPenalty).toFixed(12));
}

module.exports = {
  scoreLiquidityQuality,
  resolveLiquidityGovernedRankScore,
};
