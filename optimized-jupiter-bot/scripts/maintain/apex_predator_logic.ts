type VolumeTrend = 'increasing' | 'steady' | 'declining' | 'unknown';

interface ApexPredatorConfig {
  enabled: boolean;
  minimumCrimeSignals: number;
  minimumOverlaySignals: number;
  overlayMinConvictionScore: number;
  requireBotActivityForOverlay: boolean;
  minMarketCapUsd: number;
  minVolume5mUsd: number;
  minSmartMoneyBuys: number;
  minFollowInflowUsd5m: number;
  minFollowTrades5m: number;
  suspiciousEvenTop10MaxPct: number;
  suspiciousEvenMinHolders: number;
  suspiciousEvenMaxAgeSec: number;
  minRecent5mVsHourlyAverage: number;
  minHourlyVs6hAverage: number;
  minHolderGrowthPerHour: number;
  maxAnomalousHolderMarketCapUsd: number;
  structuralExitMarketCapUsd: number;
  structuralExitMinLiquidityUsd: number;
  structuralExitMinLiquidityGrowthMultiple: number;
  structuralExitMinLiquidityToMarketCapRatio: number;
  volumeDivergenceMinGainPct: number;
  smartMoneyExitSellToBuyRatio: number;
  minSmartMoneyExitTrades: number;
  maxFollowInflowUsd5mDuringExit: number;
}

interface ApexEntryInput {
  marketCapUsd?: number;
  volume5mUsd?: number;
  volume1hUsd?: number;
  volume6hUsd?: number;
  momentum5mPct?: number;
  momentum1hPct?: number;
  tokenAgeSec?: number;
  holderCount?: number;
  top10Pct?: number;
  smartMoneyBuys?: number;
  smartMoneySells?: number;
  followInflowUsd5m?: number;
  followTrades5m?: number;
  followUniqueWallets5m?: number;
  followFullPositionOpens5m?: number;
  rugCheckSafe?: boolean;
  volumeTrend?: VolumeTrend | string;
}

interface ApexEntryDecision {
  passesInitialScreen: boolean;
  passesMomentumConfluence: boolean;
  positiveSignals: string[];
  missingSignals: string[];
  redFlagCount: number;
  convictionScore: number;
  shouldEnter: boolean;
  supportsAggressiveOverlay: boolean;
  flags: {
    suspiciousEvenDistribution: boolean;
    botActivityDetected: boolean;
    volumeConsistency: boolean;
    anomalousHolderGrowth: boolean;
  };
  metrics: {
    recent5mVsHourlyAverage: number | null;
    hourlyVs6hAverage: number | null;
    holdersPerHour: number | null;
    volumeTrend: VolumeTrend;
  };
}

interface ApexExitInput {
  entryLiquidityUsd?: number;
  currentLiquidityUsd?: number;
  marketCapUsd?: number;
  priceChangeSinceEntryPct?: number;
  volume5mUsd?: number;
  volume1hUsd?: number;
  volume6hUsd?: number;
  smartMoneyBuys?: number;
  smartMoneySells?: number;
  followInflowUsd5m?: number;
  followTrades5m?: number;
  liquidityDepthHealthy?: boolean;
  volumeTrend?: VolumeTrend | string;
}

interface ApexExitDecision {
  shouldExit: boolean;
  primaryReason: 'thin_air_liquidity' | 'volume_divergence' | 'smart_money_exodus' | null;
  reasons: string[];
  flags: {
    thinAirLiquidity: boolean;
    volumeDivergence: boolean;
    smartMoneyExodus: boolean;
  };
  metrics: {
    volumeTrend: VolumeTrend;
    requiredLiquidityUsd: number;
    smartMoneySellToBuyRatio: number | null;
  };
}

