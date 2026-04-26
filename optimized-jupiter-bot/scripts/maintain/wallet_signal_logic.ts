export type TrackedWalletMeta = {
  address: string;
  style?: string;
  score?: number;
  weight?: number;
  source?: string;
  immediate_entry?: boolean;
  executable?: boolean;
  preferred_hold_ms?: number;
  win_rate_gmgn?: number;
  pinned?: boolean;
  notes?: string;
};

export type WalletPnlRow = {
  walletAddr: string;
  profitabilityScore?: number;
  weightedScore?: number;
  winRate?: number;
  realizedProfitUsd?: number;
  lastTimestamp?: number;
  tradeCount?: number;
  buyCount?: number;
  sellCount?: number;
  avgHoldingPeriodSec?: number;
  tokenNum?: number;
  primaryStyle?: string;
  styleProfile?: string[];
  copyabilityRisk?: string;
  preferredHoldMs?: number;
  executable?: boolean;
  immediateEntry?: boolean;
  tags?: string[];
  twitter?: string;
};

export type TokenMetadata = {
  symbol?: string;
  name?: string;
  sector?: string | null;
};

export type WalletSnapshot = {
  wallet: string;
  balances: Record<string, number>;
  timestamp: number;
};

type WalletPosition = {
  openedAt: number;
  lastBuyAt: number;
  currentBalance: number;
  symbol?: string;
};

type WalletEvent = {
  type: 'BUY' | 'SELL';
  walletAddr: string;
  mint: string;
  symbol: string;
  ts: number;
  deltaAmount: number;
  holdMs: number;
  balanceAfter: number;
};

export type WalletSignalState = {
  version: number;
  initialized: boolean;
  updatedAt: number;
  balancesByWallet: Record<string, Record<string, number>>;
  positionsByWalletMint: Record<string, WalletPosition>;
  buyEvents: WalletEvent[];
  sellEvents: WalletEvent[];
};

export type WalletSignalsDocument = {
  updated_at: number;
  hot_sector: string | null;
  sector_counts: Record<string, number>;
  buy_signals: Array<Record<string, any>>;
  sell_signals: Array<Record<string, any>>;
  wallet_pnl?: Record<string, any>;
  tracked_wallet_count: number;
};

export type WalletSignalArtifacts = {
  state: WalletSignalState;
  document: WalletSignalsDocument;
  emittedEvents: WalletEvent[];
};

const DUST_THRESHOLD = 0.000001;
const RELATIVE_CHANGE_THRESHOLD = 0.15;
const BUY_SIGNAL_WINDOW_MS = 15 * 60_000;
const SELL_SIGNAL_WINDOW_MS = 15 * 60_000;
const EVENT_RETENTION_MS = 90 * 60_000;
const NON_SIGNAL_MINTS = new Set<string>([
  'So11111111111111111111111111111111111111112',
]);

function isSignalEligibleMint(mint: string | null | undefined): boolean {
  const normalizedMint = String(mint || '').trim();
  return normalizedMint.length > 0 && !NON_SIGNAL_MINTS.has(normalizedMint);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function eventKey(walletAddr: string, mint: string): string {
  return `${walletAddr}:${mint}`;
}

function significantIncrease(prev: number, curr: number): boolean {
  if (prev <= DUST_THRESHOLD) return curr > DUST_THRESHOLD;
  const delta = curr - prev;
  return delta > DUST_THRESHOLD && delta / Math.max(prev, DUST_THRESHOLD) >= RELATIVE_CHANGE_THRESHOLD;
}

function significantDecrease(prev: number, curr: number): boolean {
  if (prev <= DUST_THRESHOLD) return false;
  if (curr <= DUST_THRESHOLD) return true;
  const delta = prev - curr;
  return delta > DUST_THRESHOLD && delta / Math.max(prev, DUST_THRESHOLD) >= RELATIVE_CHANGE_THRESHOLD;
}

function pruneBalances(balances: Record<string, number>): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [mint, amount] of Object.entries(balances || {})) {
    if (Number.isFinite(amount) && amount > DUST_THRESHOLD) next[mint] = amount;
  }
  return next;
}

function priorityRank(priority: string): number {
  switch (priority) {
    case 'VERY_HIGH': return 4;
    case 'SCALP': return 3;
    case 'HIGH': return 2;
    default: return 1;
  }
}

