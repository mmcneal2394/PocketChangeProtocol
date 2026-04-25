export type WalletStatsPeriod = {
  trades?: number;
  buy?: number;
  sell?: number;
  winrate?: number;
  realizedProfitUsd?: number;
  realizedProfitPnl?: number;
  nativeBalance?: number;
  avgHoldingPeriodSec?: number;
  tokenNum?: number;
};

export type WalletIntelInput = {
  wallet: string;
  tags?: string[];
  twitter?: string | null;
  d30?: WalletStatsPeriod | null;
  d7?: WalletStatsPeriod | null;
};

export type WalletIntelScoreBreakdown = {
  winRateScore: number;
  realizedProfitScore: number;
  tradeDepthScore: number;
  consistencyScore: number;
  copyabilityPenalty: number;
};

export type WalletIntelDerived = {
  wallet: string;
  tags: string[];
  twitter: string;
  primaryStyle: string;
  styleProfile: string[];
  copyabilityRisk: 'lower' | 'medium' | 'high';
  preferredHoldMs: number;
  weightedScore: number;
  profitabilityScore: number;
  executable: boolean;
  immediateEntry: boolean;
  scoreBreakdown: WalletIntelScoreBreakdown;
};

function toFiniteNumber(value: any, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function uniqueStrings(values: Array<string | null | undefined>) {
  const normalized = Array.isArray(values) ? values : [values as any];
  return Array.from(
    new Set(
      normalized
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    ),
  );
}

export function computeCopyabilityRisk(tags: string[] | null | undefined): 'lower' | 'medium' | 'high' {
  const normalized = new Set(uniqueStrings(tags).map((value) => value.toLowerCase()));
  if (normalized.has('sandwich_bot') || normalized.has('trojan') || normalized.has('wash_trader')) {
    return 'high';
  }
  if (
    normalized.has('kol') ||
    normalized.has('gmgn') ||
    normalized.has('photon') ||
    normalized.has('top_renamed') ||
    normalized.has('launchpad_smart') ||
    normalized.has('bullx')
  ) {
    return 'medium';
  }
  return 'lower';
}

export function deriveWalletStyleProfile(input: WalletIntelInput): string[] {
  const d30Trades = Math.max(0, toFiniteNumber(input?.d30?.trades));
  const d30HoldSec = Math.max(0, toFiniteNumber(input?.d30?.avgHoldingPeriodSec));
  const d7Trades = Math.max(0, toFiniteNumber(input?.d7?.trades));
  const d30TradesPerDay = d30Trades / 30;
  const d7TradesPerDay = d7Trades / 7;
  const tags = uniqueStrings(input?.tags).map((value) => value.toLowerCase());

  const styles: string[] = [];
  if (tags.includes('kol')) styles.push('KOL');

  if (d30HoldSec >= 6 * 60 * 60 || d30HoldSec === 0 && d30TradesPerDay < 80) {
    styles.push('SWING');
  }

  if (d30TradesPerDay >= 250 || d7TradesPerDay >= 300 || d30HoldSec > 0 && d30HoldSec <= 60 * 60) {
    styles.push('SCALP');
  }

  if (d30TradesPerDay >= 120 && d30HoldSec > 0 && d30HoldSec <= 8 * 60 * 60) {
    styles.push('FLOW');
  }

  if (styles.length === 0) styles.push('PROBATION');
  return uniqueStrings(styles);
}

export function derivePrimaryWalletStyle(input: WalletIntelInput): string {
  const styles = deriveWalletStyleProfile(input);
  if (styles.includes('KOL')) return 'KOL';
  if (styles.includes('SWING')) return 'SWING';
  if (styles.includes('SCALP')) return 'SCALP';
  if (styles.includes('FLOW')) return 'FLOW';
  return styles[0] || 'PROBATION';
}

export function derivePreferredHoldMs(input: WalletIntelInput): number {
  const d30HoldSec = Math.max(0, toFiniteNumber(input?.d30?.avgHoldingPeriodSec));
  const primaryStyle = derivePrimaryWalletStyle(input);
  if (primaryStyle === 'SCALP') {
    return 2 * 60_000;
  }
  if (primaryStyle === 'FLOW') {
    return 5 * 60_000;
  }
  if (primaryStyle === 'SWING') {
    return 15 * 60_000;
  }
  if (d30HoldSec <= 0) {
    return 5 * 60_000;
  }
  return Math.round(clamp(d30HoldSec * 1000, 2 * 60_000, 20 * 60_000));
}

export function computeWalletWeightedScore(input: WalletIntelInput): WalletIntelDerived {
  const d30Trades = Math.max(0, toFiniteNumber(input?.d30?.trades));
  const d30Winrate = clamp01(toFiniteNumber(input?.d30?.winrate));
  const d30RealizedProfit = Math.max(0, toFiniteNumber(input?.d30?.realizedProfitUsd));
  const d7Trades = Math.max(0, toFiniteNumber(input?.d7?.trades));
  const d7RealizedProfit = Math.max(0, toFiniteNumber(input?.d7?.realizedProfitUsd));
  const primaryStyle = derivePrimaryWalletStyle(input);
  const styleProfile = deriveWalletStyleProfile(input);
  const copyabilityRisk = computeCopyabilityRisk(input?.tags);
  const preferredHoldMs = derivePreferredHoldMs(input);

  const winRateScore = clamp01((d30Winrate - 0.45) / 0.35);
  const realizedProfitScore = clamp01(Math.log10(Math.max(d30RealizedProfit, 1)) / 6);
  const tradeDepthScore = clamp01(Math.log10(Math.max(d30Trades, 1)) / 5.5);
  const profitConsistency = d30RealizedProfit > 0 ? d7RealizedProfit / d30RealizedProfit : 0;
  const tradeConsistency = d30Trades > 0 ? d7Trades / d30Trades : 0;
  const consistencyScore = clamp01((clamp01(profitConsistency / 0.4) * 0.55) + (clamp01(tradeConsistency / 0.4) * 0.45));
  const copyabilityPenalty = copyabilityRisk === 'high' ? 0.20 : copyabilityRisk === 'medium' ? 0.08 : 0;

  const weightedScore = clamp01(
    (winRateScore * 0.38) +
    (realizedProfitScore * 0.24) +
    (tradeDepthScore * 0.16) +
    (consistencyScore * 0.22) -
    copyabilityPenalty,
  );

  const profitabilityScore = clamp01(
    (winRateScore * 0.45) +
    (realizedProfitScore * 0.35) +
    (tradeDepthScore * 0.20) -
    (copyabilityRisk === 'high' ? 0.18 : copyabilityRisk === 'medium' ? 0.05 : 0),
  );

  const executable = copyabilityRisk !== 'high' && weightedScore >= 0.58 && d30RealizedProfit > 2_000;
  const immediateEntry = executable && weightedScore >= 0.72 && d30Winrate >= 0.65 && d30Trades >= 3_000;

  return {
    wallet: String(input?.wallet || ''),
    tags: uniqueStrings(input?.tags),
    twitter: String(input?.twitter || '').trim(),
    primaryStyle,
    styleProfile,
    copyabilityRisk,
    preferredHoldMs,
    weightedScore: Number(weightedScore.toFixed(4)),
    profitabilityScore: Number(profitabilityScore.toFixed(4)),
    executable,
    immediateEntry,
    scoreBreakdown: {
      winRateScore: Number(winRateScore.toFixed(4)),
      realizedProfitScore: Number(realizedProfitScore.toFixed(4)),
      tradeDepthScore: Number(tradeDepthScore.toFixed(4)),
      consistencyScore: Number(consistencyScore.toFixed(4)),
      copyabilityPenalty: Number(copyabilityPenalty.toFixed(4)),
    },
  };
}

module.exports = {
  computeCopyabilityRisk,
  deriveWalletStyleProfile,
  derivePrimaryWalletStyle,
  derivePreferredHoldMs,
  computeWalletWeightedScore,
};
