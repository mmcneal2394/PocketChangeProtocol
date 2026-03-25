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
const MAX_BUNDLE_PCT     = parseFloat(process.env.MAX_BUNDLE_SUPPLY_PCT      || '0.30');
const MIN_BUNDLE_WALLETS = parseInt(process.env.MIN_BUNDLE_WALLET_COUNT      || '3');
const CACHE_TTL_PASS_MS  = 30 * 60 * 1000;  // 30 min for tokens that passed
const CACHE_TTL_FAIL_MS  = 5  * 60 * 1000;  // 5  min for failed tokens (re-check sooner)
const CACHE_TTL_MS       = CACHE_TTL_PASS_MS; // keep old name for eviction loop

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

// ── Mints that intentionally have issuer-held authority (USDC/USDT) ───────────
// These are regulated stablecoins — active authority is expected, not a rug flag.
const TRUSTED_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC (Circle)
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  // USDT (Tether)
  '9uW2TqLyfYyrcNa9s7q6h5RKvRwXJ4MrBEQRRK3VKKU',  // USDC.e bridged
]);

// ── Check 7: Jupiter Strict Token List (CDN-cached, 24h TTL) ────────────────────
// The Jupiter strict list contains only verified, rug-free tokens audited by Jupiter.
// Being listed = strong safety signal. +20 trust bonus. Refreshed once per 24h.
let jupiterStrictSet   = new Set<string>();
let jupiterStrictFetch = 0;
async function loadJupiterStrictList(): Promise<void> {
  if (Date.now() - jupiterStrictFetch < 24 * 60 * 60 * 1000) return;
  try {
    const data = await fetchJson('https://token.jup.ag/strict');
    if (Array.isArray(data)) {
      jupiterStrictSet = new Set(data.map((t: any) => t.address).filter(Boolean));
      jupiterStrictFetch = Date.now();
      logger.info(`[SCREENER] Jupiter strict list loaded: ${jupiterStrictSet.size} verified tokens`);
    }
  } catch { /* non-fatal — degrade gracefully */ }
}
// Boot load (fire-and-forget)
loadJupiterStrictList().catch(() => {});

function checkJupiterStrict(mint: string): { verified: boolean; bonus: number } {
  if (TRUSTED_MINTS.has(mint)) return { verified: true, bonus: 20 };
  const verified = jupiterStrictSet.has(mint);
  return { verified, bonus: verified ? 20 : 0 };
}

// ── Check 8: Rugcheck.xyz composite risk score ────────────────────────────
// Free, no API key. Returns score 0-1000 (lower = safer) + risk labels.
// 0-100: clean. 100-500: moderate. 500-1000: high risk.
async function checkRugcheck(mint: string): Promise<{ score: number; risks: string[]; ok: boolean }> {
  if (TRUSTED_MINTS.has(mint)) return { score: 0, risks: [], ok: true };
  try {
    const data = await fetchJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
    if (!data) return { score: -1, risks: [], ok: true }; // unavailable — skip, don't penalise
    const score: number = data.score ?? data.risk_score ?? -1;
    const risks: string[] = (data.risks || []).map((r: any) => `${r.name}(${r.level})`).slice(0, 3);
    return {
      score,
      risks,
      ok: score < 0 || score < 500, // -1 = unavailable (pass)
    };
  } catch {
    return { score: -1, risks: [], ok: true };
  }
}

