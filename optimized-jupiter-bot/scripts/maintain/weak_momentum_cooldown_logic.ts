export function resolveWeakMomentumCooldownSeconds(input: {
  source?: string | null;
  momentum5m?: number | null;
  missingMomentum1m?: boolean | null;
  defaultCooldownSeconds?: number | null;
}): number {
  const defaultCooldownSeconds = Number.isFinite(input?.defaultCooldownSeconds)
    ? Math.max(1, Math.round(Number(input.defaultCooldownSeconds)))
    : 20;
  const source = String(input?.source || '').trim();
  const momentum5m = Number.isFinite(input?.momentum5m) ? Number(input.momentum5m) : null;
  const missingMomentum1m = input?.missingMomentum1m === true;

  if (
    source === 'gmgn-bridge' &&
    missingMomentum1m &&
    momentum5m !== null &&
    Math.abs(momentum5m) <= 0.1
  ) {
    return Math.max(defaultCooldownSeconds, 90);
  }

  return defaultCooldownSeconds;
}