const DEFAULT_APEX_PREDATOR_CONFIG: ApexPredatorConfig = {
  enabled: true,
  minimumCrimeSignals: 3,
  minimumOverlaySignals: 2,
  overlayMinConvictionScore: 55,
  requireBotActivityForOverlay: true,
  minMarketCapUsd: 225_000,
  minVolume5mUsd: 9_000,
  minSmartMoneyBuys: 1,
  minFollowInflowUsd5m: 250,
  minFollowTrades5m: 2,
  suspiciousEvenTop10MaxPct: 5,
  suspiciousEvenMinHolders: 60,
  suspiciousEvenMaxAgeSec: 6 * 60 * 60,
  minRecent5mVsHourlyAverage: 0.7,
  minHourlyVs6hAverage: 0.7,
  minHolderGrowthPerHour: 35,
  maxAnomalousHolderMarketCapUsd: 2_000_000,
  structuralExitMarketCapUsd: 4_000_000,
  structuralExitMinLiquidityUsd: 150_000,
  structuralExitMinLiquidityGrowthMultiple: 1.8,
  structuralExitMinLiquidityToMarketCapRatio: 0.05,
  volumeDivergenceMinGainPct: 8,
  smartMoneyExitSellToBuyRatio: 1.5,
  minSmartMoneyExitTrades: 2,
  maxFollowInflowUsd5mDuringExit: 150,
};

function toFiniteNumber(value: any): number | null {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeTrend(value?: string): VolumeTrend {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'increasing' || raw === 'steady' || raw === 'declining') return raw;
  return 'unknown';
}

function normalizeApexPredatorConfig(raw: Partial<ApexPredatorConfig> = {}): ApexPredatorConfig {
  return {
    ...DEFAULT_APEX_PREDATOR_CONFIG,
    ...raw,
    minimumCrimeSignals: Math.max(1, Math.round(toFiniteNumber(raw.minimumCrimeSignals) ?? DEFAULT_APEX_PREDATOR_CONFIG.minimumCrimeSignals)),
    minimumOverlaySignals: Math.max(1, Math.round(toFiniteNumber(raw.minimumOverlaySignals) ?? DEFAULT_APEX_PREDATOR_CONFIG.minimumOverlaySignals)),
    overlayMinConvictionScore: clamp(
      toFiniteNumber(raw.overlayMinConvictionScore) ?? DEFAULT_APEX_PREDATOR_CONFIG.overlayMinConvictionScore,
      0,
      100,
    ),
    requireBotActivityForOverlay: raw.requireBotActivityForOverlay !== false,
  };
}

function deriveVolumeTrend(input: {
  volume5mUsd?: number;
  volume1hUsd?: number;
  volume6hUsd?: number;
  explicitTrend?: string;
}): VolumeTrend {
  const explicitTrend = normalizeTrend(input.explicitTrend);
  if (explicitTrend !== 'unknown') return explicitTrend;

  const volume5mUsd = toFiniteNumber(input.volume5mUsd);
  const volume1hUsd = toFiniteNumber(input.volume1hUsd);
  const volume6hUsd = toFiniteNumber(input.volume6hUsd);

  const recent5mVsHourlyAverage =
    volume5mUsd && volume1hUsd && volume1hUsd > 0
      ? volume5mUsd / (volume1hUsd / 12)
      : null;
  const hourlyVs6hAverage =
    volume1hUsd && volume6hUsd && volume6hUsd > 0
      ? volume1hUsd / (volume6hUsd / 6)
      : null;

  if (recent5mVsHourlyAverage === null && hourlyVs6hAverage === null) return 'unknown';
  if (
    (recent5mVsHourlyAverage !== null && recent5mVsHourlyAverage < 0.55) &&
    (hourlyVs6hAverage === null || hourlyVs6hAverage < 0.8)
  ) {
    return 'declining';
  }
  if (
    (recent5mVsHourlyAverage !== null && recent5mVsHourlyAverage > 1.15) ||
    (hourlyVs6hAverage !== null && hourlyVs6hAverage > 1.1)
  ) {
    return 'increasing';
  }
  return 'steady';
}

