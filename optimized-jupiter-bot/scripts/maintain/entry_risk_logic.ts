type MaybeNumber = number | null | undefined;

export interface EntryRiskInput {
  duplicateImageRisk?: string | null;
  imageDupCount?: MaybeNumber;
  isJitterBundle?: boolean | null;
  holderCount?: MaybeNumber;
  top10Pct?: MaybeNumber;
  bullishSignals?: MaybeNumber;
  rugCheckWarnings?: string[] | null;
}

export interface EntryRiskDecision {
  riskScore: number;
  riskBand: 'low' | 'moderate' | 'elevated' | 'extreme';
  reject: boolean;
  probeMode: boolean;
  positionMultiplier: number;
  reasons: string[];
}

function clampNumber(value: MaybeNumber, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function duplicateImageScore(risk: string | null | undefined, imageDupCount?: MaybeNumber): number {
  const normalizedRisk = String(risk || '').trim().toLowerCase();
  if (normalizedRisk === 'high') return 55;
  if (normalizedRisk === 'medium') return 35;
  if (normalizedRisk === 'low') return 15;
  const dupCount = clampNumber(imageDupCount, 0, 0, 100);
  if (dupCount >= 4) return 55;
  if (dupCount >= 2) return 35;
  if (dupCount >= 1) return 15;
  return 0;
}

function holderShapeScore(top10Pct: number, holderCount: number): number {
  let score = 0;
  if (top10Pct >= 65) score += 55;
  else if (top10Pct >= 50) score += 40;
  else if (top10Pct >= 40) score += 25;
  else if (top10Pct >= 30) score += 12;

  if (holderCount <= 5) score += 15;
  else if (holderCount <= 20) score += 8;

  return score;
}

function rugCheckSoftScore(warnings: string[] | null | undefined): { score: number; reasons: string[] } {
  const normalizedWarnings = Array.isArray(warnings)
    ? warnings.map((warning) => String(warning || '').trim().toLowerCase()).filter(Boolean)
    : [];
  const reasons: string[] = [];
  let score = 0;

  if (normalizedWarnings.some((warning) => warning.includes('large amount of lp unlocked'))) {
    score += 20;
    reasons.push('rugcheck lp unlock risk');
  }

  if (normalizedWarnings.some((warning) => warning.includes('low amount of lp providers'))) {
    score += 12;
    reasons.push('rugcheck low lp provider count');
  }

  return { score, reasons };
}

export function evaluateEntryRisk(input: EntryRiskInput): EntryRiskDecision {
  const top10Pct = clampNumber(input.top10Pct, 0, 0, 100);
  const holderCount = Math.round(clampNumber(input.holderCount, 0, 0, 1_000_000));
  const bullishSignals = Math.round(clampNumber(input.bullishSignals, 0, 0, 20));
  const reasons: string[] = [];

  const duplicateScore = duplicateImageScore(input.duplicateImageRisk, input.imageDupCount);
  if (duplicateScore > 0) {
    reasons.push(`gmgn duplicate image ${String(input.duplicateImageRisk || input.imageDupCount)}`);
  }

  const jitterScore = input.isJitterBundle ? 20 : 0;
  if (jitterScore > 0) reasons.push('jitter bundle holder shape');

  const holderScore = holderShapeScore(top10Pct, holderCount);
  if (holderScore > 0) {
    reasons.push(`holder concentration top10 ${top10Pct.toFixed(0)}% / holders ${holderCount}`);
  }

  const rugCheckSoft = rugCheckSoftScore(input.rugCheckWarnings);
  if (rugCheckSoft.reasons.length > 0) {
    reasons.push(...rugCheckSoft.reasons);
  }

  const riskScore = Math.min(100, duplicateScore + jitterScore + holderScore + rugCheckSoft.score);
  const reject = riskScore > 75;
  const probeMode = !reject && riskScore > 40 && bullishSignals >= 1;
  const rawMultiplier = Math.max(0.15, 1 - riskScore / 100);
  const positionMultiplier = reject ? 0 : probeMode ? 0.3 : rawMultiplier;
  const riskBand =
    riskScore > 75 ? 'extreme' :
    riskScore > 40 ? 'elevated' :
    riskScore > 20 ? 'moderate' :
    'low';

  return {
    riskScore,
    riskBand,
    reject,
    probeMode,
    positionMultiplier,
    reasons,
  };
}

module.exports = {
  evaluateEntryRisk,
};