function logScore(value: number, max = 5): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return clamp01(Math.log10(Math.max(value, 1)) / max);
}

function riskPenalty(value: string | null | undefined): number {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'high') return 0.22;
  if (normalized === 'medium') return 0.08;
  return 0;
}

function resolveAggregateRisk(rows: WalletPnlRow[]): string {
  if (rows.some((row) => String(row.copyabilityRisk || '').toLowerCase() === 'high')) return 'high';
  if (rows.some((row) => String(row.copyabilityRisk || '').toLowerCase() === 'medium')) return 'medium';
  return 'lower';
}

function buildBuySignal(
  mint: string,
  walletEvents: WalletEvent[],
  trackedMap: Map<string, TrackedWalletMeta>,
  walletPnlMap: Map<string, WalletPnlRow>,
  tokenMetadata: Record<string, TokenMetadata>,
  now: number,
): Record<string, any> | null {
  const uniqueWalletEvents = new Map<string, WalletEvent>();
  for (const event of walletEvents) {
    const existing = uniqueWalletEvents.get(event.walletAddr);
    if (!existing || event.ts > existing.ts) uniqueWalletEvents.set(event.walletAddr, event);
  }

  const wallets = Array.from(uniqueWalletEvents.keys()).sort();
  if (wallets.length === 0) return null;

  const metas = wallets.map((wallet) => trackedMap.get(wallet) || { address: wallet });
  const pnlRows = wallets.map((wallet) => walletPnlMap.get(wallet)).filter(Boolean) as WalletPnlRow[];
  const symbol = tokenMetadata[mint]?.symbol || uniqueWalletEvents.values().next().value?.symbol || mint.slice(0, 8);
  const sector = tokenMetadata[mint]?.sector || null;
  const walletStyles = Array.from(new Set([
    ...metas.map((meta) => meta.style).filter(Boolean),
    ...pnlRows.flatMap((row) => Array.isArray(row.styleProfile) ? row.styleProfile : [row.primaryStyle]).filter(Boolean),
  ])) as string[];
  const kolCount = metas.filter((meta) => meta.style === 'KOL').length;
  const kolConfirmed = kolCount > 0 && wallets.length >= 2;

  const confidenceScores = metas.map((meta) => clamp01(Number(meta.score ?? 0.5)));
  const baseConsensusScore = confidenceScores.length
    ? Number((confidenceScores.reduce((sum, value) => sum + value, 0) / confidenceScores.length).toFixed(3))
    : 0;

  const walletPnlScore = pnlRows.length
    ? Number((pnlRows.reduce((sum, row) => sum + clamp01(Number(row.profitabilityScore ?? 0)), 0) / pnlRows.length).toFixed(3))
    : 0;
  const avgWalletWinRate = pnlRows.length
    ? Number((pnlRows.reduce((sum, row) => sum + clamp01(Number(row.winRate ?? 0)), 0) / pnlRows.length).toFixed(4))
    : 0;
  const avgWalletRealizedProfit = pnlRows.length
    ? Number((pnlRows.reduce((sum, row) => sum + Number(row.realizedProfitUsd ?? 0), 0) / pnlRows.length).toFixed(2))
    : 0;
  const topWalletRealizedProfit = pnlRows.length
    ? Number(Math.max(...pnlRows.map((row) => Number(row.realizedProfitUsd ?? 0))).toFixed(2))
    : 0;
  const topWalletLastActiveAt = pnlRows.length
    ? Math.max(...pnlRows.map((row) => Number(row.lastTimestamp ?? 0)))
    : 0;
  const walletWeightedScore = pnlRows.length
    ? Number((pnlRows.reduce((sum, row) => sum + clamp01(Number(row.weightedScore ?? row.profitabilityScore ?? 0)), 0) / pnlRows.length).toFixed(4))
    : 0;
  const walletTradeCount = pnlRows.reduce((sum, row) => sum + Math.max(0, Number(row.tradeCount || 0)), 0);
  const avgHoldingPeriodSec = pnlRows.length
    ? Number((pnlRows.reduce((sum, row) => sum + Math.max(0, Number(row.avgHoldingPeriodSec || 0)), 0) / pnlRows.length).toFixed(2))
    : 0;
  const styleDiversity = Math.max(1, walletStyles.length);
  const copyabilityRisk = resolveAggregateRisk(pnlRows);
  const styleProfileCounts = walletStyles.reduce((acc, style) => {
    acc[style] = (acc[style] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  const tradeDepthScore = logScore(walletTradeCount, 5.5);
  const holdAlignmentScore = clamp01((avgHoldingPeriodSec > 0 ? Math.min(avgHoldingPeriodSec, 6 * 60 * 60) : 0) / (6 * 60 * 60));
  const walletCompositeScore = Number(
    clamp01(
      (baseConsensusScore * 0.26) +
      (walletPnlScore * 0.22) +
      (walletWeightedScore * 0.28) +
      (avgWalletWinRate * 0.12) +
      (tradeDepthScore * 0.07) +
      (Math.min(styleDiversity, 3) / 3 * 0.05) -
      riskPenalty(copyabilityRisk),
    ).toFixed(4),
  );
  const consensusScore = Number(
    clamp01(
      (baseConsensusScore * 0.7) +
      (walletWeightedScore * 0.2) +
      (avgWalletWinRate * 0.1),
    ).toFixed(3),
  );

  const executableWallets = metas.filter((meta) => meta.executable);
  const immediateWallets = metas.filter((meta) => meta.executable && meta.immediate_entry);
  const preferredHoldMs = metas
    .map((meta) => Number(meta.preferred_hold_ms ?? 0))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)[0] || 5 * 60_000;

  let executable = false;
  let sizeUp = false;
  let priority = 'INFO';
  let conviction = 'NORMAL';
  let triggerReason = 'watch-only wallet movement';

  if (executableWallets.length >= 2) {
    executable = true;
    sizeUp = consensusScore >= 0.78 || walletPnlScore >= 0.7 || walletCompositeScore >= 0.74;
    priority = sizeUp ? 'VERY_HIGH' : 'HIGH';
    conviction = 'HIGH';
    triggerReason = 'multiple executable wallets aligned';
  } else if (immediateWallets.length >= 1 && (consensusScore >= 0.72 || walletCompositeScore >= 0.7)) {
    executable = true;
    priority = 'SCALP';
    conviction = 'HIGH';
    triggerReason = 'immediate-entry wallet detected fresh buy';
  } else if (executableWallets.length >= 1 && (wallets.length >= 2 || kolConfirmed)) {
    executable = true;
    priority = 'HIGH';
    conviction = 'HIGH';
    triggerReason = kolConfirmed ? 'executable wallet buy confirmed by KOL flow' : 'executable wallet buy confirmed by second wallet';
  } else if (executableWallets.length >= 1) {
    triggerReason = (walletStyles.includes('SWING') || walletStyles.includes('PROBATION'))
      ? 'single executable wallet needs confirmation'
      : 'single executable wallet watch';
  } else if (kolCount > 0) {
    triggerReason = 'KOL-only flow requires executable confirmation';
  }

  if (!executable && wallets.length >= 2 && walletCompositeScore >= 0.78 && copyabilityRisk !== 'high') {
    executable = true;
    priority = sizeUp ? priority : 'HIGH';
    conviction = 'HIGH';
    triggerReason = 'weighted wallet cluster quality override';
  }

  if (copyabilityRisk === 'high') {
    executable = false;
    sizeUp = false;
    priority = 'INFO';
    conviction = 'NORMAL';
    triggerReason = 'wallet cluster flagged as hard-to-copy';
  }

  const firstSeenMs = Math.min(...Array.from(uniqueWalletEvents.values()).map((event) => event.ts));
  const lastSeenMs = Math.max(...Array.from(uniqueWalletEvents.values()).map((event) => event.ts));
  const swapSolAmount = Number(
    Array.from(uniqueWalletEvents.values()).reduce((sum, event) => sum + Number(event.deltaAmount || 0), 0).toFixed(9),
  );

  return {
    type: 'BUY',
    mint,
    symbol,
    sector,
    wallets,
    walletStyles,
    kolCount,
    kolConfirmed,
    firstSeenMs,
    lastSeenMs,
    conviction,
    sizeUp,
    swapSolAmount,
    consensusScore,
    walletCompositeScore,
    walletWeightedScore,
    walletPnlScore,
    walletTradeCount,
    avgWalletWinRate,
    avgWalletRealizedProfit,
    topWalletRealizedProfit,
    topWalletLastActiveAt,
    avgHoldingPeriodSec,
    holdAlignmentScore,
    copyabilityRisk,
    styleProfileCounts,
    executable,
    priority,
    strategyHint: walletStyles[0] || 'MIXED',
    preferredHoldMs,
    triggerReason,
    expired: now - lastSeenMs > BUY_SIGNAL_WINDOW_MS,
  };
}

function buildSellSignals(events: WalletEvent[], now: number): Array<Record<string, any>> {
  return events
    .filter((event) => now - event.ts <= SELL_SIGNAL_WINDOW_MS)
    .map((event) => ({
      type: 'SELL',
      mint: event.mint,
      symbol: event.symbol,
      walletAddr: event.walletAddr,
      holdMs: event.holdMs,
      soldAt: event.ts,
      expired: false,
    }))
    .sort((a, b) => b.soldAt - a.soldAt);
}

export function createEmptyWalletSignalState(now: number): WalletSignalState {
  return {
    version: 1,
    initialized: false,
    updatedAt: now,
    balancesByWallet: {},
    positionsByWalletMint: {},
    buyEvents: [],
    sellEvents: [],
  };
}

export function buildWalletSignalArtifacts(args: {
  state?: WalletSignalState | null;
  snapshots: WalletSnapshot[];
  trackedWallets: TrackedWalletMeta[];
  walletPnlRows?: WalletPnlRow[];
  tokenMetadata?: Record<string, TokenMetadata>;
  walletPnlSummary?: Record<string, any>;
  now?: number;
}): WalletSignalArtifacts {
  const now = Number(args.now ?? Date.now());
  const trackedWallets = args.trackedWallets || [];
  const trackedSet = new Set(trackedWallets.map((meta) => meta.address));
  const trackedMap = new Map(trackedWallets.map((meta) => [meta.address, meta]));
  const walletPnlMap = new Map((args.walletPnlRows || []).map((row) => [row.walletAddr, row]));
  const tokenMetadata = args.tokenMetadata || {};
  const previousState = args.state || createEmptyWalletSignalState(now);

  const nextState: WalletSignalState = {
    version: 1,
    initialized: previousState.initialized,
    updatedAt: now,
    balancesByWallet: { ...previousState.balancesByWallet },
    positionsByWalletMint: { ...previousState.positionsByWalletMint },
    buyEvents: [...(previousState.buyEvents || [])],
    sellEvents: [...(previousState.sellEvents || [])],
  };

  const emittedEvents: WalletEvent[] = [];

  if (!previousState.initialized) {
    for (const snapshot of args.snapshots) {
      nextState.balancesByWallet[snapshot.wallet] = pruneBalances(snapshot.balances || {});
      for (const [mint, balance] of Object.entries(nextState.balancesByWallet[snapshot.wallet])) {
        nextState.positionsByWalletMint[eventKey(snapshot.wallet, mint)] = {
          openedAt: now,
          lastBuyAt: now,
          currentBalance: balance,
          symbol: tokenMetadata[mint]?.symbol || mint.slice(0, 8),
        };
      }
    }
    nextState.initialized = true;
  } else {
    for (const snapshot of args.snapshots) {
      const previousBalances = previousState.balancesByWallet[snapshot.wallet] || {};
      const currentBalances = pruneBalances(snapshot.balances || {});
      const mintSet = new Set<string>([
        ...Object.keys(previousBalances),
        ...Object.keys(currentBalances),
      ]);

      for (const mint of Array.from(mintSet)) {
        if (!isSignalEligibleMint(mint)) continue;
        const prev = Number(previousBalances[mint] || 0);
        const curr = Number(currentBalances[mint] || 0);
        const key = eventKey(snapshot.wallet, mint);
        const symbol = tokenMetadata[mint]?.symbol || mint.slice(0, 8);

        if (significantIncrease(prev, curr)) {
          const event: WalletEvent = {
            type: 'BUY',
            walletAddr: snapshot.wallet,
            mint,
            symbol,
            ts: snapshot.timestamp || now,
            deltaAmount: Number((curr - prev).toFixed(9)),
            holdMs: 0,
            balanceAfter: curr,
          };
          emittedEvents.push(event);
          nextState.buyEvents.push(event);
          const existing = nextState.positionsByWalletMint[key];
          nextState.positionsByWalletMint[key] = {
            openedAt: existing?.openedAt || event.ts,
            lastBuyAt: event.ts,
            currentBalance: curr,
            symbol,
          };
        } else if (significantDecrease(prev, curr)) {
          const openedAt = nextState.positionsByWalletMint[key]?.openedAt || now;
          const event: WalletEvent = {
            type: 'SELL',
            walletAddr: snapshot.wallet,
            mint,
            symbol,
            ts: snapshot.timestamp || now,
            deltaAmount: Number((prev - curr).toFixed(9)),
            holdMs: Math.max(0, (snapshot.timestamp || now) - openedAt),
            balanceAfter: curr,
          };
          emittedEvents.push(event);
          nextState.sellEvents.push(event);

          if (curr <= DUST_THRESHOLD) {
            delete nextState.positionsByWalletMint[key];
          } else {
            nextState.positionsByWalletMint[key] = {
              openedAt,
              lastBuyAt: nextState.positionsByWalletMint[key]?.lastBuyAt || openedAt,
              currentBalance: curr,
              symbol,
            };
          }
        } else if (curr > DUST_THRESHOLD) {
          const existing = nextState.positionsByWalletMint[key];
          nextState.positionsByWalletMint[key] = {
            openedAt: existing?.openedAt || now,
            lastBuyAt: existing?.lastBuyAt || now,
            currentBalance: curr,
            symbol,
          };
        } else {
          delete nextState.positionsByWalletMint[key];
        }
      }

      nextState.balancesByWallet[snapshot.wallet] = currentBalances;
    }
  }

  for (const wallet of Object.keys(nextState.balancesByWallet)) {
    if (!trackedSet.has(wallet)) delete nextState.balancesByWallet[wallet];
  }

  for (const key of Object.keys(nextState.positionsByWalletMint)) {
    const wallet = key.split(':', 1)[0];
    if (!trackedSet.has(wallet)) delete nextState.positionsByWalletMint[key];
  }

  nextState.buyEvents = nextState.buyEvents.filter((event) => trackedSet.has(event.walletAddr) && now - event.ts <= EVENT_RETENTION_MS);
  nextState.sellEvents = nextState.sellEvents.filter((event) => trackedSet.has(event.walletAddr) && now - event.ts <= EVENT_RETENTION_MS);

  const recentBuyEvents = nextState.buyEvents.filter((event) => now - event.ts <= BUY_SIGNAL_WINDOW_MS);
  const groupedByMint = new Map<string, WalletEvent[]>();
  for (const event of recentBuyEvents) {
    if (!isSignalEligibleMint(event.mint)) continue;
    const liveBalance = nextState.balancesByWallet[event.walletAddr]?.[event.mint] || 0;
    if (liveBalance <= DUST_THRESHOLD) continue;
    const current = groupedByMint.get(event.mint) || [];
    current.push(event);
    groupedByMint.set(event.mint, current);
  }

  const buySignals = Array.from(groupedByMint.entries())
    .map(([mint, events]) => buildBuySignal(mint, events, trackedMap, walletPnlMap, tokenMetadata, now))
    .filter(Boolean) as Array<Record<string, any>>;

  buySignals.sort((left, right) => {
    const rankDiff = priorityRank(right.priority) - priorityRank(left.priority);
    if (rankDiff !== 0) return rankDiff;
    const execDiff = Number(Boolean(right.executable)) - Number(Boolean(left.executable));
    if (execDiff !== 0) return execDiff;
    const sizeDiff = Number(Boolean(right.sizeUp)) - Number(Boolean(left.sizeUp));
    if (sizeDiff !== 0) return sizeDiff;
    const consensusDiff = Number(right.consensusScore || 0) - Number(left.consensusScore || 0);
    if (consensusDiff !== 0) return consensusDiff;
    return Number(right.walletPnlScore || 0) - Number(left.walletPnlScore || 0);
  });

  const sellSignals = buildSellSignals(
    nextState.sellEvents.filter((event) => isSignalEligibleMint(event.mint)),
    now,
  );
  const sectorCounts: Record<string, number> = {};
  for (const signal of buySignals) {
    if (!signal.sector) continue;
    sectorCounts[signal.sector] = (sectorCounts[signal.sector] || 0) + 1;
  }

  const hotSector = Object.entries(sectorCounts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  return {
    state: nextState,
    emittedEvents,
    document: {
      updated_at: now,
      hot_sector: hotSector,
      sector_counts: sectorCounts,
      buy_signals: buySignals,
      sell_signals: sellSignals,
      wallet_pnl: args.walletPnlSummary,
      tracked_wallet_count: trackedWallets.length,
    },
  };
}
