type MaybeNumber = number | null | undefined;

function toFiniteNumber(value: MaybeNumber, fallback = 0): number {
  const numeric = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface VelocityConfidenceInput {
  buys60s?: MaybeNumber;
  buyRatio60s?: MaybeNumber;
  velocity?: MaybeNumber;
  solVolume60s?: MaybeNumber;
}

interface EntryConfidenceInput {
  taConfidence?: MaybeNumber;
  buyRatio?: MaybeNumber;
  volume1hUsd?: MaybeNumber;
  buys1h?: MaybeNumber;
  velocity?: VelocityConfidenceInput | null;
}

function computeEntryConfidence(input: EntryConfidenceInput): number {
  const taConfidence = clamp(toFiniteNumber(input.taConfidence, 0), 0, 1);
  const buyRatio = Math.max(0, toFiniteNumber(input.buyRatio, 0));
  const volume1hUsd = Math.max(0, toFiniteNumber(input.volume1hUsd, 0));
  const buys1h = Math.max(0, toFiniteNumber(input.buys1h, 0));

  const structuralConfidence = Math.min(0.25, buyRatio / 10);
  const volumeBonus = volume1hUsd > 50000 ? 0.2 : 0;
  const participationBonus = buys1h > 200 ? 0.3 : 0;

  const velocity = input.velocity || {};
  const velocityFlowBonus =
    Math.max(0, toFiniteNumber(velocity.buyRatio60s, 0)) >= 0.85 &&
    Math.max(0, toFiniteNumber(velocity.buys60s, 0)) >= 12 &&
    (
      Math.max(0, toFiniteNumber(velocity.solVolume60s, 0)) >= 3 ||
      Math.max(0, toFiniteNumber(velocity.velocity, 0)) >= 14
    )
      ? 0.05
      : 0;

  return clamp(Math.max(taConfidence, structuralConfidence) + volumeBonus + participationBonus + velocityFlowBonus, 0, 1);
}

module.exports = {
  computeEntryConfidence,
};

export {};
