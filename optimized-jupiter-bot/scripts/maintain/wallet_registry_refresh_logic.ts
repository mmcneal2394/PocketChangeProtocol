type JsonObject = Record<string, any>;

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
  notes?: string;
};

type RefreshDocument = {
  updated_at: string;
  source: string;
  tracked_wallets: TrackedWalletMeta[];
  summary: Record<string, any>;
};

function asArray<T = any>(value: any): T[] {
  return Array.isArray(value) ? value : [];
}

function toNumber(value: any, fallback = 0): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function uniqueStrings(values: any[]): string[] {
  return Array.from(
    new Set(
      asArray(values)
        .map((value) => String(value || '').trim())
        .filter(Boolean),
    ),
  );
}

function normalizeTags(row: JsonObject): string[] {
  if (Array.isArray(row?.tags)) return uniqueStrings(row.tags.map((tag: any) => String(tag).toLowerCase()));
  const notes = String(row?.notes || '').toLowerCase();
  const tagsMatch = notes.match(/tags=([^;]+)/);
  if (!tagsMatch) return [];
  return uniqueStrings(tagsMatch[1].split('|').map((tag) => tag.toLowerCase()));
}

function normalizeMeta(meta: JsonObject, fallbackSource: string): TrackedWalletMeta | null {
  const address = String(meta?.address || meta?.walletAddr || meta?.wallet || '').trim();
  if (!address) return null;

  const score = clamp(
    toNumber(meta?.score, toNumber(meta?.weight, toNumber(meta?.weightedScore, toNumber(meta?.profitabilityScore, 0.45)))),
    0,
    1,
  );

  return {
    address,
    style: String(meta?.style || meta?.primaryStyle || 'FLOW').trim() || 'FLOW',
    score,
    weight: clamp(toNumber(meta?.weight, score), 0, 1),
    source: String(meta?.source || fallbackSource || 'wallet-registry-refresh').trim(),
    immediate_entry: Boolean(meta?.immediate_entry ?? meta?.immediateEntry ?? false),
    executable: Boolean(meta?.executable ?? false),
    preferred_hold_ms: Math.max(60_000, toNumber(meta?.preferred_hold_ms, toNumber(meta?.preferredHoldMs, 300_000))),
    win_rate_gmgn: clamp(
      toNumber(meta?.win_rate_gmgn, toNumber(meta?.winRate, toNumber(meta?.avgWalletWinRate, 0))),
      0,
      1,
    ),
    notes: String(meta?.notes || '').trim() || undefined,
  };
}

function buildRowNotes(row: JsonObject): string {
  const parts = [
    `risk=${String(row?.copyabilityRisk || 'unknown')}`,
    `profit=${toNumber(row?.realizedProfitUsd).toFixed(2)}`,
    `trades=${Math.round(toNumber(row?.tradeCount))}`,
  ];
  const tags = normalizeTags(row);
  if (tags.length > 0) parts.push(`tags=${tags.slice(0, 4).join('|')}`);
  const twitter = String(row?.twitter || '').trim();
  if (twitter) parts.push(`twitter=${twitter}`);
  return parts.join(';');
}

function buildMetaFromDetailedRow(row: JsonObject, source: string): TrackedWalletMeta | null {
  const address = String(row?.walletAddr || row?.address || '').trim();
  if (!address) return null;

  const score = clamp(
    toNumber(row?.weightedScore, toNumber(row?.profitabilityScore, toNumber(row?.score, 0.45))),
    0,
    1,
  );

  return {
    address,
    style: String(row?.primaryStyle || row?.style || 'FLOW').trim() || 'FLOW',
    score,
    weight: clamp(toNumber(row?.weight, score), 0, 1),
    source,
    immediate_entry: Boolean(row?.immediateEntry ?? row?.immediate_entry ?? false),
    executable: Boolean(row?.executable ?? false),
    preferred_hold_ms: Math.max(60_000, toNumber(row?.preferredHoldMs, toNumber(row?.preferred_hold_ms, 300_000))),
    win_rate_gmgn: clamp(
      toNumber(row?.winRate, toNumber(row?.win_rate_gmgn, toNumber(row?.avgWalletWinRate, 0))),
      0,
      1,
    ),
    notes: buildRowNotes(row),
  };
}

