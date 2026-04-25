type ResolveTrailingStopFloorPctInput = {
  peakPnlPct?: number | null;
  isLastStand?: boolean | null;
  trailingActivationPct?: number | null;
  trailingStopPct?: number | null;
};

type ResolvePartialTakeProfitPlanInput = {
  pnlPct?: number | null;
  partialProfitStage?: number | null;
  isLastStand?: boolean | null;
  disablePartialTakeProfit?: boolean | null;
};

export const PARTIAL_TAKE_PROFIT_STAGES = [
  { stage: 1, thresholdPct: 8, cumulativeSoldFraction: 0.30, reasonCode: 'TP_HIT_STAGE1' },
  { stage: 2, thresholdPct: 15, cumulativeSoldFraction: 0.60, reasonCode: 'TP_HIT_STAGE2' },
  { stage: 3, thresholdPct: 25, cumulativeSoldFraction: 0.80, reasonCode: 'TP_HIT_STAGE3' },
  { stage: 4, thresholdPct: 50, cumulativeSoldFraction: 0.90, reasonCode: 'TP_HIT_STAGE4' },
] as const;

function getCumulativeSoldFractionForStage(stage: number) {
  const matchedStage = PARTIAL_TAKE_PROFIT_STAGES.find((item) => item.stage === stage);
  return matchedStage ? matchedStage.cumulativeSoldFraction : 0;
}

export function resolveTrailingStopFloorPct(input: ResolveTrailingStopFloorPctInput) {
  const peakPnlPct = Number(input.peakPnlPct || 0);

  if (input.isLastStand) {
    const activationPct = Number(input.trailingActivationPct ?? 8);
    const trailPct = Number(input.trailingStopPct ?? 12);
    if (peakPnlPct < activationPct) return null;
    return peakPnlPct - trailPct;
  }

  if (peakPnlPct >= 50) return peakPnlPct - 15;
  if (peakPnlPct >= 20) return peakPnlPct - 5;
  if (peakPnlPct >= 12) return peakPnlPct - 2;
  return null;
}

export function resolvePartialTakeProfitPlan(input: ResolvePartialTakeProfitPlanInput) {
  if (input.isLastStand || input.disablePartialTakeProfit) {
    return null;
  }

  const pnlPct = Number(input.pnlPct || 0);
  const currentStage = Math.max(0, Math.min(PARTIAL_TAKE_PROFIT_STAGES.length, Number(input.partialProfitStage || 0)));

  let targetStage = currentStage;
  for (const stage of PARTIAL_TAKE_PROFIT_STAGES) {
    if (pnlPct >= stage.thresholdPct) {
      targetStage = stage.stage;
    }
  }

  if (targetStage <= currentStage) {
    return null;
  }

  const currentCumulativeSoldFraction = getCumulativeSoldFractionForStage(currentStage);
  const targetStageConfig = PARTIAL_TAKE_PROFIT_STAGES.find((item) => item.stage === targetStage);
  if (!targetStageConfig) {
    return null;
  }

  const targetCumulativeSoldFraction = targetStageConfig.cumulativeSoldFraction;
  const remainingFractionBeforeSale = 1 - currentCumulativeSoldFraction;
  if (remainingFractionBeforeSale <= 0) {
    return null;
  }

  const sellFractionOfCurrent = (targetCumulativeSoldFraction - currentCumulativeSoldFraction) / remainingFractionBeforeSale;
  if (!(sellFractionOfCurrent > 0)) {
    return null;
  }

  return {
    currentStage,
    targetStage,
    reasonCode: targetStageConfig.reasonCode,
    thresholdPct: targetStageConfig.thresholdPct,
    cumulativeSoldFraction: targetCumulativeSoldFraction,
    sellFractionOfCurrent: Math.min(1, Math.max(0, sellFractionOfCurrent)),
  };
}
