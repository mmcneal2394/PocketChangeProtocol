type MatureFallbackConfig = {
  enabled: boolean;
  candidatePoolSize: number;
  maxCandidatesPerPoll: number;
  minCandidateBuyRatio: number;
  minCandidateAgeSec: number;
  maxCandidateAgeSec: number;
  maxCandidateMomentum5mPct: number;
  maxCandidateMomentum1hPct: number;
  maxScoreMomentum5mPct: number;
  buyRatioThresholdScale: number;
  buyCountThresholdScale: number;
  deferWhenEligibleVelocityCountGte: number;
  rejectCooldownSeconds: number;
  hydrationMissRejectCooldownSeconds: number;
};

type MatureFallbackCandidateInput = {
  buyRatio?: number | null;
  tokenAgeSec?: number | null;
  priceChange5m?: number | null;
  priceChange1h?: number | null;
};

type MatureFallbackRejectCooldownInput = {
  hadVelocityHydrationMiss?: boolean | null;
};

type MatureFallbackScoringInput = {
  volume1hUsd?: number | null;
  liquidityUsd?: number | null;
  buyRatio?: number | null;
  tokenAgeSec?: number | null;
  priceChange5m?: number | null;
};

type MatureFallbackDeferralInput = {
  eligibleVelocityCount?: number | null;
};

export function normalizeMatureFallbackConfig(input: Partial<MatureFallbackConfig> | null | undefined): MatureFallbackConfig {
  return {
    enabled: input?.enabled !== false,
    candidatePoolSize: Math.max(1, Math.min(24, Number(input?.candidatePoolSize || 8))),
    maxCandidatesPerPoll: Math.max(1, Math.min(5, Number(input?.maxCandidatesPerPoll || 2))),
    minCandidateBuyRatio: Math.max(1, Math.min(5, Number(input?.minCandidateBuyRatio || 1.7))),
    minCandidateAgeSec: Math.max(60, Math.min(7 * 24 * 60 * 60, Number(input?.minCandidateAgeSec || 15 * 60))),
    maxCandidateAgeSec: Math.max(5 * 60, Math.min(7 * 24 * 60 * 60, Number(input?.maxCandidateAgeSec || 6 * 60 * 60))),
    maxCandidateMomentum5mPct: Math.max(3, Math.min(500, Number(input?.maxCandidateMomentum5mPct || 30))),
    maxCandidateMomentum1hPct: Math.max(10, Math.min(5000, Number(input?.maxCandidateMomentum1hPct || 180))),
    maxScoreMomentum5mPct: Math.max(1, Math.min(250, Number(input?.maxScoreMomentum5mPct || 12))),
    buyRatioThresholdScale: Math.max(0.5, Math.min(2, Number(input?.buyRatioThresholdScale || 1.0))),
    buyCountThresholdScale: Math.max(0.5, Math.min(2, Number(input?.buyCountThresholdScale || 1.0))),
    deferWhenEligibleVelocityCountGte: Math.max(0, Math.min(20, Number(input?.deferWhenEligibleVelocityCountGte || 1))),
    rejectCooldownSeconds: Math.max(30, Math.min(3600, Number(input?.rejectCooldownSeconds || 300))),
    hydrationMissRejectCooldownSeconds: Math.max(
      30,
      Math.min(3600, Number(input?.hydrationMissRejectCooldownSeconds || 420)),
    ),
  };
}

export function shouldAllowMatureFallbackCandidate(
  candidate: MatureFallbackCandidateInput,
  config: MatureFallbackConfig,
): boolean {
  if (!config.enabled) return false;
  const buyRatio = Number(candidate.buyRatio || 0);
  const tokenAgeSec = Number(candidate.tokenAgeSec || 0);
  const priceChange5m = Number(candidate.priceChange5m || 0);
  const priceChange1h = Number(candidate.priceChange1h || 0);
  if (!Number.isFinite(tokenAgeSec)) return false;
  if (tokenAgeSec < config.minCandidateAgeSec || tokenAgeSec > config.maxCandidateAgeSec) return false;
  if (buyRatio < config.minCandidateBuyRatio) return false;
  if (priceChange5m > config.maxCandidateMomentum5mPct) return false;
  if (priceChange1h > config.maxCandidateMomentum1hPct) return false;
  return true;
}

export function getMatureFallbackRejectCooldownSec(
  input: MatureFallbackRejectCooldownInput,
  config: MatureFallbackConfig,
): number {
  return input.hadVelocityHydrationMiss
    ? config.hydrationMissRejectCooldownSeconds
    : config.rejectCooldownSeconds;
}

export function scoreMatureFallbackCandidate(
  candidate: MatureFallbackScoringInput,
  config: MatureFallbackConfig,
): number {
  const volume1hUsd = Math.max(0, Number(candidate.volume1hUsd || 0));
  const liquidityUsd = Math.max(0, Number(candidate.liquidityUsd || 0));
  const buyRatio = Math.max(1, Number(candidate.buyRatio || 1));
  const tokenAgeSec = Math.max(0, Number(candidate.tokenAgeSec || 0));
  const priceChange5m = Math.max(0, Number(candidate.priceChange5m || 0));

  const cappedMomentumPct = Math.min(priceChange5m, config.maxScoreMomentum5mPct);
  const momentumFactor = 1 + cappedMomentumPct / 100;
  const liquidityFactor = liquidityUsd > 0 ? Math.min(1.5, 1 + liquidityUsd / Math.max(volume1hUsd, 1) / 4) : 1;

  let ageWeight = 1;
  if (tokenAgeSec > 3 * 60 * 60) {
    ageWeight = 0.55;
  } else if (tokenAgeSec > 90 * 60) {
    ageWeight = 0.75;
  }

  return volume1hUsd * momentumFactor * buyRatio * liquidityFactor * ageWeight;
}

export function shouldDeferMatureFallback(
  input: MatureFallbackDeferralInput,
  config: MatureFallbackConfig,
): boolean {
  if (!config.enabled) return false;
  const eligibleVelocityCount = Math.max(0, Number(input?.eligibleVelocityCount || 0));
  return (
    config.deferWhenEligibleVelocityCountGte > 0 &&
    eligibleVelocityCount >= config.deferWhenEligibleVelocityCountGte
  );
}
