export interface VelocitySelectionConfig {
  enabled: boolean;
  maxSoftRechecksPerPoll: number;
  softCooldownMaxTtlSeconds: number;
  softCooldownReasons: string[];
  maxSyntheticRefinementCandidatesPerPoll: number;
  minSoftRecheckBuys60s: number;
  minSoftRecheckSolVolume60s: number;
  minSoftRecheckVelocity: number;
  fallbackTiers: VelocityRecoveryTierConfig[];
}

export interface VelocityRecoveryTierConfig {
  label: string;
  minBuys60s: number;
  minBuyRatio60s: number;
  minSolVolume60s: number;
  maxCandidatesPerPoll: number;
}

export interface VelocityCandidateLike {
  mint?: string | null;
  buys60s?: number | null;
  buyRatio60s?: number | null;
  solVolume60s?: number | null;
  velocity?: number | null;
}

export interface VelocityCooldownStateLike {
  active: boolean;
  value?: string | null;
  ttlSeconds?: number | null;
}

export interface VelocityRecoverySelection {
  tier: VelocityRecoveryTierConfig | null;
  candidates: VelocityCandidateLike[];
}

export interface VelocityAssessmentBudget {
  underfilledBookActive: boolean;
  desiredEligibleCandidates: number;
  additionalCandidatesNeeded: number;
}

export interface VelocityAssessmentCandidateLike extends VelocityCandidateLike {
  isSynthetic?: boolean | null;
  refinementOnly?: boolean | null;
}

