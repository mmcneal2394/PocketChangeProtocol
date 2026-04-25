type MaybeNumber = number | null | undefined;

export type AlphaSignal = {
  id: string;
  source: string;
  type: string;
  timestamp: number;
  token_address: string;
  sentiment_score: number;
  confidence: number;
  kol_reputation_score: number;
  expires_at: number;
  metadata?: Record<string, any>;
};

export type TokenProfileSnapshot = {
  tokenAddress: string;
  chainId: string;
  url: string | null;
  icon: string | null;
  header: string | null;
  description: string | null;
  twitter: string | null;
  telegram: string | null;
  website: string | null;
  lastSeenAt: number;
};

type ProfileDiff = {
  field: 'twitter' | 'telegram' | 'website' | 'icon' | 'header' | 'description';
  change: 'added' | 'removed';
};

function toFiniteNumber(value: MaybeNumber, fallback = 0): number {
  const numeric = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(value: any): string | null {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized : null;
}

function normalizeLink(value: any): string | null {
  const normalized = normalizeText(value);
  return normalized ? normalized.toLowerCase() : null;
}

function buildSignalId(parts: Array<string | number | null | undefined>): string {
  return parts.filter(Boolean).join(':');
}

function createSignal(args: {
  source: string;
  type: string;
  tokenAddress: string;
  timestamp: number;
  expiresAt: number;
  sentimentScore: number;
  confidence: number;
  kolReputationScore?: number;
  metadata?: Record<string, any>;
  idSuffix?: string;
}): AlphaSignal {
  return {
    id: buildSignalId([
      args.source,
      args.type,
      args.tokenAddress,
      args.idSuffix || args.metadata?.signalKey || args.timestamp,
    ]),
    source: args.source,
    type: args.type,
    timestamp: args.timestamp,
    token_address: args.tokenAddress,
    sentiment_score: clamp(args.sentimentScore, -1, 1),
    confidence: clamp(args.confidence, 0, 1),
    kol_reputation_score: clamp(args.kolReputationScore ?? 0, 0, 1),
    expires_at: Math.max(args.timestamp, args.expiresAt),
    metadata: args.metadata || {},
  };
}

function readProfileLink(profile: any, preferredType: string): string | null {
  const links = Array.isArray(profile?.links) ? profile.links : [];
  const exactMatch = links.find((link) => String(link?.type || '').trim().toLowerCase() === preferredType);
  if (exactMatch?.url) return normalizeLink(exactMatch.url);
  if (preferredType === 'website') {
    const websiteLike = links.find((link) => {
      const type = String(link?.type || '').trim().toLowerCase();
      return type === 'website' || type === 'link';
    });
    if (websiteLike?.url) return normalizeLink(websiteLike.url);
  }
  return null;
}

export function profileToSnapshot(profile: any, now = Date.now()): TokenProfileSnapshot | null {
  const tokenAddress = normalizeText(profile?.tokenAddress);
  const chainId = normalizeText(profile?.chainId);
  if (!tokenAddress || chainId !== 'solana') return null;
  return {
    tokenAddress,
    chainId,
    url: normalizeLink(profile?.url),
    icon: normalizeLink(profile?.icon),
    header: normalizeLink(profile?.header),
    description: normalizeText(profile?.description),
    twitter: readProfileLink(profile, 'twitter'),
    telegram: readProfileLink(profile, 'telegram'),
    website: readProfileLink(profile, 'website'),
    lastSeenAt: now,
  };
}

export function diffProfileSnapshot(
  previous: TokenProfileSnapshot | null | undefined,
  next: TokenProfileSnapshot | null | undefined,
): ProfileDiff[] {
  if (!next) return [];
  const fields: Array<ProfileDiff['field']> = ['twitter', 'telegram', 'website', 'icon', 'header', 'description'];
  const diffs: ProfileDiff[] = [];
  for (const field of fields) {
    const before = normalizeText(previous?.[field]);
    const after = normalizeText(next?.[field]);
    if (!before && after) {
      diffs.push({ field, change: 'added' });
    } else if (before && !after) {
      diffs.push({ field, change: 'removed' });
    }
  }
  return diffs;
}

export function scoreDexBoost(boost: any, now = Date.now()): AlphaSignal | null {
  const tokenAddress = normalizeText(boost?.tokenAddress);
  if (!tokenAddress || normalizeText(boost?.chainId) !== 'solana') return null;
  const amount = Math.max(toFiniteNumber(boost?.amount, 0), toFiniteNumber(boost?.totalAmount, 0));
  if (amount <= 0) return null;

  const boostDelta =
    amount >= 100 ? 0.2 :
    amount >= 50 ? 0.16 :
    amount >= 20 ? 0.12 :
    amount >= 10 ? 0.08 :
    0.05;
  const confidence =
    amount >= 100 ? 0.7 :
    amount >= 50 ? 0.62 :
    amount >= 20 ? 0.55 :
    0.42;

  return createSignal({
    source: 'dexscreener',
    type: 'DEX_BOOST',
    tokenAddress,
    timestamp: now,
    expiresAt: now + 60 * 60_000,
    sentimentScore: 0.9,
    confidence,
    metadata: {
      boost: boostDelta,
      amount,
      url: normalizeLink(boost?.url),
      signalKey: `dex-boost:${tokenAddress}:${amount}`,
    },
    idSuffix: `boost:${amount}`,
  });
}

export function scoreDexOrders(tokenAddress: string, orders: any[], now = Date.now()): AlphaSignal[] {
  const normalizedToken = normalizeText(tokenAddress);
  if (!normalizedToken) return [];
  const nextSignals: AlphaSignal[] = [];
  for (const order of Array.isArray(orders) ? orders : []) {
    const type = String(order?.type || order?.orderType || '').trim().toLowerCase();
    if (!type) continue;
    const orderTimestamp = Date.parse(String(order?.date || order?.createdAt || order?.paymentTimestamp || '')) || now;
    if (type.includes('community') || type.includes('takeover') || type.includes('cto')) {
      nextSignals.push(createSignal({
        source: 'dexscreener',
        type: 'DEX_PAID',
        tokenAddress: normalizedToken,
        timestamp: orderTimestamp,
        expiresAt: orderTimestamp + 60 * 60_000,
        sentimentScore: 0.85,
        confidence: 0.6,
        metadata: {
          boost: 0.3,
          orderType: type,
          signalKey: `dex-order:${normalizedToken}:${type}`,
        },
        idSuffix: `order:${type}`,
      }));
      continue;
    }
    if (type.includes('profile')) {
      nextSignals.push(createSignal({
        source: 'dexscreener',
        type: 'DEX_PAID',
        tokenAddress: normalizedToken,
        timestamp: orderTimestamp,
        expiresAt: orderTimestamp + 45 * 60_000,
        sentimentScore: 0.6,
        confidence: 0.45,
        metadata: {
          boost: 0.12,
          orderType: type,
          signalKey: `dex-order:${normalizedToken}:${type}`,
        },
        idSuffix: `order:${type}`,
      }));
    }
  }
  return nextSignals;
}

export function scoreSocialUpdate(
  tokenAddress: string,
  previous: TokenProfileSnapshot | null | undefined,
  next: TokenProfileSnapshot | null | undefined,
  now = Date.now(),
): AlphaSignal[] {
  const normalizedToken = normalizeText(tokenAddress);
  if (!normalizedToken || !next) return [];
  const diffs = diffProfileSnapshot(previous, next);
  if (diffs.length === 0) return [];

  const positiveDiffs = diffs.filter((diff) => diff.change === 'added');
  const negativeDiffs = diffs.filter((diff) => diff.change === 'removed');
  const signals: AlphaSignal[] = [];

  if (positiveDiffs.length > 0) {
    const socialAdds = positiveDiffs.filter((diff) => ['twitter', 'telegram', 'website'].includes(diff.field)).length;
    const cosmeticAdds = positiveDiffs.length - socialAdds;
    const boost = clamp((socialAdds * 0.05) + (cosmeticAdds * 0.02), 0.03, 0.15);
    const confidence = socialAdds >= 2 ? 0.8 : socialAdds >= 1 ? 0.55 : 0.35;
    signals.push(createSignal({
      source: 'dexscreener',
      type: 'SOCIAL_UPDATE',
      tokenAddress: normalizedToken,
      timestamp: now,
      expiresAt: now + 30 * 60_000,
      sentimentScore: 0.7,
      confidence,
      metadata: {
        boost,
        change: 'added',
        fields: positiveDiffs.map((diff) => diff.field),
        signalKey: `social-added:${normalizedToken}:${positiveDiffs.map((diff) => diff.field).sort().join(',')}`,
      },
      idSuffix: `social-added:${positiveDiffs.map((diff) => diff.field).sort().join(',')}`,
    }));
  }

  if (negativeDiffs.length > 0) {
    const socialRemovals = negativeDiffs.filter((diff) => ['twitter', 'telegram', 'website'].includes(diff.field)).length;
    const cosmeticRemovals = negativeDiffs.length - socialRemovals;
    const penalty = clamp((socialRemovals * 0.06) + (cosmeticRemovals * 0.02), 0.04, 0.15);
    const confidence = socialRemovals >= 2 ? 1 : socialRemovals >= 1 ? 0.7 : 0.4;
    signals.push(createSignal({
      source: 'dexscreener',
      type: 'SOCIAL_UPDATE',
      tokenAddress: normalizedToken,
      timestamp: now,
      expiresAt: now + 60 * 60_000,
      sentimentScore: -0.9,
      confidence,
      metadata: {
        boost: -penalty,
        change: 'removed',
        fields: negativeDiffs.map((diff) => diff.field),
        signalKey: `social-removed:${normalizedToken}:${negativeDiffs.map((diff) => diff.field).sort().join(',')}`,
      },
      idSuffix: `social-removed:${negativeDiffs.map((diff) => diff.field).sort().join(',')}`,
    }));
  }

  return signals;
}

export function scoreGmgnCto(entry: any, now = Date.now()): AlphaSignal | null {
  const tokenAddress = normalizeText(entry?.mint || entry?.address || entry?.tokenAddress);
  if (!tokenAddress) return null;
  const isCto = Boolean(entry?.is_cto) || String(entry?.dev_status || '').trim().toLowerCase() === 'sold_all';
  if (!isCto) return null;
  return createSignal({
    source: 'gmgn',
    type: 'CTO_DETECTED',
    tokenAddress,
    timestamp: now,
    expiresAt: now + 30 * 60_000,
    sentimentScore: 0.9,
    confidence: 0.7,
    metadata: {
      boost: 0.35,
      is_cto: Boolean(entry?.is_cto),
      dev_status: normalizeText(entry?.dev_status),
      symbol: normalizeText(entry?.symbol),
      signalKey: `gmgn-cto:${tokenAddress}`,
    },
    idSuffix: 'gmgn-cto',
  });
}

export function dedupeSignals(signals: AlphaSignal[], now = Date.now()): AlphaSignal[] {
  const deduped = new Map<string, AlphaSignal>();
  for (const signal of Array.isArray(signals) ? signals : []) {
    if (!signal?.token_address || !signal?.source || !signal?.type) continue;
    if (Number(signal.expires_at || 0) <= now) continue;
    const signalKey = String(signal?.metadata?.signalKey || signal.id || buildSignalId([signal.source, signal.type, signal.token_address]));
    const previous = deduped.get(signalKey);
    if (!previous || Number(signal.timestamp || 0) >= Number(previous.timestamp || 0)) {
      deduped.set(signalKey, signal);
    }
  }
  return Array.from(deduped.values()).sort((left, right) => Number(right.timestamp || 0) - Number(left.timestamp || 0));
}

export function computeCatalystBoost(tokenAddress: string, signals: AlphaSignal[], now = Date.now()) {
  const normalizedToken = normalizeText(tokenAddress);
  const activeSignals = dedupeSignals(signals, now).filter((signal) => signal.token_address === normalizedToken);
  const totalBoost = clamp(
    Number(
      activeSignals
        .reduce((sum, signal) => {
          const metadataBoost = Number(signal?.metadata?.boost);
          const delta = Number.isFinite(metadataBoost)
            ? metadataBoost
            : clamp(signal.sentiment_score, -1, 1) * clamp(signal.confidence, 0, 1) * 0.2;
          return sum + delta;
        }, 0)
        .toFixed(4),
    ),
    -0.3,
    0.6,
  );
  const averageSentiment = activeSignals.length
    ? Number(
        (
          activeSignals.reduce((sum, signal) => sum + clamp(signal.sentiment_score, -1, 1), 0) /
          activeSignals.length
        ).toFixed(4),
      )
    : 0;
  return {
    totalBoost,
    averageSentiment,
    activeSignals,
    positiveSignals: activeSignals.filter((signal) => (Number(signal?.metadata?.boost) || 0) > 0),
    negativeSignals: activeSignals.filter((signal) => (Number(signal?.metadata?.boost) || 0) < 0),
  };
}

module.exports = {
  profileToSnapshot,
  diffProfileSnapshot,
  scoreDexBoost,
  scoreDexOrders,
  scoreSocialUpdate,
  scoreGmgnCto,
  dedupeSignals,
  computeCatalystBoost,
};
