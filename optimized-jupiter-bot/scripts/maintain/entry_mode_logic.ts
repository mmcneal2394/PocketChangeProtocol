export type CanonicalEntryMode = 'normal' | 'last-stand' | 'micro-scout';

type ResolveEffectiveEntryModeInput = {
  requestedEntryMode?: CanonicalEntryMode | null;
  microOnlyMode?: boolean | null;
};

type MicroScoutConfigLike = {
  fixedBuySol: number;
  reserveSol: number;
  portfolioSizingEnabled?: boolean | null;
  portfolioFraction?: number | null;
  maxDynamicBuySol?: number | null;
  stopLossPct: number;
  maxHoldMinutes: number;
  maxTPpct: number;
};

type BuildMicroOnlyProbeEntryOptionsInput = {
  requestedEntryMode?: CanonicalEntryMode | null;
  microOnlyMode?: boolean | null;
  microScoutConfig?: MicroScoutConfigLike | null;
};

type BuildMicroScoutEntryOptionsInput = {
  requestedEntryMode?: CanonicalEntryMode | null;
  microScoutConfig?: MicroScoutConfigLike | null;
};

function buildMicroScoutSizingFields(microScoutConfig: MicroScoutConfigLike) {
  return {
    fixedBuySol: microScoutConfig.fixedBuySol,
    reserveSol: microScoutConfig.reserveSol,
    ...(microScoutConfig.portfolioSizingEnabled === true
      ? { portfolioFraction: microScoutConfig.portfolioFraction }
      : {}),
    minDeploySol: microScoutConfig.fixedBuySol,
    ...(microScoutConfig.portfolioSizingEnabled === true && Number(microScoutConfig.maxDynamicBuySol || 0) > 0
      ? { maxDeploySol: Number(microScoutConfig.maxDynamicBuySol) }
      : {}),
    stopLossPct: microScoutConfig.stopLossPct / 100,
    maxHoldMinutes: microScoutConfig.maxHoldMinutes,
    maxTPpct: microScoutConfig.maxTPpct / 100,
  };
}

export function resolveEffectiveEntryMode(input: ResolveEffectiveEntryModeInput): CanonicalEntryMode {
  const requestedEntryMode = input.requestedEntryMode || 'normal';

  if (requestedEntryMode !== 'normal') return requestedEntryMode;
  if (input.microOnlyMode !== true) return requestedEntryMode;

  return 'micro-scout';
}

export function buildMicroScoutEntryOptions(input: BuildMicroScoutEntryOptionsInput) {
  const entryMode = input.requestedEntryMode || 'micro-scout';
  const microScoutConfig = input.microScoutConfig;

  if (entryMode !== 'micro-scout' || !microScoutConfig) {
    return { entryMode };
  }

  return {
    entryMode,
    ...buildMicroScoutSizingFields(microScoutConfig),
  };
}

export function buildMicroOnlyProbeEntryOptions(input: BuildMicroOnlyProbeEntryOptionsInput) {
  const entryMode = resolveEffectiveEntryMode(input);
  const microScoutConfig = input.microScoutConfig;

  if (entryMode !== 'micro-scout' || input.microOnlyMode !== true || !microScoutConfig) {
    return { entryMode };
  }

  return {
    entryMode,
    ...buildMicroScoutSizingFields(microScoutConfig),
  };
}