// ── Check 9: GeckoTerminal pool depth + buy/sell pressure ─────────────────
// Free, no API key. 30/min rate limit. Provides 24h volume, buy/sell count
// and fdv_usd — more granular than DexScreener for trade quality signals.
async function checkGeckoTerminal(mint: string): Promise<{
  volumeUsd24h: number;
  buyCount24h:  number;
  sellCount24h: number;
  buySellRatio: number;
  fdvUsd:       number;
  flags:        string[];
}> {
  const EMPTY = { volumeUsd24h: 0, buyCount24h: 0, sellCount24h: 0, buySellRatio: 1, fdvUsd: 0, flags: [] };
  try {
    const data = await fetchJson(
      `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}?include=top_pools`,
      { headers: { 'Accept': 'application/json;version=20230302' } }
    );
    const attr    = data?.data?.attributes;
    if (!attr) return EMPTY;

    const vol24h  = parseFloat(attr.volume_usd?.h24 || '0');
    const fdv     = parseFloat(attr.fdv_usd || '0');
    // Aggregate buy/sell counts across top pools (included in response)
    let buys = 0, sells = 0;
    for (const pool of (data?.included || [])) {
      const txns = pool?.attributes?.transactions?.h24;
      if (txns) { buys += txns.buys || 0; sells += txns.sells || 0; }
    }
    const ratio   = sells > 0 ? buys / sells : (buys > 0 ? 2 : 1); // ≥1 = buy pressure
    const flags: string[] = [];
    if (vol24h < 1000 && vol24h > 0)  flags.push(`low-vol24h($${vol24h.toFixed(0)})`);
    if (ratio < 0.4)                   flags.push(`sell-pressure(ratio:${ratio.toFixed(2)})`);
    if (buys + sells < 10)             flags.push(`thin-activity(${buys + sells}txns/24h)`);

    return { volumeUsd24h: vol24h, buyCount24h: buys, sellCount24h: sells, buySellRatio: ratio, fdvUsd: fdv, flags };
  } catch {
    return EMPTY;
  }
}

// ── Check 10: Solscan holder count + top-3 concentration ──────────────────
// Free public API (~2 req/s). Returns holder total and individual amounts.
// Whale concentration check: top-3 holders > 80% = severe risk.
async function checkSolscan(mint: string): Promise<{
  holderCount: number;
  top3Pct:     number;
  flags:        string[];
}> {
  const EMPTY = { holderCount: 0, top3Pct: 0, flags: [] };
  try {
    const data = await fetchJson(
      `https://public-api.solscan.io/token/holders?tokenAddress=${mint}&limit=10&offset=0`
    );
    // Solscan returns { total: number, data: [{owner, amount, decimals}...] }
    const total: number = data?.total ?? 0;
    const holders: any[] = data?.data ?? [];
    if (!holders.length) return EMPTY;

    const amounts   = holders.map((h: any) => parseFloat(h.amount || '0'));
    const totalAmt  = amounts.reduce((a, b) => a + b, 0);
    const top3Amt   = amounts.slice(0, 3).reduce((a, b) => a + b, 0);
    const top3Pct   = totalAmt > 0 ? top3Amt / totalAmt : 0;

    const flags: string[] = [];
    if (total > 0 && total < 50)  flags.push(`thin-holders(${total})`);
    if (top3Pct > 0.80)           flags.push(`whale-top3(${(top3Pct * 100).toFixed(0)}%)`);
    else if (top3Pct > 0.60)      flags.push(`conc-top3(${(top3Pct * 100).toFixed(0)}%)`);

    return { holderCount: total, top3Pct, flags };
  } catch {
    return EMPTY;
  }
}

