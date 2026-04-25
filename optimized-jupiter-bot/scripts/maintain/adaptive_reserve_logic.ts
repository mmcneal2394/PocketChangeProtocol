export interface AdaptiveReserveConfig {
  enabled: boolean;
  minReserveSol: number;
  feeBufferSol: number;
}

export interface AdaptiveReserveInput {
  nativeSol: number;
  configuredReserveSol: number;
  desiredDeploySol: number;
}

export interface AdaptiveReserveResult {
  effectiveReserveSol: number;
  deployableSol: number;
  wasClamped: boolean;
  bufferSol: number;
  minReserveSol: number;
}

export function resolveAdaptiveReserve(
  input: AdaptiveReserveInput,
  config: AdaptiveReserveConfig,
): AdaptiveReserveResult {
  const nativeSol = Number.isFinite(input.nativeSol) ? Math.max(0, input.nativeSol) : 0;
  const configuredReserveSol = Number.isFinite(input.configuredReserveSol)
    ? Math.max(0, input.configuredReserveSol)
    : 0;
  const desiredDeploySol = Number.isFinite(input.desiredDeploySol)
    ? Math.max(0, input.desiredDeploySol)
    : 0;
  const minReserveSol = Number.isFinite(config.minReserveSol) ? Math.max(0, config.minReserveSol) : 0;
  const feeBufferSol = Number.isFinite(config.feeBufferSol) ? Math.max(0, config.feeBufferSol) : 0;

  if (!config.enabled) {
    return {
      effectiveReserveSol: configuredReserveSol,
      deployableSol: Math.max(0, nativeSol - configuredReserveSol),
      wasClamped: false,
      bufferSol: feeBufferSol,
      minReserveSol,
    };
  }

  const requiredSpendSol = desiredDeploySol + feeBufferSol;
  const unclampedDeployableSol = Math.max(0, nativeSol - configuredReserveSol);
  if (unclampedDeployableSol + 1e-9 >= requiredSpendSol) {
    return {
      effectiveReserveSol: configuredReserveSol,
      deployableSol: unclampedDeployableSol,
      wasClamped: false,
      bufferSol: feeBufferSol,
      minReserveSol,
    };
  }

  const maxReserveToKeepProbeAlive = Math.max(0, nativeSol - requiredSpendSol);
  const effectiveReserveSol = Math.min(
    configuredReserveSol,
    Math.max(minReserveSol, maxReserveToKeepProbeAlive),
  );

  return {
    effectiveReserveSol,
    deployableSol: Math.max(0, nativeSol - effectiveReserveSol),
    wasClamped: effectiveReserveSol + 1e-9 < configuredReserveSol,
    bufferSol: feeBufferSol,
    minReserveSol,
  };
}
