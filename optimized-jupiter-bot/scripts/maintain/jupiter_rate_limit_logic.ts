function clampNumber(value: any, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function parseRetryAfterMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const absoluteMs = Date.parse(trimmed);
  if (!Number.isFinite(absoluteMs)) return null;
  return Math.max(0, absoluteMs - Date.now());
}

export function resolveJupiterRateLimitBackoffMs(input: {
  retryAfterHeader?: string | null;
  strikeCount?: number | null;
  minBackoffMs?: number | null;
  maxBackoffMs?: number | null;
} = {}): number {
  const minBackoffMs = Math.round(clampNumber(input.minBackoffMs, 2_000, 250, 120_000));
  const maxBackoffMs = Math.round(clampNumber(input.maxBackoffMs, 20_000, minBackoffMs, 300_000));
  const headerBackoffMs = parseRetryAfterMs(input.retryAfterHeader);
  if (headerBackoffMs !== null) {
    return Math.round(clampNumber(headerBackoffMs, minBackoffMs, minBackoffMs, maxBackoffMs));
  }
  const strikeCount = Math.max(0, Math.round(clampNumber(input.strikeCount, 0, 0, 12)));
  const exponent = Math.min(strikeCount, 6);
  return Math.round(clampNumber(minBackoffMs * (2 ** exponent), minBackoffMs, minBackoffMs, maxBackoffMs));
}

export function getJupiterRateLimitRemainingMs(untilMs: number | null | undefined, nowMs = Date.now()): number {
  const until = Number.isFinite(untilMs) ? Number(untilMs) : 0;
  return Math.max(0, until - nowMs);
}

export function isJupiterRateLimitActive(untilMs: number | null | undefined, nowMs = Date.now()): boolean {
  return getJupiterRateLimitRemainingMs(untilMs, nowMs) > 0;
}

module.exports = {
  parseRetryAfterMs,
  resolveJupiterRateLimitBackoffMs,
  getJupiterRateLimitRemainingMs,
  isJupiterRateLimitActive,
};