function finiteNumber(value: any, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function clampNumber(value: any, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeRecoveryTier(raw: any, fallback: VelocityRecoveryTierConfig): VelocityRecoveryTierConfig {
  return {
    label: String(raw?.label || fallback.label).trim() || fallback.label,
    minBuys60s: Math.round(clampNumber(raw?.minBuys60s, fallback.minBuys60s, 1, 500)),
    minBuyRatio60s: clampNumber(raw?.minBuyRatio60s, fallback.minBuyRatio60s, 0.01, 0.99),
    minSolVolume60s: clampNumber(raw?.minSolVolume60s, fallback.minSolVolume60s, 0.01, 500),
    maxCandidatesPerPoll: Math.round(clampNumber(raw?.maxCandidatesPerPoll, fallback.maxCandidatesPerPoll, 1, 120)),
  };
}

function asMintSet(values: Set<string> | string[] | undefined | null): Set<string> {
  if (values instanceof Set) return values;
  if (!Array.isArray(values)) return new Set();
  return new Set(values.map((value) => String(value || '').trim()).filter(Boolean));
}

export function normalizeVelocitySelectionConfig(raw: any): VelocitySelectionConfig {
  const reasons = Array.isArray(raw?.softCooldownReasons)
    ? raw.softCooldownReasons.map((value: any) => String(value || '').trim()).filter(Boolean)
    : ['MICRO_CONTINUATION', 'TERRAIN_PRECHECK', 'ZERO_LIQ'];
  const defaultFallbackTiers: VelocityRecoveryTierConfig[] = [
    { label: 'tier2', minBuys60s: 5, minBuyRatio60s: 0.65, minSolVolume60s: 0.5, maxCandidatesPerPoll: 12 },
    { label: 'tier3', minBuys60s: 3, minBuyRatio60s: 0.60, minSolVolume60s: 0.4, maxCandidatesPerPoll: 12 },
  ];
  const fallbackTiers = Array.isArray(raw?.fallbackTiers) && raw.fallbackTiers.length > 0
    ? raw.fallbackTiers.map((tier: any, index: number) =>
        normalizeRecoveryTier(tier, defaultFallbackTiers[Math.min(index, defaultFallbackTiers.length - 1)]))
    : defaultFallbackTiers;
  return {
    enabled: raw?.enabled !== false,
    maxSoftRechecksPerPoll: Math.round(clampNumber(raw?.maxSoftRechecksPerPoll, 2, 0, 10)),
    softCooldownMaxTtlSeconds: Math.round(clampNumber(raw?.softCooldownMaxTtlSeconds, 6, 1, 60)),
    softCooldownReasons: reasons,
    maxSyntheticRefinementCandidatesPerPoll: Math.round(clampNumber(raw?.maxSyntheticRefinementCandidatesPerPoll, 6, 0, 30)),
    minSoftRecheckBuys60s: Math.round(clampNumber(raw?.minSoftRecheckBuys60s, 8, 1, 500)),
    minSoftRecheckSolVolume60s: clampNumber(raw?.minSoftRecheckSolVolume60s, 1.5, 0.1, 100),
    minSoftRecheckVelocity: clampNumber(raw?.minSoftRecheckVelocity, 8, 1, 500),
    fallbackTiers,
  };
}

export function shouldAllowVelocitySoftRecheck(
  cooldownState: VelocityCooldownStateLike,
  candidate: VelocityCandidateLike,
  config: VelocitySelectionConfig,
): boolean {
  if (!config.enabled || !cooldownState?.active) return false;
  const reason = String(cooldownState.value || '').trim();
  if (!reason || !config.softCooldownReasons.includes(reason)) return false;
  const ttlSeconds = finiteNumber(cooldownState.ttlSeconds, Infinity);
  if (ttlSeconds <= 0 || ttlSeconds > config.softCooldownMaxTtlSeconds) return false;
  const buys60s = finiteNumber(candidate.buys60s, 0);
  const solVolume60s = finiteNumber(candidate.solVolume60s, 0);
  const velocity = finiteNumber(candidate.velocity, 0);
  return (
    buys60s >= config.minSoftRecheckBuys60s &&
    solVolume60s >= config.minSoftRecheckSolVolume60s &&
    velocity >= config.minSoftRecheckVelocity
  );
}

export function selectVelocityRecoveryTier(
  candidates: VelocityCandidateLike[],
  options: {
    excludeMints?: Set<string> | string[] | null;
    blacklist?: Set<string> | string[] | null;
    heldMints?: Set<string> | string[] | null;
    skipLabels?: Set<string> | string[] | null;
  },
  config: VelocitySelectionConfig,
): VelocityRecoverySelection {
  if (!config.enabled || !Array.isArray(config.fallbackTiers) || config.fallbackTiers.length === 0) {
    return { tier: null, candidates: [] };
  }

  const excludeMints = asMintSet(options?.excludeMints);
  const blacklist = asMintSet(options?.blacklist);
  const heldMints = asMintSet(options?.heldMints);
  const skipLabels = asMintSet(options?.skipLabels);

  for (const tier of config.fallbackTiers) {
    if (skipLabels.has(tier.label)) continue;
    const matching = candidates
      .filter((candidate) => {
        const mint = String(candidate?.mint || '').trim();
        if (!mint || excludeMints.has(mint) || blacklist.has(mint) || heldMints.has(mint)) return false;
        const buys60s = finiteNumber(candidate?.buys60s, 0);
        const buyRatio60s = finiteNumber(candidate?.buyRatio60s, 0);
        const solVolume60s = finiteNumber(candidate?.solVolume60s, 0);
        return (
          buys60s >= tier.minBuys60s &&
          buyRatio60s >= tier.minBuyRatio60s &&
          solVolume60s >= tier.minSolVolume60s
        );
      })
      .sort((a, b) =>
        (finiteNumber(b?.buyRatio60s, 0) - finiteNumber(a?.buyRatio60s, 0)) ||
        (finiteNumber(b?.solVolume60s, 0) - finiteNumber(a?.solVolume60s, 0)) ||
        (finiteNumber(b?.velocity, 0) - finiteNumber(a?.velocity, 0)) ||
        (finiteNumber(b?.buys60s, 0) - finiteNumber(a?.buys60s, 0))
      )
      // Recovery tiers intentionally over-select so the later cooldown filter can
      // look past the first stale leaders instead of starving the whole tier.
      .slice(0, Math.min(120, Math.max(tier.maxCandidatesPerPoll, tier.maxCandidatesPerPoll * 3)));

    if (matching.length > 0) {
      return { tier, candidates: matching };
    }
  }

  return { tier: null, candidates: [] };
}

export function resolveVelocityAssessmentBudget(input: {
  underfilledBookActive?: boolean | null;
  scoutCandidatesPerPoll?: number | null;
  currentOpenPositions?: number | null;
  maxOpenPositions?: number | null;
  currentEligibleCandidates?: number | null;
}): VelocityAssessmentBudget {
  const underfilledBookActive = input?.underfilledBookActive === true;
  const scoutCandidatesPerPoll = Math.round(clampNumber(input?.scoutCandidatesPerPoll, 1, 1, 50));
  const currentOpenPositions = Math.round(clampNumber(input?.currentOpenPositions, 0, 0, 10_000));
  const maxOpenPositions = Math.round(clampNumber(input?.maxOpenPositions, 1, 1, 10_000));
  const currentEligibleCandidates = Math.round(clampNumber(input?.currentEligibleCandidates, 0, 0, 10_000));
  const remainingSlots = Math.max(0, maxOpenPositions - currentOpenPositions);
  const desiredEligibleCandidates = underfilledBookActive
    ? Math.max(1, Math.min(remainingSlots, scoutCandidatesPerPoll))
    : 1;

  return {
    underfilledBookActive,
    desiredEligibleCandidates,
    additionalCandidatesNeeded: Math.max(0, desiredEligibleCandidates - currentEligibleCandidates),
  };
}

export function prioritizeVelocityAssessmentCandidates<T extends VelocityAssessmentCandidateLike>(candidates: T[]): T[] {
  return [...(Array.isArray(candidates) ? candidates : [])].sort((a, b) => {
    const aSynthetic = a?.isSynthetic === true ? 1 : 0;
    const bSynthetic = b?.isSynthetic === true ? 1 : 0;
    if (aSynthetic !== bSynthetic) return aSynthetic - bSynthetic;

    const aRefinementOnly = a?.refinementOnly === true ? 1 : 0;
    const bRefinementOnly = b?.refinementOnly === true ? 1 : 0;
    if (aRefinementOnly !== bRefinementOnly) return aRefinementOnly - bRefinementOnly;

    return 0;
  });
}

export function capSyntheticRefinementCandidates<T extends VelocityAssessmentCandidateLike>(
  candidates: T[],
  config: VelocitySelectionConfig,
): T[] {
  const configuredLimit = Math.max(0, Math.round(Number(config?.maxSyntheticRefinementCandidatesPerPoll || 0)));
  if (configuredLimit === 0) {
    return (Array.isArray(candidates) ? candidates : []).filter((candidate) => !(candidate?.isSynthetic || candidate?.refinementOnly));
  }

  const realCandidateCount = (Array.isArray(candidates) ? candidates : []).filter(
    (candidate) => !(candidate?.isSynthetic || candidate?.refinementOnly),
  ).length;
  const limit =
    realCandidateCount >= 4
      ? Math.min(configuredLimit, 1)
      : realCandidateCount >= 2
        ? Math.min(configuredLimit, 2)
        : configuredLimit;

  let syntheticCount = 0;
  const result: T[] = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const syntheticRefinement = Boolean(candidate?.isSynthetic || candidate?.refinementOnly);
    if (syntheticRefinement) {
      if (syntheticCount >= limit) continue;
      syntheticCount += 1;
    }
    result.push(candidate);
  }
  return result;
}
