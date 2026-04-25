function normalizeMessage(value: any): string {
  return String(value || '').trim();
}

function collectCustomCodes(value: any, bucket: Set<number>) {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    const hexMatches = value.match(/0x([0-9a-f]+)/gi) || [];
    for (const match of hexMatches) {
      const parsed = parseInt(match.slice(2), 16);
      if (Number.isFinite(parsed)) bucket.add(parsed);
    }
    const numberMatch = value.match(/Error Number:\s*(\d+)/i);
    if (numberMatch) {
      const parsed = Number(numberMatch[1]);
      if (Number.isFinite(parsed)) bucket.add(parsed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCustomCodes(item, bucket);
    return;
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === 'Custom') {
        const parsed = Number(item);
        if (Number.isFinite(parsed)) bucket.add(parsed);
      }
      collectCustomCodes(item, bucket);
    }
  }
}

function extractPrimaryCustomCode(...values: any[]): number | null {
  const bucket = new Set<number>();
  for (const value of values) collectCustomCodes(value, bucket);
  const [first] = [...bucket];
  return Number.isFinite(first) ? first : null;
}

function joinLogs(logs?: string[] | null): string {
  return Array.isArray(logs) ? logs.join(' | ') : '';
}

export type ExitSwapFailureMeta = {
  category: string;
  code: number | null;
  detail: string;
  retryable: boolean;
  cooldownMs: number;
};

export function classifyExitSwapFailure(args: {
  simulationErr?: any;
  simulationLogs?: string[] | null;
  statusErr?: any;
  expired?: boolean;
  providerLimited?: boolean;
  message?: string;
}): ExitSwapFailureMeta {
  const detail = [
    normalizeMessage(args.message),
    normalizeMessage(JSON.stringify(args.simulationErr || args.statusErr || null)),
    joinLogs(args.simulationLogs),
  ].filter(Boolean).join(' | ');
  const code = extractPrimaryCustomCode(args.simulationErr, args.statusErr, detail);

  if (args.providerLimited === true) {
    return {
      category: 'rpc_capacity',
      code,
      detail: detail || 'provider capacity error',
      retryable: true,
      cooldownMs: 30_000,
    };
  }

  if (args.expired === true) {
    return {
      category: 'route_expired',
      code,
      detail: detail || 'transaction expired before confirmation',
      retryable: true,
      cooldownMs: 90_000,
    };
  }

  if (code === 6024 || /overflow/i.test(detail)) {
    return {
      category: 'route_overflow',
      code,
      detail: detail || 'overflow during route simulation',
      retryable: true,
      cooldownMs: 15 * 60_000,
    };
  }

  if (code === 6001 || /slippage/i.test(detail)) {
    return {
      category: 'route_slippage',
      code,
      detail: detail || 'slippage rejection during route execution',
      retryable: true,
      cooldownMs: 10 * 60_000,
    };
  }

  if (/rate.?limit/i.test(detail)) {
    return {
      category: 'rate_limited',
      code,
      detail: detail || 'rate limited during route execution',
      retryable: true,
      cooldownMs: 60_000,
    };
  }

  if (/no route|token not tradable/i.test(detail)) {
    return {
      category: 'route_missing',
      code,
      detail: detail || 'no route available',
      retryable: true,
      cooldownMs: 10 * 60_000,
    };
  }

  return {
    category: args.statusErr ? 'submission_failed' : 'simulation_failed',
    code,
    detail: detail || 'unclassified swap failure',
    retryable: true,
    cooldownMs: 5 * 60_000,
  };
}

export function resolveExitRetryCooldownMs(
  failureMeta: ExitSwapFailureMeta | null | undefined,
  failureCount: number,
  fallbackCooldownMs: number,
): number {
  const baseCooldownMs = Math.max(5_000, Number(failureMeta?.cooldownMs || fallbackCooldownMs || 120_000));
  const escalatedCooldownMs = baseCooldownMs + (Math.max(0, Number(failureCount || 0) - 1) * Math.max(60_000, Math.round(baseCooldownMs * 0.5)));
  return Math.min(45 * 60_000, escalatedCooldownMs);
}

module.exports = {
  classifyExitSwapFailure,
  resolveExitRetryCooldownMs,
};
