type MaybeNumber = number | null | undefined;

function toFiniteNumber(value: MaybeNumber, fallback = 0): number {
  const numeric = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(numeric) ? numeric : fallback;
}

interface EntryQualifierThresholdInput {
  continuationApproved?: boolean;
  buys60s?: MaybeNumber;
  buyRatio60s?: MaybeNumber;
  velocity?: MaybeNumber;
  solVolume60s?: MaybeNumber;
}

function getEntryQualifierThreshold(input: EntryQualifierThresholdInput): number {
  const continuationApproved = Boolean(input.continuationApproved);
  const buys60s = Math.max(0, toFiniteNumber(input.buys60s, 0));
  const buyRatio60s = Math.max(0, toFiniteNumber(input.buyRatio60s, 0));
  const velocity = Math.max(0, toFiniteNumber(input.velocity, 0));
  const solVolume60s = Math.max(0, toFiniteNumber(input.solVolume60s, 0));

  const cleanContinuationFlow =
    continuationApproved &&
    buyRatio60s >= 0.9 &&
    buys60s >= 9 &&
    (solVolume60s >= 2.2 || velocity >= 12);

  return cleanContinuationFlow ? 0.42 : 0.45;
}

module.exports = {
  getEntryQualifierThreshold,
};

export {};
