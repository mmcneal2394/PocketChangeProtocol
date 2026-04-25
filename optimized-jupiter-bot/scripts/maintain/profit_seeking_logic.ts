function toFiniteNumber(value: any, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundValue(value: number, digits = 6): number {
  return Number((Number.isFinite(value) ? value : 0).toFixed(digits));
}

export const PROFIT_SEEKING_WIN_MULTIPLIER = 100;
export const PROFIT_SEEKING_LOSS_MULTIPLIER = 200;

export function calculateProfitSeekingScore(
  pnlSol: number,
  winMultiplier = PROFIT_SEEKING_WIN_MULTIPLIER,
  lossMultiplier = PROFIT_SEEKING_LOSS_MULTIPLIER,
): number {
  const pnl = toFiniteNumber(pnlSol, 0);
  if (pnl > 0) return pnl * pnl * toFiniteNumber(winMultiplier, PROFIT_SEEKING_WIN_MULTIPLIER);
  if (pnl < 0) {
    const magnitude = Math.abs(pnl);
    return -(magnitude * magnitude * toFiniteNumber(lossMultiplier, PROFIT_SEEKING_LOSS_MULTIPLIER));
  }
  return 0;
}

export function computeProfitSeekingRatio(positiveScore: number, negativeScoreAbs: number): number {
  const positive = Math.max(0, toFiniteNumber(positiveScore, 0));
  const negative = Math.max(0, toFiniteNumber(negativeScoreAbs, 0));
  if (negative <= 0) return positive > 0 ? 100 : 0;
  return positive / negative;
}

export function summarizeProfitSeekingScores(
  pnlValues: Array<number | string | null | undefined>,
  winMultiplier = PROFIT_SEEKING_WIN_MULTIPLIER,
  lossMultiplier = PROFIT_SEEKING_LOSS_MULTIPLIER,
) {
  const pnls = Array.isArray(pnlValues) ? pnlValues : [];
  let positiveScore = 0;
  let negativeScoreAbs = 0;
  let totalScore = 0;

  for (const value of pnls) {
    const score = calculateProfitSeekingScore(toFiniteNumber(value, 0), winMultiplier, lossMultiplier);
    totalScore += score;
    if (score > 0) positiveScore += score;
    if (score < 0) negativeScoreAbs += Math.abs(score);
  }

  const profitSeekingRatio = computeProfitSeekingRatio(positiveScore, negativeScoreAbs);

  return {
    positiveScore: roundValue(positiveScore),
    negativeScoreAbs: roundValue(negativeScoreAbs),
    totalScore: roundValue(totalScore),
    profitSeekingRatio: roundValue(profitSeekingRatio),
  };
}

export function deriveKellyRewardAsymmetryFactor(args: {
  profitSeekingRatio?: number | null;
  totalProfitSeekingScore?: number | null;
  tradeCount?: number | null;
}) {
  const tradeCount = Math.max(0, toFiniteNumber(args?.tradeCount, 0));
  if (tradeCount <= 0) return 0;

  const ratio = Math.max(0, toFiniteNumber(args?.profitSeekingRatio, 0));
  const totalScore = toFiniteNumber(args?.totalProfitSeekingScore, 0);
  const sampleWeight = clamp(tradeCount / 20, 0, 1);
  const ratioComponent = clamp((Math.min(ratio, 4) - 1) * 0.18, -0.18, 0.36);
  const scoreComponent = clamp(totalScore / 25, -0.18, 0.18);

  return roundValue(clamp((ratioComponent + scoreComponent) * sampleWeight, -0.25, 0.35));
}

module.exports = {
  PROFIT_SEEKING_WIN_MULTIPLIER,
  PROFIT_SEEKING_LOSS_MULTIPLIER,
  calculateProfitSeekingScore,
  computeProfitSeekingRatio,
  summarizeProfitSeekingScores,
  deriveKellyRewardAsymmetryFactor,
};
