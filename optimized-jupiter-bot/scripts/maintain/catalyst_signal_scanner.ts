import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

const {
  profileToSnapshot,
  scoreDexBoost,
  scoreDexOrders,
  scoreSocialUpdate,
  scoreGmgnCto,
  dedupeSignals,
} = require('./catalyst_signal_logic.ts');

const SIGNALS_DIR = path.join(process.cwd(), 'signals');
const CATALYST_ALERTS_FILE = path.join(SIGNALS_DIR, 'catalyst_alerts.json');
const PROFILE_SNAPSHOTS_FILE = path.join(SIGNALS_DIR, 'profile_snapshots.json');
const GMGN_TRENDING_FILE = path.join(SIGNALS_DIR, 'gmgn_trending.json');
const POLL_MS = Math.max(10_000, Number(process.env.CATALYST_POLL_MS || 20_000));
const MAX_ORDER_QUERIES_PER_CYCLE = Math.max(1, Number(process.env.CATALYST_MAX_ORDER_QUERIES || 8));
const DEX_BASE = 'https://api.dexscreener.com';

type AlphaSignal = {
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

type ProfileSnapshotsDocument = {
  updatedAt: number;
  byToken: Record<string, any>;
};

let cycle = 0;
let orderCursor = 0;

function ensureSignalsDir() {
  fs.mkdirSync(SIGNALS_DIR, { recursive: true });
}

function loadJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function safeWrite(filePath: string, payload: any) {
  ensureSignalsDir();
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, filePath);
}

async function fetchJson(endpoint: string): Promise<any> {
  const response = await fetch(endpoint, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`${endpoint} -> ${response.status}`);
  }
  return response.json();
}

function loadExistingSignals(now = Date.now()): AlphaSignal[] {
  const existing = loadJsonSafe<any>(CATALYST_ALERTS_FILE, {});
  const source = Array.isArray(existing?.signals) ? existing.signals : [];
  return dedupeSignals(source, now);
}

function loadProfileSnapshots(): ProfileSnapshotsDocument {
  return loadJsonSafe<ProfileSnapshotsDocument>(PROFILE_SNAPSHOTS_FILE, {
    updatedAt: 0,
    byToken: {},
  });
}

function loadGmgnTrendingTokens(): any[] {
  const doc = loadJsonSafe<any>(GMGN_TRENDING_FILE, {});
  if (Array.isArray(doc?.tokens)) return doc.tokens;
  if (Array.isArray(doc)) return doc;
  return [];
}

function uniqueTokensFromProfiles(profiles: any[], boosts: any[], gmgnTokens: any[]): string[] {
  const ordered = [
    ...profiles.map((entry) => String(entry?.tokenAddress || '').trim()),
    ...boosts.map((entry) => String(entry?.tokenAddress || '').trim()),
    ...gmgnTokens.map((entry) => String(entry?.mint || entry?.address || '').trim()),
  ].filter(Boolean);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const token of ordered) {
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
  }
  return unique;
}

function selectOrderCandidates(tokens: string[]): string[] {
  if (tokens.length <= MAX_ORDER_QUERIES_PER_CYCLE) return tokens;
  const selected: string[] = [];
  for (let index = 0; index < MAX_ORDER_QUERIES_PER_CYCLE; index += 1) {
    const token = tokens[(orderCursor + index) % tokens.length];
    selected.push(token);
  }
  orderCursor = (orderCursor + MAX_ORDER_QUERIES_PER_CYCLE) % tokens.length;
  return selected;
}

async function runCycle() {
  const now = Date.now();
  cycle += 1;
  const startedAt = Date.now();
  const existingSignals = loadExistingSignals(now);
  const profileSnapshots = loadProfileSnapshots();
  const gmgnTokens = loadGmgnTrendingTokens();

  const [boosts, profiles] = await Promise.all([
    fetchJson(`${DEX_BASE}/token-boosts/latest/v1`).catch(() => []),
    fetchJson(`${DEX_BASE}/token-profiles/latest/v1`).catch(() => []),
  ]);

  const nextSignals: AlphaSignal[] = [...existingSignals];
  const nextSnapshots = { ...profileSnapshots.byToken };

  for (const boost of Array.isArray(boosts) ? boosts : []) {
    const signal = scoreDexBoost(boost, now);
    if (signal) nextSignals.push(signal);
  }

  let profileAdditions = 0;
  let profileRemovals = 0;
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    const snapshot = profileToSnapshot(profile, now);
    if (!snapshot) continue;
    const previous = nextSnapshots[snapshot.tokenAddress] || null;
    const socialSignals = scoreSocialUpdate(snapshot.tokenAddress, previous, snapshot, now);
    for (const signal of socialSignals) {
      if (Number(signal?.metadata?.boost || 0) >= 0) profileAdditions += 1;
      else profileRemovals += 1;
      nextSignals.push(signal);
    }
    nextSnapshots[snapshot.tokenAddress] = snapshot;
  }

  let gmgnCtoCount = 0;
  for (const token of gmgnTokens) {
    const signal = scoreGmgnCto(token, now);
    if (!signal) continue;
    gmgnCtoCount += 1;
    nextSignals.push(signal);
  }

  const orderCandidates = selectOrderCandidates(uniqueTokensFromProfiles(profiles, boosts, gmgnTokens));
  let orderSignals = 0;
  for (const tokenAddress of orderCandidates) {
    try {
      const orders = await fetchJson(`${DEX_BASE}/orders/v1/solana/${tokenAddress}`);
      const signals = scoreDexOrders(tokenAddress, Array.isArray(orders) ? orders : [], now);
      orderSignals += signals.length;
      nextSignals.push(...signals);
    } catch {}
  }

  const activeSignals = dedupeSignals(nextSignals, now);
  const alertsDocument = {
    updatedAt: now,
    cycle,
    signalCount: activeSignals.length,
    signals: activeSignals,
  };

  safeWrite(CATALYST_ALERTS_FILE, alertsDocument);
  safeWrite(PROFILE_SNAPSHOTS_FILE, {
    updatedAt: now,
    byToken: nextSnapshots,
  });

  const elapsedMs = Date.now() - startedAt;
  const positiveSignals = activeSignals.filter((signal: AlphaSignal) => Number(signal?.metadata?.boost || 0) > 0).length;
  const negativeSignals = activeSignals.filter((signal: AlphaSignal) => Number(signal?.metadata?.boost || 0) < 0).length;
  console.log(
    `[CATALYST] Cycle #${cycle} | ${activeSignals.length} active (${positiveSignals}↑ ${negativeSignals}↓) | ` +
    `${elapsedMs}ms | boosts ${Array.isArray(boosts) ? boosts.length : 0} | profiles ${Array.isArray(profiles) ? profiles.length : 0} ` +
    `| social +${profileAdditions}/-${profileRemovals} | orders ${orderSignals} | gmgn_cto ${gmgnCtoCount}`
  );
}

async function main() {
  ensureSignalsDir();
  await runCycle().catch((error) => {
    console.error(`[CATALYST] Initial cycle failed: ${error?.message || error}`);
  });
  setInterval(() => {
    runCycle().catch((error) => {
      console.error(`[CATALYST] Cycle failed: ${error?.message || error}`);
    });
  }, POLL_MS);
}

main().catch((error) => {
  console.error(`[CATALYST] Fatal: ${error?.message || error}`);
  process.exitCode = 1;
});
