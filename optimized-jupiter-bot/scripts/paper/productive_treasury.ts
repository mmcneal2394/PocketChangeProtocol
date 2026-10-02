export type ProductiveDecision = 'paper_eligible' | 'watch_only';

export interface ProductivePolicy {
  maxSourceAgeMs: number;
  minCompletedPayoutCycles: number;
  minRecordDays: number;
  minProjectScore: number;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  minHolders: number;
  maxRoundTripLossPct: number;
  maxProjectWeightPct: number;
  productiveTokenBudgetPct: number;
  reserveFloorPct: number;
  buybackCapPct: number;
}

export interface ProductiveCandidate {
  mint: string;
  symbol: string;
  name: string;
  sourceId: string;
  sourceKind: string;
  observedAt: number;
  payout: {
    assets: Array<{ mint: string; symbol: string; category?: string; issuer?: string }>;
    completedCycles: number;
    recordDays: number;
    receiptsVerified: boolean;
    allRecordedClaimsLanded?: boolean;
    lastPayoutAt?: number | null;
  };
  protocol?: {
    projectScore?: number;
    autonomyScore?: number;
    firewallPass?: boolean;
  };
  treasury?: {
    valueUsd?: number;
    totalFeesClaimedSol?: number;
  };
  raw?: unknown;
}

export interface ProductiveSourceSnapshot {
  schemaVersion: 'pcp-productive-source/v1';
  sourceId: string;
  sourceKind: string;
  observedAt: number;
  status: 'fresh' | 'stale' | 'error';
  detail?: string;
  candidates: ProductiveCandidate[];
}

