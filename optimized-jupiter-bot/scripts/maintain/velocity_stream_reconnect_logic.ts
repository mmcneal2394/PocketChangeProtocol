function clampNumber(value: any, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function classifyVelocityStreamError(error: any): {
  message: string;
  rateLimited: boolean;
  idleTimeout: boolean;
} {
  const message = String(error?.message || error || '').trim();
  const lowered = message.toLowerCase();
  return {
    message,
    rateLimited: lowered.includes('429') || lowered.includes('too many requests'),
    idleTimeout: lowered.includes('idle timeout') || lowered.includes('stream idle'),
  };
}

export function resolveVelocityStreamReconnectDelayMs(input: {
  attempt?: number | null;
  rateLimited?: boolean | null;
  idleTimeout?: boolean | null;
  baseMs?: number | null;
  rateLimitedBaseMs?: number | null;
  idleBaseMs?: number | null;
  maxMs?: number | null;
} = {}): number {
  const attempt = Math.max(0, Math.round(clampNumber(input.attempt, 0, 0, 12)));
  const baseMs = Math.round(clampNumber(input.baseMs, 2_000, 250, 120_000));
  const rateLimitedBaseMs = Math.round(clampNumber(input.rateLimitedBaseMs, 10_000, baseMs, 300_000));
  const idleBaseMs = Math.round(clampNumber(input.idleBaseMs, 5_000, baseMs, 300_000));
  const maxMs = Math.round(clampNumber(input.maxMs, 120_000, rateLimitedBaseMs, 600_000));
  const exponent = Math.min(attempt, 6);
  const seedBase = input.rateLimited ? rateLimitedBaseMs : input.idleTimeout ? idleBaseMs : baseMs;
  return Math.round(clampNumber(seedBase * (2 ** exponent), seedBase, seedBase, maxMs));
}

module.exports = {
  classifyVelocityStreamError,
  resolveVelocityStreamReconnectDelayMs,
};
