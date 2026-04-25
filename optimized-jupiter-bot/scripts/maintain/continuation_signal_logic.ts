type MaybeNumber = number | null | undefined;

function toFiniteNumberOrNull(value: any): number | null {
  const numeric = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function readOptionalDexMetric(container: any, key: string): number | null {
  if (!container || typeof container !== 'object' || !(key in container)) return null;
  return toFiniteNumberOrNull(container[key]);
}

interface ContinuationSignalInput {
  momentum1m?: MaybeNumber;
  minMomentum1mPct?: MaybeNumber;
  buys60s?: MaybeNumber;
  buyRatio60s?: MaybeNumber;
  velocity?: MaybeNumber;
  solVolume60s?: MaybeNumber;
  mode?: 'default' | 'velocity';
  terrainSampleCount?: MaybeNumber;
  terrainStrongFlowSamples?: MaybeNumber;
  terrainFlowDecayRatio?: MaybeNumber;
  terrainPriceOffPeak5m?: MaybeNumber;
  terrainCurrentPriceChange5m?: MaybeNumber;
}

interface ContinuationSignalDecision {
  momentum1m: number | null;
  threshold: number;
  confirmedByMomentum: boolean;
  flowContinuation: boolean;
  terrainContinuation: boolean;
  fallbackSource: 'flow-fallback' | 'terrain-flow-fallback' | null;
  usingFlowFallback: boolean;
  hasContinuation: boolean;
  missingMomentum1m: boolean;
  displayMomentum1m: number;
}

function evaluateContinuationSignal(input: ContinuationSignalInput): ContinuationSignalDecision {
  const momentum1m = toFiniteNumberOrNull(input.momentum1m);
  const threshold = Math.max(0, toFiniteNumberOrNull(input.minMomentum1mPct) ?? 0.5);
  const buys60s = Math.max(0, toFiniteNumberOrNull(input.buys60s) ?? 0);
  const buyRatio60s = Math.max(0, toFiniteNumberOrNull(input.buyRatio60s) ?? 0);
  const velocity = Math.max(0, toFiniteNumberOrNull(input.velocity) ?? 0);
  const solVolume60s = Math.max(0, toFiniteNumberOrNull(input.solVolume60s) ?? 0);
  const terrainSampleCount = Math.max(0, toFiniteNumberOrNull(input.terrainSampleCount) ?? 0);
  const terrainStrongFlowSamples = Math.max(0, toFiniteNumberOrNull(input.terrainStrongFlowSamples) ?? 0);
  const terrainFlowDecayRatio = toFiniteNumberOrNull(input.terrainFlowDecayRatio);
  const terrainPriceOffPeak5m = Math.max(0, toFiniteNumberOrNull(input.terrainPriceOffPeak5m) ?? 0);
  const terrainCurrentPriceChange5m = toFiniteNumberOrNull(input.terrainCurrentPriceChange5m) ?? 0;
  const velocityMode = input.mode === 'velocity';

  const whaleFlow = solVolume60s >= 8 && buys60s >= 10 && buyRatio60s >= 0.82;
  const strongFlow = buys60s >= 14 && buyRatio60s >= 0.8 && (solVolume60s >= 3 || velocity >= 18);
  const moderateFlow = velocityMode
    ? buys60s >= 12 && buyRatio60s >= 0.82 && (solVolume60s >= 1.75 || velocity >= 12)
    : buys60s >= 10 && buyRatio60s >= 0.75 && (solVolume60s >= 2 || velocity >= 14);
  const highConvictionVelocityFlow = velocityMode &&
    buys60s >= 12 &&
    buyRatio60s >= 0.8 &&
    solVolume60s >= 6 &&
    velocity >= 14;
  const softVelocityFlow = velocityMode && buyRatio60s >= 0.9 && (
    (buys60s >= 10 && solVolume60s >= 1.5) ||
    (buys60s >= 9 && solVolume60s >= 2.2 && velocity >= 10) ||
    (buys60s >= 9 && solVolume60s >= 3.5 && velocity >= 8)
  );
  const repeatedTerrainFlow = velocityMode &&
    momentum1m === null &&
    buys60s >= 8 &&
    buyRatio60s >= 0.9 &&
    velocity >= 8 &&
    solVolume60s >= 1.25 &&
    terrainSampleCount >= 2 &&
    (terrainStrongFlowSamples >= 1 || terrainSampleCount >= 3) &&
    terrainPriceOffPeak5m <= 2.5 &&
    terrainCurrentPriceChange5m >= -0.25 &&
    (terrainFlowDecayRatio === null || terrainFlowDecayRatio >= 0.75);
  const rawFlowContinuation = whaleFlow || strongFlow || moderateFlow || highConvictionVelocityFlow || softVelocityFlow;
  const flowContinuation = rawFlowContinuation || repeatedTerrainFlow;
  const confirmedByMomentum = momentum1m !== null && momentum1m >= threshold;
  const fallbackSource =
    momentum1m === null
      ? (repeatedTerrainFlow ? 'terrain-flow-fallback' : (rawFlowContinuation ? 'flow-fallback' : null))
      : null;
  const usingFlowFallback = momentum1m === null && fallbackSource !== null;

  return {
    momentum1m,
    threshold,
    confirmedByMomentum,
    flowContinuation,
    terrainContinuation: repeatedTerrainFlow,
    fallbackSource,
    usingFlowFallback,
    hasContinuation: confirmedByMomentum || usingFlowFallback,
    missingMomentum1m: momentum1m === null,
    displayMomentum1m: momentum1m ?? 0,
  };
}

module.exports = {
  toFiniteNumberOrNull,
  readOptionalDexMetric,
  evaluateContinuationSignal,
};

export {};
