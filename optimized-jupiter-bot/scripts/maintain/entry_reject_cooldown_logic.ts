export interface EntryRejectCooldownConfig {
  enabled: boolean;
  buyRatioCooldownSeconds: number;
  buysBelowCooldownSeconds: number;
  strongFlowBuyRatioCooldownSeconds: number;
  strongFlowBuysBelowCooldownSeconds: number;
  minStrongFlowBuys60s: number;
  minStrongFlowSolVolume60s: number;
  minStrongFlowVelocity: number;
}

export interface EntryRejectFlowContext {
  buys60s?: number | null;
  solVolume60s?: number | null;
  velocity?: number | null;
}

export type EntryRejectReason = 'buy_ratio' | 'buys_below_threshold';

function clampNumber(value: any, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function finiteNumber(value: any, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

export function normalizeEntryRejectCooldownConfig(raw: any): EntryRejectCooldownConfig {
  return {
    enabled: raw?.enabled !== false,
    buyRatioCooldownSeconds: Math.round(clampNumber(raw?.buyRatioCooldownSeconds, 12, 0, 300)),
    buysBelowCooldownSeconds: Math.round(clampNumber(raw?.buysBelowCooldownSeconds, 10, 0, 300)),
    strongFlowBuyRatioCooldownSeconds: Math.round(clampNumber(raw?.strongFlowBuyRatioCooldownSeconds, 6, 0, 120)),
    strongFlowBuysBelowCooldownSeconds: Math.round(clampNumber(raw?.strongFlowBuysBelowCooldownSeconds, 5, 0, 120)),
    minStrongFlowBuys60s: Math.round(clampNumber(raw?.minStrongFlowBuys60s, 8, 1, 500)),
    minStrongFlowSolVolume60s: clampNumber(raw?.minStrongFlowSolVolume60s, 1.5, 0.1, 100),
    minStrongFlowVelocity: clampNumber(raw?.minStrongFlowVelocity, 8, 1, 500),
  };
}

export function isStrongFlowRejectContext(
  flow: EntryRejectFlowContext,
  config: EntryRejectCooldownConfig,
): boolean {
  const buys60s = finiteNumber(flow?.buys60s, 0);
  const solVolume60s = finiteNumber(flow?.solVolume60s, 0);
  const velocity = finiteNumber(flow?.velocity, 0);
  return (
    buys60s >= config.minStrongFlowBuys60s &&
    solVolume60s >= config.minStrongFlowSolVolume60s &&
    velocity >= config.minStrongFlowVelocity
  );
}

export function getEntryRejectCooldownSeconds(
  reason: EntryRejectReason,
  flow: EntryRejectFlowContext,
  config: EntryRejectCooldownConfig,
): number {
  if (!config.enabled) return 0;
  const strongFlow = isStrongFlowRejectContext(flow, config);
  if (reason === 'buy_ratio') {
    return strongFlow ? config.strongFlowBuyRatioCooldownSeconds : config.buyRatioCooldownSeconds;
  }
  return strongFlow ? config.strongFlowBuysBelowCooldownSeconds : config.buysBelowCooldownSeconds;
}