function evaluateApexEntry(input: ApexEntryInput, rawConfig: Partial<ApexPredatorConfig> = {}): ApexEntryDecision {
  const config = normalizeApexPredatorConfig(rawConfig);
  const marketCapUsd = toFiniteNumber(input.marketCapUsd);
  const volume5mUsd = toFiniteNumber(input.volume5mUsd);
  const volume1hUsd = toFiniteNumber(input.volume1hUsd);
  const volume6hUsd = toFiniteNumber(input.volume6hUsd);
  const momentum5mPct = toFiniteNumber(input.momentum5mPct) ?? 0;
  const momentum1hPct = toFiniteNumber(input.momentum1hPct) ?? 0;
  const tokenAgeSec = toFiniteNumber(input.tokenAgeSec);
  const holderCount = toFiniteNumber(input.holderCount);
  const top10Pct = toFiniteNumber(input.top10Pct);
  const smartMoneyBuys = toFiniteNumber(input.smartMoneyBuys) ?? 0;
  const smartMoneySells = toFiniteNumber(input.smartMoneySells) ?? 0;
  const followInflowUsd5m = toFiniteNumber(input.followInflowUsd5m) ?? 0;
  const followTrades5m = toFiniteNumber(input.followTrades5m) ?? 0;
  const followUniqueWallets5m = toFiniteNumber(input.followUniqueWallets5m) ?? 0;
  const followFullPositionOpens5m = toFiniteNumber(input.followFullPositionOpens5m) ?? 0;

  const volumeTrend = deriveVolumeTrend({
    volume5mUsd: volume5mUsd ?? undefined,
    volume1hUsd: volume1hUsd ?? undefined,
    volume6hUsd: volume6hUsd ?? undefined,
    explicitTrend: input.volumeTrend,
  });

  const recent5mVsHourlyAverage =
    volume5mUsd !== null && volume1hUsd !== null && volume1hUsd > 0
      ? volume5mUsd / (volume1hUsd / 12)
      : null;
  const hourlyVs6hAverage =
    volume1hUsd !== null && volume6hUsd !== null && volume6hUsd > 0
      ? volume1hUsd / (volume6hUsd / 6)
      : null;
  const holdersPerHour =
    tokenAgeSec !== null && tokenAgeSec > 0 && holderCount !== null
      ? holderCount / (tokenAgeSec / 3600)
      : null;

  const passesInitialScreen =
    config.enabled &&
    input.rugCheckSafe !== false &&
    marketCapUsd !== null &&
    volume5mUsd !== null &&
    marketCapUsd >= config.minMarketCapUsd &&
    volume5mUsd >= config.minVolume5mUsd;
  const passesMomentumConfluence = momentum5mPct > 0 && momentum1hPct > 0;

  const suspiciousEvenDistribution =
    top10Pct !== null &&
    holderCount !== null &&
    tokenAgeSec !== null &&
    top10Pct <= config.suspiciousEvenTop10MaxPct &&
    holderCount >= config.suspiciousEvenMinHolders &&
    tokenAgeSec <= config.suspiciousEvenMaxAgeSec;
  const botActivityDetected =
    smartMoneyBuys >= config.minSmartMoneyBuys ||
    followInflowUsd5m >= config.minFollowInflowUsd5m ||
    followTrades5m >= config.minFollowTrades5m ||
    followUniqueWallets5m >= 2 ||
    followFullPositionOpens5m >= 1;
  const volumeConsistency =
    volumeTrend !== 'declining' &&
    volume5mUsd !== null &&
    volume5mUsd >= config.minVolume5mUsd &&
    (recent5mVsHourlyAverage === null || recent5mVsHourlyAverage >= config.minRecent5mVsHourlyAverage) &&
    (hourlyVs6hAverage === null || hourlyVs6hAverage >= config.minHourlyVs6hAverage);
  const anomalousHolderGrowth =
    holdersPerHour !== null &&
    marketCapUsd !== null &&
    holdersPerHour >= config.minHolderGrowthPerHour &&
    marketCapUsd <= config.maxAnomalousHolderMarketCapUsd;

  const flags = {
    suspiciousEvenDistribution,
    botActivityDetected,
    volumeConsistency,
    anomalousHolderGrowth,
  };

  const positiveSignals = Object.entries(flags)
    .filter(([, active]) => Boolean(active))
    .map(([name]) => name);
  const missingSignals = Object.entries(flags)
    .filter(([, active]) => !active)
    .map(([name]) => name);
  const redFlagCount = positiveSignals.length;

  let convictionScore = 0;
  if (passesInitialScreen) convictionScore += 20;
  if (passesMomentumConfluence) convictionScore += 20;
  convictionScore += redFlagCount * 15;
  if (smartMoneyBuys > smartMoneySells) convictionScore += 8;
  if (followInflowUsd5m >= config.minFollowInflowUsd5m * 2) convictionScore += 6;
  convictionScore = clamp(convictionScore, 0, 100);
  const supportsAggressiveOverlay =
    redFlagCount >= config.minimumOverlaySignals &&
    convictionScore >= config.overlayMinConvictionScore &&
    volumeTrend !== 'declining' &&
    (!config.requireBotActivityForOverlay || botActivityDetected);

  return {
    passesInitialScreen,
    passesMomentumConfluence,
    positiveSignals,
    missingSignals,
    redFlagCount,
    convictionScore,
    shouldEnter: passesInitialScreen && passesMomentumConfluence && redFlagCount >= config.minimumCrimeSignals,
    supportsAggressiveOverlay,
    flags,
    metrics: {
      recent5mVsHourlyAverage,
      hourlyVs6hAverage,
      holdersPerHour,
      volumeTrend,
    },
  };
}