function buildFlowFallbacks(gmgnSmartMoneyDoc: JsonObject): TrackedWalletMeta[] {
  const activity = new Map<string, { hits: number; sideHits: number; maxUsd: number }>();
  const buys = asArray(gmgnSmartMoneyDoc?.buys);
  const sells = asArray(gmgnSmartMoneyDoc?.sells);

  for (const row of [...buys, ...sells]) {
    const address = String(row?.maker || row?.wallet || '').trim();
    if (!address) continue;
    const current = activity.get(address) || { hits: 0, sideHits: 0, maxUsd: 0 };
    current.hits += 1;
    current.sideHits += row ? 1 : 0;
    current.maxUsd = Math.max(
      current.maxUsd,
      toNumber(row?.amount_usd, toNumber(row?.usd_value, toNumber(row?.volumeUsd, 0))),
    );
    activity.set(address, current);
  }

  return Array.from(activity.entries())
    .map(([address, stats]) => ({
      address,
      style: 'FLOW',
      score: clamp(0.35 + Math.min(stats.hits, 8) * 0.04 + Math.min(stats.maxUsd / 5_000, 0.18), 0, 0.8),
      weight: clamp(0.35 + Math.min(stats.hits, 8) * 0.04, 0, 0.8),
      source: 'gmgn-smartmoney',
      immediate_entry: stats.hits >= 3,
      executable: false,
      preferred_hold_ms: 5 * 60_000,
      win_rate_gmgn: 0,
      notes: `flow_hits=${stats.hits};max_usd=${stats.maxUsd.toFixed(2)}`,
    }))
    .sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
}

function mergeRankedMetas(items: TrackedWalletMeta[]): TrackedWalletMeta[] {
  const byAddress = new Map<string, TrackedWalletMeta>();
  for (const item of items) {
    const normalized = normalizeMeta(item as JsonObject, item?.source || 'wallet-registry-refresh');
    if (!normalized) continue;
    const existing = byAddress.get(normalized.address);
    if (!existing) {
      byAddress.set(normalized.address, normalized);
      continue;
    }

    const score = Math.max(toNumber(existing.score), toNumber(normalized.score));
    const weight = Math.max(toNumber(existing.weight), toNumber(normalized.weight));
    byAddress.set(normalized.address, {
      ...existing,
      ...normalized,
      style: normalized.style || existing.style,
      score,
      weight,
      source: normalized.source || existing.source,
      immediate_entry: Boolean(existing.immediate_entry || normalized.immediate_entry),
      executable: Boolean(existing.executable || normalized.executable),
      preferred_hold_ms: Math.min(
        Math.max(60_000, toNumber(existing.preferred_hold_ms, 300_000)),
        Math.max(60_000, toNumber(normalized.preferred_hold_ms, 300_000)),
      ),
      win_rate_gmgn: Math.max(toNumber(existing.win_rate_gmgn), toNumber(normalized.win_rate_gmgn)),
      notes: uniqueStrings([existing.notes, normalized.notes]).join(';') || undefined,
    });
  }

  return Array.from(byAddress.values()).sort((left, right) =>
    Number(right.score || 0) - Number(left.score || 0) ||
    Number(right.weight || 0) - Number(left.weight || 0) ||
    Number(right.win_rate_gmgn || 0) - Number(left.win_rate_gmgn || 0) ||
    left.address.localeCompare(right.address),
  );
}

function isKolLike(meta: TrackedWalletMeta, rawRow?: JsonObject): boolean {
  const style = String(meta?.style || rawRow?.primaryStyle || '').toUpperCase();
  if (style === 'KOL') return true;

  const tags = normalizeTags(rawRow || (meta as JsonObject));
  if (tags.some((tag) => ['kol', 'photon', 'axiom', 'gmgn', 'padre', 'launchpad_smart', 'top_renamed'].includes(tag))) {
    return true;
  }

  const twitter = String(rawRow?.twitter || rawRow?.twitter_username || '').trim();
  return twitter.length > 0;
}

function normalizeRisk(value: any): 'lower' | 'medium' | 'high' {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'high') return 'high';
  if (normalized === 'medium') return 'medium';
  return 'lower';
}

function guardHighRiskMeta(meta: TrackedWalletMeta, risk: 'lower' | 'medium' | 'high', lane: 'alpha' | 'kol'): TrackedWalletMeta | null {
  if (risk !== 'high') return meta;
  if (lane === 'alpha') return null;
  return {
    ...meta,
    executable: false,
    immediate_entry: false,
    style: meta.style === 'KOL' ? meta.style : 'KOL',
    notes: uniqueStrings([meta.notes, 'risk=high']).join(';') || undefined,
  };
}

