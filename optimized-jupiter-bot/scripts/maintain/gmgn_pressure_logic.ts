export function normalizeGmgnMessage(message: string): string {
  return String(message || '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, '\n')
    .trim();
}

export function isGmgnTemporaryBanMessage(message: string): boolean {
  return /temporarily banned|rate limit violations|rate_limit_banned/i.test(normalizeGmgnMessage(message));
}

export function isGmgnRateLimitMessage(message: string): boolean {
  return /(?:^|[\s:])429(?:$|[\s:])|too many requests|rate[_ -]?limit/i.test(normalizeGmgnMessage(message));
}

export function getGmgnBanWaitMs(
  message: string,
  fallbackMs: number,
): number {
  const match = normalizeGmgnMessage(message).match(/~(\d+)s remaining/i);
  if (match) {
    const seconds = Number(match[1]);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(5_000, (seconds + 2) * 1_000);
    }
  }
  return Math.max(5_000, Number.isFinite(fallbackMs) ? fallbackMs : 0);
}

export function computeGmgnBanUntilMs(
  message: string,
  fallbackMs: number,
  now = Date.now(),
): number {
  return now + getGmgnBanWaitMs(message, fallbackMs);
}