function evaluateApexExit(input: ApexExitInput, rawConfig: Partial<ApexPredatorConfig> = {}): ApexExitDecision {
  const config = normalizeApexPredatorConfig(rawConfig);
  const entryLiquidityUsd = toFiniteNumber(input.entryLiquidityUsd) ?? 0;
  const currentLiquidityUsd = toFiniteNumber(input.currentLiquidityUsd) ?? 0;
  const marketCapUsd = toFiniteNumber(input.marketCapUsd) ?? 0;
  const priceChangeSinceEntryPct = toFiniteNumber(input.priceChangeSinceEntryPct) ?? 0;
  const smartMoneyBuys = toFiniteNumber(input.smartMoneyBuys) ?? 0;
  const smartMoneySells = toFiniteNumber(input.smartMoneySells) ?? 0;
  const followInflowUsd5m = toFiniteNumber(input.followInflowUsd5m) ?? 0;

  const volumeTrend = deriveVolumeTrend({
    volume5mUsd: input.volume5mUsd,
    volume1hUsd: input.volume1hUsd,
    volume6hUsd: input.volume6hUsd,
    explicitTrend: input.volumeTrend,
  });

  const requiredLiquidityUsd = Math.max(
    config.structuralExitMinLiquidityUsd,
    entryLiquidityUsd * config.structuralExitMinLiquidityGrowthMultiple,
    marketCapUsd * config.structuralExitMinLiquidityToMarketCapRatio,
  );
  const smartMoneySellToBuyRatio =
    smartMoneyBuys > 0
      ? smartMoneySells / smartMoneyBuys
      : smartMoneySells > 0
        ? Infinity
        : null;

  const thinAirLiquidity =
    !input.liquidityDepthHealthy &&
    marketCapUsd >= config.structuralExitMarketCapUsd &&
    currentLiquidityUsd > 0 &&
    currentLiquidityUsd < requiredLiquidityUsd;
  const volumeDivergence =
    priceChangeSinceEntryPct >= config.volumeDivergenceMinGainPct &&
    volumeTrend === 'declining';
  const smartMoneyExodus =
    smartMoneySells >= config.minSmartMoneyExitTrades &&
    followInflowUsd5m <= config.maxFollowInflowUsd5mDuringExit &&
    (
      smartMoneyBuys <= 0 ||
      (smartMoneySellToBuyRatio !== null && smartMoneySellToBuyRatio >= config.smartMoneyExitSellToBuyRatio)
    );

  const reasons: string[] = [];
  if (thinAirLiquidity) reasons.push('thin_air_liquidity');
  if (volumeDivergence) reasons.push('volume_divergence');
  if (smartMoneyExodus) reasons.push('smart_money_exodus');

  return {
    shouldExit: reasons.length > 0,
    primaryReason: thinAirLiquidity
      ? 'thin_air_liquidity'
      : volumeDivergence
        ? 'volume_divergence'
        : smartMoneyExodus
          ? 'smart_money_exodus'
          : null,
    reasons,
    flags: {
      thinAirLiquidity,
      volumeDivergence,
      smartMoneyExodus,
    },
    metrics: {
      volumeTrend,
      requiredLiquidityUsd,
      smartMoneySellToBuyRatio,
    },
  };
}

module.exports = {
  DEFAULT_APEX_PREDATOR_CONFIG,
  normalizeApexPredatorConfig,
  deriveVolumeTrend,
  evaluateApexEntry,
  evaluateApexExit,
};

export {};