export function buildWalletRegistryDocs(args: {
  alphaDoc?: JsonObject;
  kolDoc?: JsonObject;
  walletIntelDoc?: JsonObject;
  walletPnlDoc?: JsonObject;
  gmgnSmartMoneyDoc?: JsonObject;
  alphaLimit?: number;
  kolLimit?: number;
  nowIso?: string;
}) {
  const alphaLimit = Math.max(4, toNumber(args.alphaLimit, 16));
  const kolLimit = Math.max(2, toNumber(args.kolLimit, 8));
  const nowIso = String(args.nowIso || new Date().toISOString());

  const existingAlpha = asArray(args.alphaDoc?.tracked_wallets).map((row) => normalizeMeta(row, 'alpha-existing')).filter(Boolean) as TrackedWalletMeta[];
  const existingKol = asArray(args.kolDoc?.tracked_wallets).map((row) => normalizeMeta(row, 'kol-existing')).filter(Boolean) as TrackedWalletMeta[];
  const intelTracked = asArray(args.walletIntelDoc?.tracked_wallets).map((row) => normalizeMeta(row, 'wallet-intel')).filter(Boolean) as TrackedWalletMeta[];

  const detailedRows = mergeRankedMetas([
    ...asArray(args.walletIntelDoc?.wallets).map((row) => buildMetaFromDetailedRow(row, 'wallet-intel-row')).filter(Boolean) as TrackedWalletMeta[],
    ...asArray(args.walletPnlDoc?.wallets).map((row) => buildMetaFromDetailedRow(row, 'wallet-pnl-row')).filter(Boolean) as TrackedWalletMeta[],
  ]);

  const detailedMap = new Map<string, JsonObject>();
  for (const row of [...asArray(args.walletIntelDoc?.wallets), ...asArray(args.walletPnlDoc?.wallets)]) {
    const address = String(row?.walletAddr || row?.address || '').trim();
    if (address && !detailedMap.has(address)) detailedMap.set(address, row);
  }
  const riskByAddress = new Map<string, 'lower' | 'medium' | 'high'>();
  for (const [address, row] of detailedMap.entries()) {
    riskByAddress.set(address, normalizeRisk(row?.copyabilityRisk));
  }

  const flowFallbacks = buildFlowFallbacks(args.gmgnSmartMoneyDoc || {});

  const alphaCandidates = mergeRankedMetas([
    ...existingAlpha,
    ...intelTracked.filter((row) => String(row.style || '').toUpperCase() !== 'KOL'),
    ...detailedRows.filter((row) => {
      const raw = detailedMap.get(row.address) || {};
      const risk = String(raw?.copyabilityRisk || '').toLowerCase();
      return risk !== 'high' && !isKolLike(row, raw);
    }),
    ...flowFallbacks,
  ])
    .map((row) => guardHighRiskMeta(row, riskByAddress.get(row.address) || 'lower', 'alpha'))
    .filter(Boolean) as TrackedWalletMeta[];

  const kolCandidates = mergeRankedMetas([
    ...existingKol,
    ...intelTracked.filter((row) => {
      const raw = detailedMap.get(row.address) || {};
      return isKolLike(row, raw);
    }),
    ...detailedRows.filter((row) => {
      const raw = detailedMap.get(row.address) || {};
      return isKolLike(row, raw);
    }),
  ])
    .map((row) => guardHighRiskMeta(row, riskByAddress.get(row.address) || 'lower', 'kol'))
    .filter(Boolean) as TrackedWalletMeta[];

  const alphaDoc: RefreshDocument = {
    updated_at: nowIso,
    source: 'wallet-registry-refresh',
    tracked_wallets: alphaCandidates.slice(0, alphaLimit),
    summary: {
      tracked_wallet_count: alphaCandidates.slice(0, alphaLimit).length,
      executable_wallet_count: alphaCandidates.slice(0, alphaLimit).filter((row) => row.executable).length,
      top_wallet: alphaCandidates.slice(0, alphaLimit)[0]?.address || null,
      top_score: toNumber(alphaCandidates.slice(0, alphaLimit)[0]?.score),
    },
  };

  const kolDoc: RefreshDocument = {
    updated_at: nowIso,
    source: 'wallet-registry-refresh',
    tracked_wallets: kolCandidates.slice(0, kolLimit),
    summary: {
      tracked_wallet_count: kolCandidates.slice(0, kolLimit).length,
      executable_wallet_count: kolCandidates.slice(0, kolLimit).filter((row) => row.executable).length,
      top_wallet: kolCandidates.slice(0, kolLimit)[0]?.address || null,
      top_score: toNumber(kolCandidates.slice(0, kolLimit)[0]?.score),
    },
  };

  return { alphaDoc, kolDoc };
}