export interface ProductiveMarketEvidence {
  observedAt: number;
  mintVerified: boolean;
  mintIssue?: string | null;
  decimals?: number | null;
  liquidityUsd?: number | null;
  volume24hUsd?: number | null;
  holders?: number | null;
  marketCapUsd?: number | null;
  roundTripLossPct?: number | null;
  buyRoute?: string[];
  sellRoute?: string[];
  gmgn?: {
    address: string;
    symbol: string;
    name: string;
    launchpad: string | null;
    launchpadPlatform: string | null;
    launchpadStatus: number | null;
    priceUsd: number | null;
    athPriceUsd: number | null;
    activity: Record<string, number | null>;
    fees: {
      tradeFee: number | null;
      totalFee: number | null;
      distributionLaunchpad: string | null;
      bonusCategories: string[];
      locked: boolean | null;
      charity: boolean | null;
      recipientCount: number;
      claimedRecipientCount: number;
    };
    pool: {
      address: string | null;
      exchange: string | null;
      quoteMint: string | null;
      quoteSymbol: string | null;
    };
    holderRisk: Record<string, number | null>;
    links: Record<string, unknown>;
    providerPayload: { info: unknown };
  };
  issue?: string | null;
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegative(value: unknown): number {
  return Math.max(0, finite(value) ?? 0);
}

function candidateKey(candidate: ProductiveCandidate): string {
  return String(candidate.mint || '');
}

export function validateProductiveSource(value: any): ProductiveSourceSnapshot {
  if (value?.schemaVersion !== 'pcp-productive-source/v1') throw new Error('invalid_productive_source_schema');
  if (typeof value.sourceId !== 'string' || !value.sourceId || typeof value.sourceKind !== 'string' || !value.sourceKind) throw new Error('invalid_productive_source_identity');
  if (!Number.isSafeInteger(value.observedAt) || !Array.isArray(value.candidates)) throw new Error('invalid_productive_source_payload');
  for (const candidate of value.candidates) {
    if (typeof candidate?.mint !== 'string' || typeof candidate?.symbol !== 'string' || !candidate?.payout || !Array.isArray(candidate.payout.assets)) {
      throw new Error('invalid_productive_candidate');
    }
  }
  return value as ProductiveSourceSnapshot;
}

export function mergeProductiveSources(sources: ProductiveSourceSnapshot[]): ProductiveCandidate[] {
  const merged = new Map<string, ProductiveCandidate>();
  for (const source of sources) {
    for (const candidate of source.candidates) {
      const key = candidateKey(candidate);
      const current = merged.get(key);
      if (!current || candidate.observedAt > current.observedAt || candidate.payout.completedCycles > current.payout.completedCycles) {
        merged.set(key, candidate);
      }
    }
  }
  return [...merged.values()];
}

export function evaluateProductiveCandidate(
  candidate: ProductiveCandidate,
  market: ProductiveMarketEvidence | undefined,
  policy: ProductivePolicy,
  now: number,
) {
  const issues: string[] = [];
  if (!Number.isSafeInteger(candidate.observedAt) || now - candidate.observedAt > policy.maxSourceAgeMs) issues.push('source_stale');
  if (!candidate.payout.receiptsVerified) issues.push('payout_receipts_unverified');
  if (candidate.payout.allRecordedClaimsLanded === false) issues.push('recorded_claim_failure');
  if (nonNegative(candidate.payout.completedCycles) < policy.minCompletedPayoutCycles) issues.push('insufficient_payout_cycles');
  if (nonNegative(candidate.payout.recordDays) < policy.minRecordDays) issues.push('insufficient_record_days');
  if (nonNegative(candidate.protocol?.projectScore) < policy.minProjectScore) issues.push('project_score_below_floor');
  if (candidate.protocol?.firewallPass === false) issues.push('protocol_firewall_unverified');
  if (!candidate.payout.assets.length || candidate.payout.assets.some(asset => !asset.mint || !asset.symbol)) issues.push('distribution_assets_unverified');
  if (!market) issues.push('market_evidence_missing');
  else {
    if (now - market.observedAt > policy.maxSourceAgeMs) issues.push('market_evidence_stale');
    if (!market.mintVerified) issues.push(market.mintIssue || 'mint_unverified');
    if (nonNegative(market.liquidityUsd) < policy.minLiquidityUsd) issues.push('liquidity_below_floor');
    if (nonNegative(market.volume24hUsd) < policy.minVolume24hUsd) issues.push('volume_below_floor');
    if (nonNegative(market.holders) < policy.minHolders) issues.push('holders_below_floor');
    if (market.roundTripLossPct == null) issues.push('round_trip_quote_missing');
    else if (market.roundTripLossPct > policy.maxRoundTripLossPct) issues.push('round_trip_cost_above_cap');
    if (market.issue) issues.push(`market:${market.issue}`);
  }
  const score = Math.max(0, 100
    - issues.filter(issue => issue.includes('unverified') || issue.includes('failure')).length * 25
    - issues.filter(issue => issue.includes('insufficient') || issue.includes('below_floor')).length * 12
    - issues.filter(issue => issue.includes('missing') || issue.includes('stale')).length * 8
    - issues.filter(issue => issue.includes('cost_above')).length * 15);
  return {
    ...candidate,
    market: market || null,
    decision: (issues.length ? 'watch_only' : 'paper_eligible') as ProductiveDecision,
    issues,
    score,
    targetWeightPct: 0,
  };
}

export function buildProductiveTreasurySnapshot(input: {
  sources: ProductiveSourceSnapshot[];
  marketsByMint: Record<string, ProductiveMarketEvidence>;
  policy: ProductivePolicy;
  generatedAt: number;
}) {
  const candidates = mergeProductiveSources(input.sources)
    .map(candidate => evaluateProductiveCandidate(candidate, input.marketsByMint[candidate.mint], input.policy, input.generatedAt))
    .sort((a, b) => Number(b.decision === 'paper_eligible') - Number(a.decision === 'paper_eligible') || b.score - a.score);
  const eligible = candidates.filter(candidate => candidate.decision === 'paper_eligible');
  const payoutClasses = candidates.reduce<Record<string, number>>((classes, candidate) => {
    for (const asset of candidate.payout.assets) {
      const category = String(asset.category || 'unclassified');
      classes[category] = (classes[category] || 0) + 1;
    }
    return classes;
  }, {});
  const targetWeight = eligible.length
    ? Math.min(input.policy.maxProjectWeightPct, input.policy.productiveTokenBudgetPct / eligible.length)
    : 0;
  for (const candidate of eligible) candidate.targetWeightPct = targetWeight;
  return {
    schemaVersion: 'pcp-productive-treasury/v1',
    generatedAt: input.generatedAt,
    execution: { mode: 'paper_only', signing: 'disabled', broadcasting: 'disabled' },
    policy: input.policy,
    coverage: {
      configuredSources: input.sources.length,
      freshSources: input.sources.filter(source => source.status === 'fresh' && input.generatedAt - source.observedAt <= input.policy.maxSourceAgeMs).length,
      candidates: candidates.length,
      eligible: eligible.length,
      payoutClasses,
      cryptoPayoutCandidates: candidates.filter(candidate => candidate.payout.assets.some(asset =>
        ['wrapped-native-crypto', 'crypto-representation'].includes(String(asset.category)),
      )).length,
    },
    sources: input.sources.map(source => ({ sourceId: source.sourceId, sourceKind: source.sourceKind, status: source.status, observedAt: source.observedAt, detail: source.detail || '' })),
    candidates,
    allocation: {
      status: 'awaiting_reconciled_fee_input',
      productiveTokenBudgetPct: input.policy.productiveTokenBudgetPct,
      reserveFloorPct: input.policy.reserveFloorPct,
      buybackCapPct: input.policy.buybackCapPct,
      allocatedPct: eligible.length * targetWeight,
      unallocatedProductivePct: Math.max(0, input.policy.productiveTokenBudgetPct - eligible.length * targetWeight),
      note: 'Weights are paper targets only. No fee balance, order, signature, or transaction is created.',
    },
  };
}

