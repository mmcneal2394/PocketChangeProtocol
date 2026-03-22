/**
 * contract_screener.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Security gate: runs 5 checks on every new token mint before it's allowed
 * into the arb route pool. Results cached for 10 minutes.
 *
 * Checks:
 *   1. Mint authority — must be null (supply cannot be inflated)
 *   2. Freeze authority — must be null (wallets cannot be frozen)
 *   3. Minimum liquidity — at least MIN_LIQUIDITY_USD to avoid dust pools
 *   4. Top-holder concentration — top 10 holders must own < MAX_HOLDER_PCT
 *   5. Rug check — cross-references rugcheck.xyz score if available
 *
 * Returns a TrustScore (0-100) and safe:boolean.
 * Tokens scoring < TRUST_THRESHOLD are blocked.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { logger }  from '../utils/logger';
import { config }  from '../utils/config';

const MIN_LIQUIDITY_USD  = parseFloat(process.env.MIN_TOKEN_LIQUIDITY_USD || '500');
const MAX_HOLDER_PCT     = parseFloat(process.env.MAX_HOLDER_CONCENTRATION || '0.70'); // 70% max
const TRUST_THRESHOLD    = parseInt(process.env.TRUST_SCORE_THRESHOLD || '40');        // 0-100
const CACHE_TTL_MS       = 10 * 60 * 1000; // 10 min

export interface ScreenResult {
  mint:    string;
  safe:    boolean;
  score:   number;       // 0–100
  reasons: string[];     // list of flags
  cachedAt: number;
}

// ── In-memory cache ───────────────────────────────────────────────────────────
const cache = new Map<string, ScreenResult>();

let connection: Connection;
function getConn(): Connection {
  if (!connection) connection = new Connection(config.RPC_ENDPOINT, { commitment: 'confirmed' });
  return connection;
}

// ── Fetch with timeout ────────────────────────────────────────────────────────
async function fetchJson(url: string, opts: RequestInit = {}): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    clearTimeout(t);
    return null;
  }
}

// ── Check 1 & 2: mint authority + freeze authority via SPL ────────────────────
async function checkMintAuthorities(mint: string): Promise<{ mintOk: boolean; freezeOk: boolean }> {
  try {
    const info = await getMint(getConn(), new PublicKey(mint), 'confirmed');
    return {
      mintOk:   info.mintAuthority === null,
      freezeOk: info.freezeAuthority === null,
    };
  } catch {
    // Can't read = assume bad
    return { mintOk: false, freezeOk: false };
  }
}

// ── Check 3 & 4: liquidity + holder concentration via Helius DAS ──────────────
async function checkHelius(mint: string): Promise<{ liqOk: boolean; holderOk: boolean; liqUsd: number; topHolderPct: number }> {
  // Token holders via Helius
  try {
    const RPC = config.RPC_ENDPOINT; // Helius RPC with key embedded
    const resp = await fetchJson(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTokenLargestAccounts',
        params: [mint],
      }),
    });

    const accounts: any[] = resp?.result?.value || [];
    const total = accounts.reduce((a: number, b: any) => a + Number(b.uiAmount || 0), 0);
    const top10 = accounts.slice(0, 10).reduce((a: number, b: any) => a + Number(b.uiAmount || 0), 0);
    const topHolderPct = total > 0 ? top10 / total : 1;

    return { liqOk: true, holderOk: topHolderPct < MAX_HOLDER_PCT, liqUsd: 0, topHolderPct };
  } catch {
    return { liqOk: true, holderOk: true, liqUsd: 0, topHolderPct: 0 };
  }
}

// ── Check 5: Rugcheck.xyz API ─────────────────────────────────────────────────
async function checkRugcheck(mint: string): Promise<{ rugScore: number | null; rugOk: boolean }> {
  const data = await fetchJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
  if (!data) return { rugScore: null, rugOk: true }; // if unavailable, don't block

  const score: number = data?.score ?? data?.risk_score ?? 50;
  // Rugcheck: lower = safer. > 800 = high risk
  return { rugScore: score, rugOk: score < 800 };
}

// ── Check: DexScreener liquidity ─────────────────────────────────────────────
async function checkLiquidity(mint: string): Promise<{ liqUsd: number; liqOk: boolean }> {
  const data = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  if (!data?.pairs?.length) return { liqUsd: 0, liqOk: false };

  // Take the highest-liquidity Solana pair
  const solPairs = data.pairs.filter((p: any) => p.chainId === 'solana');
  if (!solPairs.length) return { liqUsd: 0, liqOk: false };

  const maxLiq = Math.max(...solPairs.map((p: any) => p.liquidity?.usd || 0));
  return { liqUsd: maxLiq, liqOk: maxLiq >= MIN_LIQUIDITY_USD };
}

// ── Main screening function ───────────────────────────────────────────────────
export async function screenContract(mint: string): Promise<ScreenResult> {
  // Return cached result if fresh
  const cached = cache.get(mint);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached;

  const reasons: string[] = [];
  let score = 100;

  // Run checks in parallel (3 groups: chain, liquidity, rug)
  const [authorities, liquidity, rug] = await Promise.all([
    checkMintAuthorities(mint),
    checkLiquidity(mint),
    checkRugcheck(mint),
  ]);

  // Check 1: Mint authority
  if (!authorities.mintOk) {
    reasons.push('mint-authority-active');
    score -= 40; // critical — supply can be inflated
  }

  // Check 2: Freeze authority
  if (!authorities.freezeOk) {
    reasons.push('freeze-authority-active');
    score -= 30; // critical — funds can be frozen
  }

  // Check 3: Liquidity
  if (!liquidity.liqOk) {
    reasons.push(`low-liquidity($${liquidity.liqUsd.toFixed(0)}<$${MIN_LIQUIDITY_USD})`);
    score -= 20;
  }

  // Check 4: Holder concentration (run separately since it needs RPC)
  const holderData = await checkHelius(mint);
  if (!holderData.holderOk) {
    reasons.push(`concentrated-holders(${(holderData.topHolderPct * 100).toFixed(0)}%)`);
    score -= 15;
  }

  // Check 5: Rugcheck
  if (!rug.rugOk) {
    reasons.push(`rugcheck-score-${rug.rugScore}`);
    score -= 25;
  }

  score = Math.max(0, score);
  const safe = score >= TRUST_THRESHOLD && reasons.filter(r =>
    r.startsWith('mint-authority') || r.startsWith('freeze-authority')
  ).length === 0;

  const result: ScreenResult = { mint, safe, score, reasons, cachedAt: Date.now() };
  cache.set(mint, result);

  return result;
}

// ── Evict stale cache entries every 15 min ────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.cachedAt > CACHE_TTL_MS) cache.delete(k);
  }
}, 15 * 60 * 1000);