// ── Check 1 & 2: mint authority + freeze authority via SPL ────────────────────
async function checkMintAuthorities(mint: string): Promise<{ mintOk: boolean; freezeOk: boolean }> {
  // Regulated issuers (Circle/Tether) keep authority by design — don't penalise
  if (TRUSTED_MINTS.has(mint)) return { mintOk: true, freezeOk: true };
  try {
    const info = await getMint(getConn(), new PublicKey(mint), 'confirmed');
    return {
      mintOk:   info.mintAuthority === null,
      freezeOk: info.freezeAuthority === null,
    };
  } catch {
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

// ── Check 5: On-chain risk scoring (replaces Rugcheck API — zero rate limits) ─
//
// 4 signals computed entirely from our existing RPC + DexScreener data:
//   A) Token age — first-ever on-chain metadata tx. Age < 3 days = risky.
//   B) Decimal sanity — 0, 1, or ≥18 decimals are common rug patterns.
//   C) Supply magnitude — raw supply >10^15 signals inflation/honeypot.
//   D) Price volatility — |priceChange.h1| >80% in 1h = pump-and-dump flag.
//      (priceChangePct1h passed in from checkLiquidity to avoid extra API call)
//
// Returns rugScore equivalent: 0=safe, higher=riskier (matches old Rugcheck range)
async function checkOnChainRisk(
  mint: string,
  priceChangePct1h: number
): Promise<{ rugScore: number; rugOk: boolean; reasons: string[] }> {
  const conn    = getConn();
  const reasons: string[] = [];
  let   risk    = 0;

  try {
    const mintPubkey = new PublicKey(mint);

    // Signal A: Token age from first signature on the mint account
    try {
      const sigs = await conn.getSignaturesForAddress(mintPubkey, { limit: 1, before: undefined });
      // getSignaturesForAddress returns newest-first, last = oldest; for age we need oldest
      const oldest = await conn.getSignaturesForAddress(mintPubkey, { limit: 1 });
      if (oldest.length > 0 && oldest[0].blockTime) {
        const ageDays = (Date.now() / 1000 - oldest[0].blockTime) / 86400;
        if (ageDays < 1)   { risk += 300; reasons.push(`age<1d(${ageDays.toFixed(1)}d)`); }
        else if (ageDays < 3) { risk += 150; reasons.push(`age<3d(${ageDays.toFixed(1)}d)`); }
        else if (ageDays < 7) { risk +=  50; reasons.push(`age<7d(${ageDays.toFixed(1)}d)`); }
      }
    } catch { /* non-fatal */ }

    // Signal B + C: decimals + supply sanity from getMint (already called in check 1/2)
    try {
      const { getMint: _getMint } = await import('@solana/spl-token');
      const mintInfo = await _getMint(conn, mintPubkey, 'confirmed');
      const dec      = mintInfo.decimals;
      const supply   = Number(mintInfo.supply);

      // Decimals: standard is 6 or 9. 0/1 = fractional impossible. 18+ = ERC-20 copy-paste.
      if (dec === 0 || dec === 1 || dec >= 18) {
        risk += 200; reasons.push(`bad-decimals(${dec})`);
      }
      // Supply: >10^15 raw with 9 decimals = >1M tokens of 10^6 each = inflation attack
      const normalizedSupply = dec > 0 ? supply / Math.pow(10, dec) : supply;
      if (normalizedSupply > 1e15) { risk += 200; reasons.push(`huge-supply(${normalizedSupply.toExponential(1)})`); }
    } catch { /* non-fatal */ }

    // Signal D: 1h price volatility (passed from DexScreener liquidity check)
    if (priceChangePct1h > 200) { risk += 300; reasons.push(`volatile-200pct+1h`); }
    else if (priceChangePct1h > 80)  { risk += 150; reasons.push(`volatile-80pct+1h`); }
    else if (priceChangePct1h > 40)  { risk +=  50; reasons.push(`volatile-40pct+1h`); }

  } catch (e: any) {
    logger.debug(`[SCREENER] On-chain risk check failed for ${mint.slice(0,8)}: ${e.message}`);
  }

  // Map to Rugcheck-equivalent scale (0=clean, >800=high-risk)
  return { rugScore: risk, rugOk: risk < 800, reasons };
}

// ── Check: DexScreener liquidity + 1h price volatility ──────────────────────
async function checkLiquidity(mint: string): Promise<{ liqUsd: number; liqOk: boolean; priceChangePct1h: number }> {
  const data = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  if (!data?.pairs?.length) return { liqUsd: 0, liqOk: false, priceChangePct1h: 0 };

  const solPairs = data.pairs.filter((p: any) => p.chainId === 'solana');
  if (!solPairs.length) return { liqUsd: 0, liqOk: false, priceChangePct1h: 0 };

  const best       = solPairs.reduce((a: any, b: any) => (b.liquidity?.usd || 0) > (a.liquidity?.usd || 0) ? b : a);
  const maxLiq     = best.liquidity?.usd || 0;
  const pChange1h  = Math.abs(parseFloat(best.priceChange?.h1 || '0'));
  return { liqUsd: maxLiq, liqOk: maxLiq >= MIN_LIQUIDITY_USD, priceChangePct1h: pChange1h };
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

  // —— Refresh Jupiter strict list (no-op if loaded within 24h) —————————
  await loadJupiterStrictList().catch(() => {});

  // —— All checks fire in parallel: on-chain + 4 external APIs ——————————
  const jupStrict = checkJupiterStrict(mint); // sync — cached Set
  const [
    authorities, liquidity, holderData,
    rugcheck, gecko, solscan,
  ] = await Promise.all([
    checkMintAuthorities(mint),
    checkLiquidity(mint),
    checkHelius(mint),
    // Skip Rugcheck for JP-verified tokens to save quota
    jupStrict.verified ? Promise.resolve({ score: 0, risks: [], ok: true }) : checkRugcheck(mint),
    checkGeckoTerminal(mint),
    checkSolscan(mint),
  ]);

  // On-chain risk (reuses priceChangePct1h — no extra API call)
  const rug = await checkOnChainRisk(mint, liquidity.priceChangePct1h);

  // —— Apply Jupiter strict bonus (−60 pts needed → still need 40+ to pass) ——
  if (jupStrict.verified) {
    score += jupStrict.bonus;
    reasons.push('jup-strict-verified(+20)');
  }

  // Check 1: Mint authority (hard block)
  if (!authorities.mintOk)  { reasons.push('mint-authority-active');  score -= 40; }
  // Check 2: Freeze authority (hard block)
  if (!authorities.freezeOk){ reasons.push('freeze-authority-active'); score -= 30; }
  // Check 3: Liquidity
  if (!liquidity.liqOk)     { reasons.push(`low-liq($${liquidity.liqUsd.toFixed(0)}<$${MIN_LIQUIDITY_USD})`); score -= 20; }
  else if (liquidity.liqUsd > 50_000) score += 5; // deep pool bonus
  // Check 4: Holder concentration (Helius)
  if (!holderData.holderOk) { reasons.push(`concentrated(${(holderData.topHolderPct * 100).toFixed(0)}%)`); score -= 15; }
  // Check 5: On-chain risk
  if (!rug.rugOk)           { reasons.push(`onchain-risk-${rug.rugScore}(${rug.reasons.join('+')})`); score -= 25; }
  else if (rug.reasons.length > 0) { reasons.push(`onchain-warn(${rug.reasons.join('+')})`); score -= 10; }

  // Check 8: Rugcheck.xyz
  if (rugcheck.score >= 0) {
    if (rugcheck.score > 500) {
      reasons.push(`rugcheck-high(${rugcheck.score}:${rugcheck.risks.join(',')})`);
      score -= 35;
    } else if (rugcheck.score > 300) {
      reasons.push(`rugcheck-mod(${rugcheck.score})`);
      score -= 15;
    } else if (rugcheck.score < 100) {
      score += 10; // clean rugcheck bonus
      reasons.push(`rugcheck-clean(${rugcheck.score})`);
    }
  }

  // Check 9: GeckoTerminal buy/sell pressure
  for (const f of gecko.flags) { reasons.push(`gecko:${f}`); }
  if (gecko.flags.some(f => f.startsWith('sell-pressure')))  score -= 20;
  if (gecko.flags.some(f => f.startsWith('thin-activity')))  score -= 15;
  if (gecko.flags.some(f => f.startsWith('low-vol')))        score -=  8;
  if (gecko.volumeUsd24h > 50_000 && gecko.buySellRatio >= 0.8) { score += 10; } // strong buy side

  // Check 10: Solscan holder distribution
  for (const f of solscan.flags) { reasons.push(`solscan:${f}`); }
  if (solscan.flags.some(f => f.startsWith('whale-top3')))   score -= 25;
  else if (solscan.flags.some(f => f.startsWith('conc-top3'))) score -= 10;
  if (solscan.flags.some(f => f.startsWith('thin-holders'))) score -= 20;
  if (solscan.holderCount > 1000) { score += 5; } // broad holder base bonus

  logger.debug(
    `[SCREENER] ${mint.slice(0,8)}… jup:${jupStrict.verified?'✓':'✗'} rug:${rugcheck.score} ` +
    `gecko:vol$${gecko.volumeUsd24h.toFixed(0)}/ratio:${gecko.buySellRatio.toFixed(2)} ` +
    `solscan:${solscan.holderCount}holders/${(solscan.top3Pct*100).toFixed(0)}%top3`
  );

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

  // Use longer TTL for passing tokens, shorter for rejects (conditions can change)
  const ttl = safe ? CACHE_TTL_PASS_MS : CACHE_TTL_FAIL_MS;
  const result: ScreenResult = { mint, safe, score, reasons, cachedAt: Date.now() };
  cache.set(mint, result);

  // Auto-evict based on TTL
  setTimeout(() => { if (cache.get(mint)?.cachedAt === result.cachedAt) cache.delete(mint); }, ttl);

  return result;
}

// ── Evict stale cache entries every 15 min ────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.cachedAt > CACHE_TTL_MS) cache.delete(k);
  }
}, 15 * 60 * 1000);
