export const MIN_QUOTA_POSITIONS = 10;
export const TARGET_QUOTA_POSITIONS = 15;

export type QuotaAssistLevel = 0 | 1 | 2;

function toFiniteNumber(value: any, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function resolveQuotaAssistLevel(
  openPositions: number,
  minPositions = MIN_QUOTA_POSITIONS,
  targetPositions = TARGET_QUOTA_POSITIONS,
): QuotaAssistLevel {
  const normalizedOpen = Math.max(0, Math.floor(toFiniteNumber(openPositions, targetPositions)));
  if (normalizedOpen < minPositions) return 2;
  if (normalizedOpen < targetPositions) return 1;
  return 0;
}

export function resolveQuotaPressure(
  openPositions: number,
  minPositions = MIN_QUOTA_POSITIONS,
  targetPositions = TARGET_QUOTA_POSITIONS,
): number {
  const level = resolveQuotaAssistLevel(openPositions, minPositions, targetPositions);
  if (level === 2) return 2.0;
  if (level === 1) {
    return 1.0 - ((Math.max(0, openPositions) - minPositions) / Math.max(1, targetPositions - minPositions));
  }
  return 0.0;
}

export function walletPriorityRank(priority: string): number {
  switch (String(priority || '').toUpperCase()) {
    case 'VERY_HIGH':
      return 3;
    case 'HIGH':
      return 2;
    case 'SCALP':
      return 1;
    default:
      return 0;
  }
}

function logScore(value: any, max = 5): number {
  const numeric = Math.max(0, toFiniteNumber(value));
  if (numeric <= 0) return 0;
  const score = Math.log10(Math.max(numeric, 1)) / max;
  return Math.max(0, Math.min(1, score));
}

function copyabilityPenalty(signal: Record<string, any>): number {
  const risk = String(signal?.copyabilityRisk || '').trim().toLowerCase();
  if (risk === 'high') return 0.22;
  if (risk === 'medium') return 0.08;
  return 0;
}

function resolveMarketCapUsd(candidate: Record<string, any> | null | undefined): number {
  return Math.max(
    0,
    toFiniteNumber(candidate?.marketCapUsd),
    toFiniteNumber(candidate?.fdvUsd),
  );
}

function resolveLiquidityUsd(candidate: Record<string, any> | null | undefined): number {
  return Math.max(0, toFiniteNumber(candidate?.liquidityUsd));
}

function resolveVolume1hUsd(candidate: Record<string, any> | null | undefined): number {
  return Math.max(0, toFiniteNumber(candidate?.volume1hUsd || candidate?.volume1h));
}

function resolveBuys1h(candidate: Record<string, any> | null | undefined): number {
  return Math.max(0, toFiniteNumber(candidate?.buys1h));
}

export function computeWalletProfitSeekingEdgeScore(signal: Record<string, any> | null | undefined): number {
  if (!signal) return 0;
  const consensusScore = Math.max(0, Math.min(1, toFiniteNumber(signal?.consensusScore)));
  const walletPnlScore = Math.max(0, Math.min(1, toFiniteNumber(signal?.walletPnlScore)));
  const weightedScore = Math.max(0, Math.min(1, toFiniteNumber(signal?.walletWeightedScore || signal?.walletCompositeScore)));
  const avgWinRate = Math.max(0, Math.min(1, toFiniteNumber(signal?.avgWalletWinRate)));
  const riskPenalty = copyabilityPenalty(signal);
  const probabilityOfWin = Math.max(
    0,
    Math.min(
      1,
      (consensusScore * 0.30) +
      (weightedScore * 0.42) +
      (avgWinRate * 0.23) +
      (signal?.sizeUp ? 0.05 : 0),
    ),
  );
  const probabilityOfLoss = 1 - probabilityOfWin;
  const rewardMultiplier =
    0.9 +
    (walletPnlScore * 0.70) +
    (weightedScore * 0.45) +
    (signal?.kolConfirmed ? 0.08 : 0);
  const penaltyMultiplier =
    1.0 +
    ((1 - walletPnlScore) * 0.85) +
    (riskPenalty * 2.2);
  const expectedScore = (probabilityOfWin * rewardMultiplier) - (probabilityOfLoss * penaltyMultiplier);
  return Number(Math.max(0, Math.min(1, (expectedScore + 1) / 2)).toFixed(6));
}

export function computeWalletQuotaSignalScore(signal: Record<string, any> | null | undefined): number {
  if (!signal) return 0;
  const sizeUpBoost = signal?.sizeUp ? 0.2 : 0;
  const priorityBoost = walletPriorityRank(String(signal?.priority || '')) * 0.04;
  const consensusScore = Math.max(0, Math.min(1, toFiniteNumber(signal?.consensusScore)));
  const walletPnlScore = Math.max(0, Math.min(1, toFiniteNumber(signal?.walletPnlScore)));
  const weightedScore = Math.max(0, Math.min(1, toFiniteNumber(signal?.walletWeightedScore || signal?.walletCompositeScore)));
  const profitSeekingEdgeScore = computeWalletProfitSeekingEdgeScore(signal);
  const avgWinRate = Math.max(0, Math.min(1, toFiniteNumber(signal?.avgWalletWinRate)));
  const tradeDepthScore = logScore(signal?.walletTradeCount, 5.5);
  const walletCount = Array.isArray(signal?.wallets) ? signal.wallets.length : toFiniteNumber(signal?.walletCount);
  const styleCount = signal?.styleProfileCounts ? Object.keys(signal.styleProfileCounts).length : 0;
  const diversityScore = Math.max(0, Math.min(1, Math.max(walletCount, styleCount) / 4));
  const kolBoost = signal?.kolConfirmed ? 0.04 : 0;
  const freshnessScore = isWalletSignalFresh(signal) ? 0.03 : 0;

  return Number(Math.max(
    0,
    (
      sizeUpBoost +
      priorityBoost +
      (consensusScore * 0.16) +
      (walletPnlScore * 0.12) +
      (weightedScore * 0.21) +
      (profitSeekingEdgeScore * 0.18) +
      (avgWinRate * 0.11) +
      (tradeDepthScore * 0.07) +
      (diversityScore * 0.05) +
      kolBoost +
      freshnessScore -
      copyabilityPenalty(signal)
    ),
  ).toFixed(6));
}

export function sortWalletQuotaSignals<T extends Record<string, any>>(signals: T[]): T[] {
  return [...(signals || [])].sort((left, right) => {
    const compositeDelta = computeWalletQuotaSignalScore(right) - computeWalletQuotaSignalScore(left);
    if (Math.abs(compositeDelta) > 0.000001) return compositeDelta > 0 ? 1 : -1;

    const sizeUpDelta = Number(Boolean(right?.sizeUp)) - Number(Boolean(left?.sizeUp));
    if (sizeUpDelta !== 0) return sizeUpDelta;

    const priorityDelta = walletPriorityRank(String(right?.priority || '')) - walletPriorityRank(String(left?.priority || ''));
    if (priorityDelta !== 0) return priorityDelta;

    const consensusDelta = toFiniteNumber(right?.consensusScore) - toFiniteNumber(left?.consensusScore);
    if (Math.abs(consensusDelta) > 0.0001) return consensusDelta > 0 ? 1 : -1;

    const pnlDelta = toFiniteNumber(right?.walletPnlScore) - toFiniteNumber(left?.walletPnlScore);
    if (Math.abs(pnlDelta) > 0.0001) return pnlDelta > 0 ? 1 : -1;

    const walletCountDelta =
      (Array.isArray(right?.wallets) ? right.wallets.length : toFiniteNumber(right?.walletCount)) -
      (Array.isArray(left?.wallets) ? left.wallets.length : toFiniteNumber(left?.walletCount));
    if (walletCountDelta !== 0) return walletCountDelta;

    const recencyDelta = toFiniteNumber(right?.lastSeenMs || right?.firstSeenMs) - toFiniteNumber(left?.lastSeenMs || left?.firstSeenMs);
    if (recencyDelta !== 0) return recencyDelta > 0 ? 1 : -1;

    return String(left?.mint || '').localeCompare(String(right?.mint || ''));
  });
}

export function resolveWalletQuotaCandidateLimit(level: QuotaAssistLevel): number {
  if (level >= 2) return 4;
  if (level === 1) return 2;
  return 1;
}

export function resolveAlphaQuotaCandidateLimit(level: QuotaAssistLevel): number {
  if (level >= 2) return 4;
  if (level === 1) return 2;
  return 0;
}

export function resolveWalletQuotaScales(level: QuotaAssistLevel) {
  if (level >= 2) {
    return {
      qualifierThresholdScale: 0.60,
      buyCountThresholdScale: 0.70,
      buyRatioThresholdScale: 0.75,
    };
  }
  if (level === 1) {
    return {
      qualifierThresholdScale: 0.75,
      buyCountThresholdScale: 0.85,
      buyRatioThresholdScale: 0.90,
    };
  }
  return {
    qualifierThresholdScale: undefined,
    buyCountThresholdScale: undefined,
    buyRatioThresholdScale: undefined,
  };
}

export function resolveAlphaQualifierScale(level: QuotaAssistLevel): number | undefined {
  if (level >= 2) return 0.70;
  if (level === 1) return 0.85;
  return undefined;
}

export function shouldBypassCooldownForQuotaAssist(args: {
  quotaAssist?: boolean;
  quotaAssistLevel?: number;
  sourceLane?: string | null;
  entryFamily?: string | null;
  strikeCount?: number;
  lossStreakActive?: boolean;
}) {
  const lane = String(args.sourceLane || args.entryFamily || '').trim().toLowerCase();
  return (
    args.quotaAssist === true &&
    Number(args.quotaAssistLevel || 0) >= 2 &&
    Number(args.strikeCount || 0) <= 0 &&
    args.lossStreakActive !== true &&
    (lane === 'wallet' || lane === 'alpha')
  );
}

export function isWalletSignalFresh(signal: Record<string, any> | null | undefined, now = Date.now()) {
  if (!signal) return false;
  if (signal.expired === true) return false;
  const lastSeenMs = toFiniteNumber(signal.lastSeenMs || signal.firstSeenMs);
  if (!lastSeenMs) return false;
  return (now - lastSeenMs) <= 15 * 60_000;
}

export function shouldAllowQuotaWalletWithoutExtraMarketSupport(signal: Record<string, any> | null | undefined) {
  const walletCount = Array.isArray(signal?.wallets) ? signal.wallets.length : toFiniteNumber(signal?.walletCount);
  const consensusScore = Math.max(0, Math.min(1, toFiniteNumber(signal?.consensusScore)));
  const weightedScore = Math.max(
    0,
    Math.min(1, toFiniteNumber(signal?.walletWeightedScore || signal?.walletCompositeScore)),
  );
  const priority = String(signal?.priority || '').toUpperCase();
  return (
    walletCount >= 3 ||
    (walletCount >= 2 && Boolean(signal?.kolConfirmed)) ||
    (walletCount >= 2 && (Boolean(signal?.sizeUp) || weightedScore >= 0.72 || consensusScore >= 0.80)) ||
    (Boolean(signal?.kolConfirmed) && weightedScore >= 0.68 && consensusScore >= 0.74) ||
    (Boolean(signal?.sizeUp) && weightedScore >= 0.76 && consensusScore >= 0.80) ||
    (priority === 'VERY_HIGH' && walletCount >= 2 && weightedScore >= 0.72)
  );
}

export function isQuotaCandidateMetadataBlind(candidate: Record<string, any> | null | undefined) {
  return resolveLiquidityUsd(candidate) <= 0 && resolveMarketCapUsd(candidate) <= 0;
}

export function hasQuotaCandidateMarketSupport(candidate: Record<string, any> | null | undefined) {
  return (
    resolveLiquidityUsd(candidate) > 0 ||
    resolveMarketCapUsd(candidate) > 0 ||
    resolveVolume1hUsd(candidate) >= 1000 ||
    resolveBuys1h(candidate) >= 3 ||
    Boolean(candidate?.bagsSignal)
  );
}

export function shouldSuppressQuotaAssistForQuietRegime(args: {
  quotaAssistLevel?: number;
  executableWalletBuyCount?: number;
  gmgnFollowCount?: number;
}) {
  return (
    Number(args.quotaAssistLevel || 0) > 0 &&
    Number(args.executableWalletBuyCount || 0) <= 0 &&
    Number(args.gmgnFollowCount || 0) <= 0
  );
}

export function shouldAllowAlphaQuotaCandidate(args: {
  candidate?: Record<string, any> | null;
  alphaKolCount?: number;
  signalCount?: number;
  quotaQuietRegime?: boolean;
  walletSignal?: Record<string, any> | null;
  replayBacked?: boolean;
}) {
  const candidate = args.candidate || {};
  const alphaKolCount = Math.max(0, toFiniteNumber(args.alphaKolCount));
  const signalCount = Math.max(0, toFiniteNumber(args.signalCount));
  const marketSupport = hasQuotaCandidateMarketSupport(candidate);
  const metadataBlind = isQuotaCandidateMetadataBlind(candidate);
  const walletSignal = args.walletSignal || null;
  const walletQuotaScore = computeWalletQuotaSignalScore(walletSignal);
  const strongWalletSupport =
    shouldAllowQuotaWalletWithoutExtraMarketSupport(walletSignal) ||
    (
      Boolean(walletSignal?.executable) &&
      walletQuotaScore >= 0.42 &&
      Math.max(0, toFiniteNumber(walletSignal?.consensusScore)) >= 0.68
    );

  if (metadataBlind) {
    return (
      args.replayBacked === true &&
      strongWalletSupport &&
      (alphaKolCount > 0 || signalCount >= 2)
    );
  }
  if (args.quotaQuietRegime === true && alphaKolCount <= 0) {
    return false;
  }
  if (alphaKolCount > 0) {
    return true;
  }
  return signalCount >= 2 && marketSupport;
}

module.exports = {
  MIN_QUOTA_POSITIONS,
  TARGET_QUOTA_POSITIONS,
  resolveQuotaAssistLevel,
  resolveQuotaPressure,
  walletPriorityRank,
  computeWalletProfitSeekingEdgeScore,
  computeWalletQuotaSignalScore,
  sortWalletQuotaSignals,
  resolveWalletQuotaCandidateLimit,
  resolveAlphaQuotaCandidateLimit,
  resolveWalletQuotaScales,
  resolveAlphaQualifierScale,
  shouldBypassCooldownForQuotaAssist,
  isWalletSignalFresh,
  shouldAllowQuotaWalletWithoutExtraMarketSupport,
  isQuotaCandidateMetadataBlind,
  hasQuotaCandidateMarketSupport,
  shouldSuppressQuotaAssistForQuietRegime,
  shouldAllowAlphaQuotaCandidate,
};
