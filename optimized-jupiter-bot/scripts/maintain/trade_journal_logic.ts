import path from 'path';

const GHOST_SIG_PREFIX = 'PAPER_TRADE_';
const ALL_ONES_SIG = '1111111111111111111111111111111111111111111111111111111111111111';

export function uniqueJournalTargets(primaryTarget: string, extraTargets: string[]): string[] {
  const ordered = [primaryTarget, ...extraTargets];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const target of ordered) {
    const resolved = path.resolve(target);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(target);
  }

  return result;
}

export function shouldJournalOrphanRecovery(reason?: string, hasTrackedPosition = false): boolean {
  if (reason !== 'orphan-recovery') return true;
  return hasTrackedPosition;
}

export function isGhostExecutionSignature(sig?: unknown): sig is string {
  return typeof sig === 'string' && (sig.startsWith(GHOST_SIG_PREFIX) || sig === ALL_ONES_SIG);
}

export function shouldPersistTradeRecord(
  record: { action?: string; sig?: string },
  isPaperMode = process.env.PAPER_MODE === 'true',
): boolean {
  if (isPaperMode) return true;
  const action = String(record?.action || '');
  if (action !== 'BUY' && action !== 'SELL') return true;
  return !isGhostExecutionSignature(record?.sig);
}
