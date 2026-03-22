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

import { Connection, PublicKey }    from '@solana/web3.js';
import { getMint }                  from '@solana/spl-token';
import { logger }                   from '../utils/logger';
import { config }                   from '../utils/config';

const MIN_LIQUIDITY_USD  = parseFloat(process.env.MIN_TOKEN_LIQUIDITY_USD    || '500');
const MAX_HOLDER_PCT     = parseFloat(process.env.MAX_HOLDER_CONCENTRATION   || '0.70');
const TRUST_THRESHOLD    = parseInt(process.env.TRUST_SCORE_THRESHOLD        || '40');
const MAX_BUNDLE_PCT     = parseFloat(process.env.MAX_BUNDLE_SUPPLY_PCT      || '0.30'); // 30% max acquired in one bundle
const MIN_BUNDLE_WALLETS = parseInt(process.env.MIN_BUNDLE_WALLET_COUNT      || '3');   // ≥3 same-slot = bundle
const CACHE_TTL_MS       = 10 * 60 * 1000;

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

// ── Check 6: Bundler / Axiom wash-volume detection ──────────────────────────
// Detects coordinated multi-wallet launches designed to mimic organic volume.
//
// Pattern 1 — Same-slot bundle: ≥MIN_BUNDLE_WALLETS top holders all received
//   their first tokens in the same on-chain slot (Jito bundle fingerprint).
//
// Pattern 2 — Common SOL funder: most buyer wallets were pre-funded by the
//   same parent wallet (dev controls all the "buyers").
//
// Pattern 3 — Wash velocity: wallet buys then sells within 30s (no real hold).
async function checkBundlerWallets(
  mint: string,
  topHolderAddresses: string[]
): Promise<{ bundled: boolean; bundlePct: number; reasons: string[] }> {
  const conn = getConn();
  const results: string[] = [];
  let bundlePct = 0;

  if (topHolderAddresses.length < 2) {
    return { bundled: false, bundlePct: 0, reasons: [] };
  }

  // Sample up to 8 top holders to limit RPC calls
  const sample = topHolderAddresses.slice(0, 8);

  try {
    // ── Pattern 1: same-slot first-buy detection ─────────────────────────────
    const firstBuySlots: number[] = [];
    const fundingSources: string[] = [];  // parent wallets that funded each buyer
    const washVelocityFlags: number[] = [];

    await Promise.all(sample.map(async (holderAddr) => {
      try {
        // Get recent signatures for this holder's token account
        const sigs = await conn.getSignaturesForAddress(
          new PublicKey(holderAddr),
          { limit: 5 }
        );
        if (!sigs.length) return;

        // The oldest recent sig is likely their first interaction with this token
        const oldestSig = sigs[sigs.length - 1];
        if (oldestSig.slot) firstBuySlots.push(oldestSig.slot);

        // ── Pattern 3: wash velocity ─────────────────────────────────────────
        // If they have ≥2 sigs within 30s of each other = round-trip wash
        if (sigs.length >= 2) {
          const t1 = sigs[0].blockTime || 0;
          const t2 = sigs[sigs.length - 1].blockTime || 0;
          if (Math.abs(t1 - t2) < 30) washVelocityFlags.push(1);
        }

        // ── Pattern 2: common funding source ─────────────────────────────────
        // Get the first inbound SOL tx to find funding wallet
        const solSigs = await conn.getSignaturesForAddress(
          new PublicKey(holderAddr),
          { limit: 10 }
        );
        if (solSigs.length) {
          const tx = await conn.getParsedTransaction(solSigs[solSigs.length - 1].signature, {
            maxSupportedTransactionVersion: 0,
          });
          const instructions = tx?.transaction?.message?.instructions || [];
          for (const ix of instructions) {
            if ('parsed' in ix && ix.parsed?.type === 'transfer') {
              const src = ix.parsed?.info?.source;
              if (src && src !== holderAddr) { fundingSources.push(src); break; }
            }
          }
        }
      } catch { /* single wallet failure is fine */ }
    }));

    // ── Evaluate Pattern 1: same-slot clustering ─────────────────────────────
    if (firstBuySlots.length >= MIN_BUNDLE_WALLETS) {
      const slotCounts = new Map<number, number>();
      for (const slot of firstBuySlots) {
        const windowedSlot = Math.floor(slot / 2); // group ±1 slot (one bundle window)
        slotCounts.set(windowedSlot, (slotCounts.get(windowedSlot) || 0) + 1);
      }
      const maxSameSlot = Math.max(...slotCounts.values());
      if (maxSameSlot >= MIN_BUNDLE_WALLETS) {
        bundlePct = maxSameSlot / sample.length;
        results.push(`bundle-launch(${maxSameSlot}/${sample.length}-wallets-same-slot)`);
      }
    }

    // ── Evaluate Pattern 2: common funder ───────────────────────────────────
    if (fundingSources.length >= 2) {
      const freq = new Map<string, number>();
      for (const src of fundingSources) freq.set(src, (freq.get(src) || 0) + 1);
      const [topFunder, topCount] = [...freq.entries()].sort((a, b) => b[1] - a[1])[0];
      const sharedPct = topCount / sample.length;
      if (sharedPct >= 0.5) { // ≥50% funded by same wallet = coordinated
        results.push(`common-funder(${topFunder.slice(0, 8)}…-funds-${(sharedPct * 100).toFixed(0)}%-of-buyers)`);
        bundlePct = Math.max(bundlePct, sharedPct);
      }
    }

    // ── Evaluate Pattern 3: wash trading velocity ────────────────────────────
    const washPct = washVelocityFlags.length / sample.length;
    if (washPct >= 0.5) {
      results.push(`wash-velocity(${(washPct * 100).toFixed(0)}%-of-holders-roundtrip<30s)`);
    }

  } catch (e: any) {
    logger.debug(`[SCREENER] Bundler check failed for ${mint.slice(0, 8)}: ${e.message}`);
  }

  return {
    bundled:   results.length > 0 && bundlePct > MAX_BUNDLE_PCT,
    bundlePct,
    reasons:   results,
  };
}
export async function screenContract(mint: string): Promise<ScreenResult> {
  const cached = cache.get(mint);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached;

  const reasons: string[] = [];
  let score = 100;

  // Checks 1–5 in parallel
  const [authorities, liquidity, rug, holderData] = await Promise.all([
    checkMintAuthorities(mint),
    checkLiquidity(mint),
    checkRugcheck(mint),
    checkHelius(mint),
  ]);

  // Check 1: Mint authority (hard block)
  if (!authorities.mintOk) { reasons.push('mint-authority-active'); score -= 40; }
  // Check 2: Freeze authority (hard block)
  if (!authorities.freezeOk) { reasons.push('freeze-authority-active'); score -= 30; }
  // Check 3: Liquidity
  if (!liquidity.liqOk) { reasons.push(`low-liquidity($${liquidity.liqUsd.toFixed(0)}<$${MIN_LIQUIDITY_USD})`); score -= 20; }
  // Check 4: Holder concentration
  if (!holderData.holderOk) { reasons.push(`concentrated-holders(${(holderData.topHolderPct * 100).toFixed(0)}%)`); score -= 15; }
  // Check 5: Rugcheck
  if (!rug.rugOk) { reasons.push(`rugcheck-score-${rug.rugScore}`); score -= 25; }

  // Check 6: Bundler / Axiom wash-volume detection
  try {
    const RPC  = config.RPC_ENDPOINT;
    const resp = await fetchJson(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'getTokenLargestAccounts', params: [mint] }),
    });
    const topAddrs: string[] = (resp?.result?.value || []).slice(0, 8).map((a: any) => a.address);
    const bundler = await checkBundlerWallets(mint, topAddrs);

    if (bundler.bundled) {
      reasons.push(...bundler.reasons);
      score -= 35;
      logger.debug(`[SCREENER] 🚩 ${mint.slice(0, 8)}… BUNDLED: ${bundler.reasons.join(' | ')} (${(bundler.bundlePct * 100).toFixed(0)}% supply)`);
    } else if (bundler.reasons.length > 0) {
      reasons.push(...bundler.reasons.map(r => `(warn)${r}`));
      score -= 10;
    }
  } catch { /* non-fatal */ }

  score = Math.max(0, score);
  const hardBlocked = reasons.some(r => r.startsWith('mint-authority') || r.startsWith('freeze-authority'));
  const safe = !hardBlocked && score >= TRUST_THRESHOLD;

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
