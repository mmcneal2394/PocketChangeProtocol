import type { MicroScoutProbeConfig } from './micro_scout_logic';

export interface UnderfilledBookPacingConfig {
  enabled?: boolean;
  maxFillRatio?: number;
  minRawBuys60s?: number;
  minRawBuyRatio60s?: number;
  minRawSolVolume60s?: number;
  minVelocity?: number;
  maxCandidatesPerPoll?: number;
}

export interface MicroScoutPacingInput {
  currentOpenPositions?: number;
  maxOpenPositions?: number;
  baseProbeConfig?: MicroScoutProbeConfig & { maxCandidatesPerPoll?: number };
  underfilledBook?: UnderfilledBookPacingConfig;
}

export interface MicroScoutPacingDecision {
  underfilledBookActive: boolean;
  fillRatio: number;
  remainingSlots: number;
  maxCandidatesPerPoll: number;
  probeConfig: MicroScoutProbeConfig;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(clampNumber(value, fallback, min, max));
}

export function resolveMicroScoutPacing(
  input: MicroScoutPacingInput = {},
): MicroScoutPacingDecision {
  const currentOpenPositions = clampInteger(input.currentOpenPositions, 0, 0, 10_000);
  const maxOpenPositions = clampInteger(input.maxOpenPositions, 1, 1, 10_000);
  const remainingSlots = Math.max(0, maxOpenPositions - currentOpenPositions);
  const fillRatio = currentOpenPositions / maxOpenPositions;

  const baseProbeConfig = {
    minRawBuys60s: clampInteger(input.baseProbeConfig?.minRawBuys60s, 8, 1, 10_000),
    minRawBuyRatio60s: clampNumber(input.baseProbeConfig?.minRawBuyRatio60s, 0.7, 0.5, 0.99),
    minRawSolVolume60s: clampNumber(input.baseProbeConfig?.minRawSolVolume60s, 1, 0.1, 1_000),
    minVelocity: clampNumber(input.baseProbeConfig?.minVelocity, 8, 1, 10_000),
    maxCandidatesPerPoll: clampInteger(input.baseProbeConfig?.maxCandidatesPerPoll, 2, 1, 50),
  };

  const underfilledBook = input.underfilledBook || {};
  const underfilledBookActive =
    underfilledBook.enabled === true &&
    remainingSlots > 0 &&
    fillRatio <= clampNumber(underfilledBook.maxFillRatio, 0.3, 0, 1);

  if (!underfilledBookActive) {
    return {
      underfilledBookActive: false,
      fillRatio,
      remainingSlots,
      maxCandidatesPerPoll: baseProbeConfig.maxCandidatesPerPoll,
      probeConfig: {
        minRawBuys60s: baseProbeConfig.minRawBuys60s,
        minRawBuyRatio60s: baseProbeConfig.minRawBuyRatio60s,
        minRawSolVolume60s: baseProbeConfig.minRawSolVolume60s,
        minVelocity: baseProbeConfig.minVelocity,
      },
    };
  }

  return {
    underfilledBookActive: true,
    fillRatio,
    remainingSlots,
    maxCandidatesPerPoll: Math.max(
      baseProbeConfig.maxCandidatesPerPoll,
      clampInteger(underfilledBook.maxCandidatesPerPoll, baseProbeConfig.maxCandidatesPerPoll, 1, 50),
    ),
    probeConfig: {
      minRawBuys60s: Math.min(
        baseProbeConfig.minRawBuys60s,
        clampInteger(underfilledBook.minRawBuys60s, baseProbeConfig.minRawBuys60s, 1, 10_000),
      ),
      minRawBuyRatio60s: Math.min(
        baseProbeConfig.minRawBuyRatio60s,
        clampNumber(underfilledBook.minRawBuyRatio60s, baseProbeConfig.minRawBuyRatio60s, 0.5, 0.99),
      ),
      minRawSolVolume60s: Math.min(
        baseProbeConfig.minRawSolVolume60s,
        clampNumber(underfilledBook.minRawSolVolume60s, baseProbeConfig.minRawSolVolume60s, 0.1, 1_000),
      ),
      minVelocity: Math.min(
        baseProbeConfig.minVelocity,
        clampNumber(underfilledBook.minVelocity, baseProbeConfig.minVelocity, 1, 10_000),
      ),
    },
  };
}
