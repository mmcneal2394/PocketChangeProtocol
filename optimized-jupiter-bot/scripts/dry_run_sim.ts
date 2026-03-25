/**
 * dry_run_sim.ts  —  $200 Paper-Trade Pipeline Simulation
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs the full arb pipeline (discovery → screening → quote → P&L calc) for
 * 1 hour WITHOUT executing any real transactions.
 *
 * Usage:
 *   npx ts-node scripts/dry_run_sim.ts
 *   npx ts-node scripts/dry_run_sim.ts --capital 200 --duration 60
 *
 * Output: dry_run_results.json  +  console logs every 5 minutes
 * ─────────────────────────────────────────────────────────────────────────────
 */

import dotenv from 'dotenv';
dotenv.config();

import fs   from 'fs';
import path from 'path';

// ── CLI args ──────────────────────────────────────────────────────────────────
const args          = process.argv.slice(2);
const MIN_MODE      = args.includes('--min-mode');

// ── Min-mode overrides (must set before any module reads process.env) ─────────
// Targets ~$5 operation: 0.005 SOL trade size, batch 1, no LST floor.
if (MIN_MODE) {
  process.env.MIN_MODE             = 'true';
  process.env.SCAN_BATCH_SIZE      = '1';         // one route at a time
  process.env.LST_MIN_TRADE_SOL    = '0.005';     // disable LST 1 SOL floor
  process.env.MAX_TRADE_SIZE_SOL   = '0.005';     // $0.45 per trade at $90/SOL
  process.env.PRIORITY_MICRO_LAMPORTS = '100000'; // lower priority fee
}

// Safe named-arg parser — returns undefined if the next token is another flag or missing
function argVal(name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const next = args[i + 1];
  return (next && !next.startsWith('--')) ? next : undefined;
}

const CAPITAL_USD  = parseFloat(argVal('--capital')  ?? (MIN_MODE ? '5'   : '200'));
const DURATION_MIN = parseInt  (argVal('--duration') ?? '60');
const REPORT_EVERY = parseInt  (argVal('--report')   ?? '5');


const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';


// ── Rate-limit tracker ────────────────────────────────────────────────────────
// jupiter_auth = authenticated quote-api.jup.ag  (600 req/min)
// jupiter_free = unauthenticated lite-api.jup.ag (60 req/min, used as fallback)
const RL = {
  jupiter_auth:   { calls: 0, errors429: 0, lastReset: Date.now(), windowMs: 60_000, maxPerMin: 600 },
  jupiter_free:   { calls: 0, errors429: 0, lastReset: Date.now(), windowMs: 60_000, maxPerMin: 60  },
  dexscreener:    { calls: 0, errors429: 0, lastReset: Date.now(), windowMs: 60_000, maxPerMin: 30  },
  rugcheck:       { calls: 0, errors429: 0, lastReset: Date.now(), windowMs: 60_000, maxPerMin: 20  },
  geckoterminal:  { calls: 0, errors429: 0, lastReset: Date.now(), windowMs: 60_000, maxPerMin: 8   }, // conservative: 8 token screens/min
  solscan:        { calls: 0, errors429: 0, lastReset: Date.now(), windowMs: 60_000, maxPerMin: 30  },
  helius:         { calls: 0, errors429: 0, lastReset: Date.now(), windowMs: 60_000, maxPerMin: 100 },
  pumpfun:        { calls: 0, errors429: 0, lastReset: Date.now(), windowMs: 60_000, maxPerMin: 10  },
};

function trackCall(source: keyof typeof RL, status: number) {
  const r = RL[source];
  const now = Date.now();
  if (now - r.lastReset > r.windowMs) { r.calls = 0; r.errors429 = 0; r.lastReset = now; }
  r.calls++;
  if (status === 429) r.errors429++;
}

async function rateLimitedFetch(
  source: keyof typeof RL,
  url: string,
  opts: RequestInit = {}
): Promise<{ ok: boolean; data: any; status: number }> {
  const r = RL[source];
  // Throttle: if near limit, wait
  if (r.calls >= r.maxPerMin * 0.85) {
    const wait = Math.max(0, r.windowMs - (Date.now() - r.lastReset));
    if (wait > 0) await new Promise(res => setTimeout(res, Math.min(wait, 2000)));
  }

  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res    = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(t);
    trackCall(source, res.status);
    const data = res.ok ? await res.json().catch(() => null) : null;
    return { ok: res.ok, data, status: res.status };
  } catch (e: any) {
    clearTimeout(t);
    trackCall(source, 0);
    return { ok: false, data: null, status: 0 };
  }
}

// ── Session stats ─────────────────────────────────────────────────────────────
interface SimSession {
  startedAt:         string;
  capitalUsd:        number;
  capitalSol:        number;
  solPriceUsd:       number;
  durationMin:       number;
  tokensDiscovered:  number;
  tokensBlocked:     string[];    // mint + reason
  tokensApproved:    number;
  routesScanned:     number;
  opportunitiesFound: number;
  bestOpportunity:   any;
  simulatedTradesExecuted: number;
  simulatedPnlSol:   number;
  simulatedPnlUsd:   number;
  inputParseErrors:  string[];
  rateLimitWarnings: string[];
  checkpoints:       any[];
  endedAt?:          string;
}

const session: SimSession = {
  startedAt:          new Date().toISOString(),
  capitalUsd:         CAPITAL_USD,
  capitalSol:         0,
  solPriceUsd:        0,
  durationMin:        DURATION_MIN,
  tokensDiscovered:   0,
  tokensBlocked:      [],
  tokensApproved:     0,
  routesScanned:      0,
  opportunitiesFound: 0,
  bestOpportunity:    null,
  simulatedTradesExecuted: 0,
  simulatedPnlSol:    0,
  simulatedPnlUsd:    0,
  inputParseErrors:   [],
  rateLimitWarnings:  [],
  checkpoints:        [],
};

// ── Validate all required env inputs ─────────────────────────────────────────
function validateEnv(): string[] {
  const errors: string[] = [];
  const required = [
    'RPC_ENDPOINT', 'WALLET_PUBLIC_KEY', 'JUPITER_ENDPOINT',
    'JITO_BLOCK_ENGINE', 'SLIPPAGE_BPS', 'MIN_PROFIT_BPS',
  ];
  for (const key of required) {
    if (!process.env[key]) errors.push(`Missing env: ${key}`);
  }
  // Type checks
  if (process.env.SLIPPAGE_BPS && isNaN(Number(process.env.SLIPPAGE_BPS)))
    errors.push(`SLIPPAGE_BPS is not a number: "${process.env.SLIPPAGE_BPS}"`);
  if (process.env.MIN_PROFIT_BPS && isNaN(Number(process.env.MIN_PROFIT_BPS)))
    errors.push(`MIN_PROFIT_BPS is not a number: "${process.env.MIN_PROFIT_BPS}"`);
  if (process.env.MAX_TRADE_SIZE_SOL && isNaN(Number(process.env.MAX_TRADE_SIZE_SOL)))
    errors.push(`MAX_TRADE_SIZE_SOL not a number: "${process.env.MAX_TRADE_SIZE_SOL}"`);
  return errors;
}

// ── Fetch current SOL price (tries 3 sources) ────────────────────────────────
async function getSolPrice(): Promise<number> {
  // Source 1: Jupiter Price API v2
  try {
    const { data: d1 } = await rateLimitedFetch(
      'jupiter_auth',
      'https://price.jup.ag/v6/price?ids=SOL',
    );
    const p1 = parseFloat(d1?.data?.SOL?.price || '0');
    if (p1 > 0) { console.log(`   Source: Jupiter v6 → $${p1.toFixed(2)}`); return p1; }
  } catch {}

  // Source 2: CoinGecko public (no key needed)
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      { signal: ctrl.signal }
    );
    clearTimeout(t);
    const d2 = await r.json();
    const p2 = parseFloat(d2?.solana?.usd || '0');
    if (p2 > 0) { console.log(`   Source: CoinGecko → $${p2.toFixed(2)}`); return p2; }
  } catch {}

  // Source 3: Binance public ticker
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { signal: ctrl.signal });
    clearTimeout(t);
    const d3 = await r.json();
    const p3 = parseFloat(d3?.price || '0');
    if (p3 > 0) { console.log(`   Source: Binance → $${p3.toFixed(2)}`); return p3; }
  } catch {}

  // Fallback
  console.warn(`   ⚠️  All price APIs failed — using fallback: $90`);
  return 90;
}

// ── In-process screen cache (30 min TTL for pass, 5 min for fail) ────────────
const screenCache = new Map<string, { result: { safe: boolean; score: number; flags: string[] }; ts: number; pass: boolean }>();
const SCREEN_TTL_PASS = 30 * 60 * 1000;
const SCREEN_TTL_FAIL =  5 * 60 * 1000;

let jupStrictSet:   Set<string> = new Set();
let jupStrictTs     = 0;
const SIM_TRUSTED = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  // USDT
]);
async function ensureJupStrict(): Promise<void> {
  if (Date.now() - jupStrictTs < 24 * 3600_000) return;
  try {
    const r = await fetch('https://token.jup.ag/strict', { signal: AbortSignal.timeout(8000) });
    if (r.ok) { const d = await r.json(); jupStrictSet = new Set(d.map((t: any) => t.address)); jupStrictTs = Date.now(); }
  } catch { /* degrade gracefully */ }
}

// ── GeckoTerminal call stagger ─────────────────────────────────────────────────────────
// Serialises gecko calls with 900ms gap to prevent 8-token parallel burst
// from saturating the limit (30 req/min ≈ 2s between calls in the strict sense).
let geckoLastCallTs = 0;
async function geckoFetch(mint: string): ReturnType<typeof rateLimitedFetch> {
  const now  = Date.now();
  const wait = Math.max(0, geckoLastCallTs + 900 - now);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  geckoLastCallTs = Date.now();
  return rateLimitedFetch(
    'geckoterminal',
    `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}?include=top_pools`,
    { headers: { 'Accept': 'application/json;version=20230302' } }
  );
}

// ── screenTokenFull — all 4 validation APIs + existing on-chain checks ────────
// Checks (parallel):
//   A) DexScreener      — liquidity, 1h volatility  (existing)
//   B) On-chain RPC     — mint/freeze/decimals/supply/age  (existing)
//   C) Jupiter strict   — +20 verified bonus, skip Rugcheck if listed
//   D) Rugcheck.xyz     — composite risk score 0-1000
//   E) GeckoTerminal    — 24h volume, buy/sell ratio, pool depth
//   F) Solscan          — holder count, top-3 whale concentration
async function screenTokenFull(mint: string): Promise<{ safe: boolean; score: number; flags: string[] }> {
  const cached = screenCache.get(mint);
  if (cached) {
    const ttl = cached.pass ? SCREEN_TTL_PASS : SCREEN_TTL_FAIL;
    if (Date.now() - cached.ts < ttl) return cached.result;
  }

  const flags: string[] = [];
  let score = 100;
  await ensureJupStrict();

  // —— A) DexScreener —————————————————————————————————————————
  const dsRes = await rateLimitedFetch('dexscreener', `https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  if (dsRes.status === 429) session.rateLimitWarnings.push(`DexScreener 429 ${mint.slice(0,8)}`);
  const solPairs   = (dsRes.data?.pairs || []).filter((p: any) => p.chainId === 'solana');
  const best       = solPairs.reduce((a: any, b: any) => (b.liquidity?.usd || 0) > (a.liquidity?.usd || 0) ? b : a, {});
  const maxLiq     = best?.liquidity?.usd || 0;
  const priceChg1h = Math.abs(parseFloat(best?.priceChange?.h1 || '0'));
  if (maxLiq < 500)         { flags.push(`low-liq($${maxLiq.toFixed(0)})`); score -= 25; }
  if (maxLiq > 100_000)     score += 10;
  if (priceChg1h > 200)     { flags.push(`volatile-200%+1h`); score -= 20; }
  else if (priceChg1h > 80) { flags.push(`volatile-80%+1h`);  score -= 10; }

  // —— B) On-chain RPC ————————————————————————————————————————
  try {
    const rpc = process.env.RPC_ENDPOINT || '';
    const { Connection: Conn, PublicKey: PK } = await import('@solana/web3.js');
    const { getMint: gm } = await import('@solana/spl-token');
    const conn = new Conn(rpc, 'confirmed');
    const pk   = new PK(mint);
    const info = await gm(conn, pk, 'confirmed');
    if (!SIM_TRUSTED.has(mint) && info.mintAuthority !== null)   { flags.push('mint-auth-active');   score -= 40; }
    if (!SIM_TRUSTED.has(mint) && info.freezeAuthority !== null) { flags.push('freeze-auth-active'); score -= 30; }
    const dec = info.decimals;
    if (dec === 0 || dec === 1 || dec >= 18) { flags.push(`bad-decimals(${dec})`); score -= 15; }
    const normSupply = dec > 0 ? Number(info.supply) / Math.pow(10, dec) : Number(info.supply);
    if (normSupply > 1e15) { flags.push('huge-supply'); score -= 15; }
    const sigs = await conn.getSignaturesForAddress(pk, { limit: 1 });
    if (sigs.length > 0 && sigs[0].blockTime) {
      const ageDays = (Date.now() / 1000 - sigs[0].blockTime) / 86400;
      if (ageDays < 1)      { flags.push('age<1d'); score -= 20; }
      else if (ageDays < 3) { flags.push('age<3d'); score -=  8; }
    }
  } catch { /* RPC unavailable — skip */ }

  // —— C) Jupiter strict list ————————————————————————————————
  const jupVerified = SIM_TRUSTED.has(mint) || jupStrictSet.has(mint);
  if (jupVerified) { score += 20; flags.push('jup-strict-verified(+20)'); }

  // —— D + E + F running in parallel ——————————————————————————————
  const [rugRes, geckoRes, solRes] = await Promise.allSettled([
    // D) Rugcheck — skip for Jupiter-verified (save the 20/min budget)
    jupVerified
      ? Promise.resolve({ score: -1, risks: [] })
      : rateLimitedFetch('rugcheck', `https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`).then(r => ({
          score: r.data?.score ?? r.data?.risk_score ?? -1 as number,
          risks: ((r.data?.risks || []) as any[]).map((x:any) => `${x.name}(${x.level})`).slice(0,3),
        })).catch(() => ({ score: -1, risks: [] })),
    // E) GeckoTerminal — staggered (geckoFetch enforces 900ms gap between calls)
    geckoFetch(mint).then(r => {
      const attr = r.data?.data?.attributes;
      if (!attr) return null;
      const vol24h = parseFloat(attr.volume_usd?.h24 || '0');
      let buys = 0, sells = 0;
      for (const pool of (r.data?.included || [])) {
        const txns = pool?.attributes?.transactions?.h24;
        if (txns) { buys += txns.buys || 0; sells += txns.sells || 0; }
      }
      const ratio = sells > 0 ? buys / sells : (buys > 0 ? 2 : 1);
      return { vol24h, buys, sells, ratio };
    }).catch(() => null),
    // F) Solscan
    rateLimitedFetch('solscan',
      `https://public-api.solscan.io/token/holders?tokenAddress=${mint}&limit=10&offset=0`
    ).then(r => {
      const holders: any[] = r.data?.data ?? [];
      if (!holders.length) return null;
      const amts = holders.map((h:any) => parseFloat(h.amount || '0'));
      const tot  = amts.reduce((a,b) => a+b, 0);
      const top3 = amts.slice(0,3).reduce((a,b) => a+b, 0);
      return { total: r.data?.total ?? 0, top3Pct: tot > 0 ? top3/tot : 0 };
    }).catch(() => null),
  ]);

  // D) Apply Rugcheck result
  if (rugRes.status === 'fulfilled') {
    const rc = rugRes.value;
    if (rc.score >= 500) { flags.push(`rugcheck-high(${rc.score})`); score -= 35;
    } else if (rc.score >= 300) { flags.push(`rugcheck-mod(${rc.score})`); score -= 15;
    } else if (rc.score >= 0 && rc.score < 100) { flags.push(`rugcheck-clean(${rc.score})`); score += 10; }
    if (rugRes.status === 'fulfilled' && rc.score === 429) session.rateLimitWarnings.push(`Rugcheck 429 ${mint.slice(0,8)}`);
  }

  // E) Apply GeckoTerminal result
  if (geckoRes.status === 'fulfilled' && geckoRes.value) {
    const g = geckoRes.value;
    if (g.vol24h > 0 && g.vol24h < 1000) { flags.push(`gecko:low-vol($${g.vol24h.toFixed(0)})`); score -= 8; }
    if (g.ratio < 0.4)                    { flags.push(`gecko:sell-pres(${g.ratio.toFixed(2)})`); score -= 20; }
    if (g.buys + g.sells < 10)            { flags.push(`gecko:thin-txns(${g.buys+g.sells})`); score -= 15; }
    if (g.vol24h > 50_000 && g.ratio >= 0.8) score += 10;
  } else if (geckoRes.status === 'fulfilled' && geckoRes.value === null) {
    flags.push('gecko:no-data'); // token not indexed yet — neutral
  }

  // F) Apply Solscan result
  if (solRes.status === 'fulfilled' && solRes.value) {
    const s = solRes.value;
    if (s.total > 0 && s.total < 50) { flags.push(`solscan:thin-holders(${s.total})`); score -= 20; }
    if (s.top3Pct > 0.80)            { flags.push(`solscan:whale-top3(${(s.top3Pct*100).toFixed(0)}%)`); score -= 25; }
    else if (s.top3Pct > 0.60)       { flags.push(`solscan:conc-top3(${(s.top3Pct*100).toFixed(0)}%)`); score -= 10; }
    if (s.total > 1000)               score += 5;
  }

  const safe   = score >= 40;
  const result = { safe, score: Math.max(0, score), flags };
  screenCache.set(mint, { result, ts: Date.now(), pass: safe });
  return result;
}

// ── ATA gas cost model (proposal 5) ─────────────────────────────────────────
const ATA_PRE_CREATED_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  // USDT
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // MSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',  // jitoSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',   // bSOL
  'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',   // ORCA
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',  // RAY
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',  // BONK
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYtM2wYSzRo',  // WIF
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbPwdrsxGBK',    // JUP
]);
const GAS_FLOOR_LAM   = 5_000;          // priority fee only (ATA pre-created)
const ATA_RENT_LAM    = 2_039_280;      // full rent if ATA doesn't exist
const LST_MIN_TRADE   = 1.0;            // [7] 1 SOL floor for defi routes

// Per-category slippage [2]
const CAT_SLIP: Record<string, number> = { bluechip: 30, defi: 50, meme: 100, launch: 200, native: 150, default: 50 };

// ── Dual-endpoint Jupiter quote helper ───────────────────────────────────────────────
// 1️⃣  Tries authenticated quote-api.jup.ag  (600 req/min)
// 2️⃣  On 429 or failure: falls back to lite-api.jup.ag (60 req/min, keyless)
// Returns the quote JSON on success, null on permanent failure.
const JAUTH = 'https://quote-api.jup.ag/v6';   // authenticated  — 600 req/min
const JFREE = 'https://lite-api.jup.ag/swap/v1'; // unauthenticated — 60 req/min
const JAUTH_KEY = process.env.JUPITER_API_KEY || '';
const JAUTH_HEADERS: Record<string, string> = JAUTH_KEY ? { 'x-api-key': JAUTH_KEY } : {};

async function jupiterQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number,
  mintLabel: string,
  leg: string
): Promise<any | null> {
  // —— Attempt 1: authenticated endpoint (600/min) ——————————————————————
  if (JAUTH_KEY) {
    const url = `${JAUTH}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
    const res = await rateLimitedFetch('jupiter_auth', url, { headers: JAUTH_HEADERS });
    if (res.ok && res.data?.outAmount) {
      return res.data; // ✅ auth success
    }
    if (res.status !== 429) {
      // Hard error (400, 0, etc.) — no point retrying on free tier for same mint
      if (res.status !== 0) session.inputParseErrors.push(`${leg} null outAmount ${mintLabel} (${res.status})`);
      return null;
    }
    // 429 on auth — fall through to free tier
    session.rateLimitWarnings.push(`Jupiter auth 429 ${leg} ${mintLabel}`);
  }

  // —— Attempt 2: free / lite-api fallback (60/min) ———————————————————
  const freeUrl = `${JFREE}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
  const freeRes = await rateLimitedFetch('jupiter_free', freeUrl);
  if (freeRes.ok && freeRes.data?.outAmount) {
    return freeRes.data; // ⚠️  free-tier hit — logged via RL tracker
  }
  if (freeRes.status === 429) {
    session.rateLimitWarnings.push(`Jupiter free 429 ${leg} ${mintLabel}`);
  } else if (freeRes.status !== 0) {
    session.inputParseErrors.push(`${leg} null outAmount ${mintLabel} (${freeRes.status})`);
  }
  return null;
}

// ── Simulate one arb scan on a route (ATA-aware) ─────────────────────────
async function simArbRoute(
  mint: string,
  tradeSol: number,
  cat: string
): Promise<{ profitSol: number; profitBps: number; found: boolean; gasSol: number } | null> {
  const slip    = CAT_SLIP[cat] ?? CAT_SLIP.default;
  // [7] LST minimum trade size
  const actualTrade = cat === 'defi' ? Math.max(tradeSol, LST_MIN_TRADE) : tradeSol;
  const lamports = Math.floor(actualTrade * 1e9);

  // ── Dual-endpoint Jupiter quote: auth (600/min) → fallback free (60/min) ──
  const q1 = await jupiterQuote(WSOL, mint, lamports, slip, mint.slice(0,8), 'leg1');
  if (q1 === null) return null;

  const interAmt = Number(q1.outAmount);
  if (isNaN(interAmt) || interAmt <= 0) { session.inputParseErrors.push(`q1 invalid: "${q1.outAmount}" ${mint.slice(0,8)}`); return null; }

  // Quote leg 2: Token → SOL
  const q2 = await jupiterQuote(mint, WSOL, interAmt, slip, mint.slice(0,8), 'leg2');
  if (!q2?.outAmount) return null;

  const outAmt = Number(q2.outAmount);
  if (isNaN(outAmt)) { session.inputParseErrors.push(`q2 invalid: "${q2.outAmount}" ${mint.slice(0,8)}`); return null; }

  const grossLam  = outAmt - lamports;
  const gasLam    = ATA_PRE_CREATED_MINTS.has(mint) ? GAS_FLOOR_LAM : ATA_RENT_LAM + GAS_FLOOR_LAM;
  const netLam    = grossLam - gasLam;
  const profitSol = netLam / 1e9;
  const profitBps = (netLam / lamports) * 10_000;

  return { profitSol, profitBps, found: profitSol > 0, gasSol: gasLam / 1e9 };
}

// ── Checkpoint reporter ───────────────────────────────────────────────────────
function checkpoint(label: string) {
  const elapsed     = (Date.now() - startTime) / 60_000;
  const rlSummary   = Object.entries(RL).map(([k, v]) =>
    `${k}:${v.calls}calls/${v.errors429}x429`).join(' | ');

  const cp = {
    label,
    elapsedMin:    elapsed.toFixed(1),
    discovered:    session.tokensDiscovered,
    approved:      session.tokensApproved,
    blocked:       session.tokensBlocked.length,
    scanned:       session.routesScanned,
    opps:          session.opportunitiesFound,
    simTrades:     session.simulatedTradesExecuted,
    simPnlSol:     session.simulatedPnlSol.toFixed(6),
    simPnlUsd:     (session.simulatedPnlSol * session.solPriceUsd).toFixed(2),
    parseErrors:   session.inputParseErrors.length,
    rlWarnings:    session.rateLimitWarnings.length,
    rateLimits:    rlSummary,
    capitalRemSol: session.capitalSol.toFixed(4),
  };

  session.checkpoints.push(cp);
  console.log(`\n═══════════ [${label} @ ${elapsed.toFixed(1)}min] ═══════════`);
  console.log(`  Tokens   : ${cp.discovered} discovered | ${cp.approved} passed | ${cp.blocked} blocked`);
  console.log(`  Scanning : ${cp.scanned} routes scanned | ${cp.opps} opps found | ${cp.simTrades} sim-executed`);
  console.log(`  PnL      : ${cp.simPnlSol} SOL ($${cp.simPnlUsd}) simulated`);
  console.log(`  Capital  : ${cp.capitalRemSol} SOL remaining`);
  console.log(`  Errors   : ${cp.parseErrors} parse | ${cp.rlWarnings} rate-limit warnings`);
  console.log(`  API calls: ${rlSummary}`);
  console.log(`────────────────────────────────────────────────────────────────`);
}

// ── Candidate token list ──────────────────────────────────────────────────────
async function fetchCandidates(): Promise<string[]> {
  const mints = new Set<string>();

  // 1. Pump.fun trending
  const { data: pfData } = await rateLimitedFetch(
    'pumpfun',
    'https://frontend-api.pump.fun/coins?offset=0&limit=30&sort=market_cap&order=DESC&includeNsfw=false'
  );
  (pfData || []).forEach((c: any) => { if (c.mint) mints.add(c.mint); });

  // 2. DexScreener SOL pairs (by volume)
  const { data: dsData } = await rateLimitedFetch(
    'dexscreener',
    'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112'
  );
  (dsData?.pairs || [])
    .filter((p: any) => p.chainId === 'solana')
    .slice(0, 40)
    .forEach((p: any) => { if (p.baseToken?.address) mints.add(p.baseToken.address); });

  // 3. Hardcoded blue-chips (always scan)
  [
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYtM2wYSzRo', // WIF
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
    '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',  // RAY
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbPwdrsxGBK',    // JUP
    'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',   // JTO
    '7GCihgDB8fe6KNjn2gN7ZDB2h2n2i2Z7pW2r2YjN1e8p',  // POPCAT
    '4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS',  // PCP
  ].forEach(m => mints.add(m));

  mints.delete(WSOL);
  return [...mints];
}

// ── Main simulation loop ──────────────────────────────────────────────────────
const startTime      = Date.now();
const endTime        = startTime + DURATION_MIN * 60 * 1000;
const RESULTS_FILE   = path.join(__dirname, '..', 'dry_run_results.json');
const MIN_PROFIT_BPS = parseInt(process.env.MIN_PROFIT_BPS || '5');

async function main() {
  console.log(`\n╔═══════════════════════════════════════════════════════╗`);
  console.log(`║   PCP Arb Engine — DRY RUN SIMULATION                ║`);
  console.log(`║   Capital: $${CAPITAL_USD}  |  Duration: ${DURATION_MIN} min              ║`);
  console.log(`║   NO REAL TRANSACTIONS WILL BE EXECUTED               ║`);
  console.log(`╚═══════════════════════════════════════════════════════╝\n`);

  // 1. Validate environment
  const envErrors = validateEnv();
  if (envErrors.length) {
    console.warn(`⚠️  ENV validation warnings:\n  ${envErrors.join('\n  ')}`);
    session.inputParseErrors.push(...envErrors);
  } else {
    console.log(`✅ All required env variables present and correctly typed`);
  }

  // 2. Get SOL price → convert capital
  console.log(`\n📡 Fetching SOL price...`);
  session.solPriceUsd = await getSolPrice();
  session.capitalSol  = CAPITAL_USD / session.solPriceUsd;
  console.log(`   SOL price: $${session.solPriceUsd.toFixed(2)}`);
  console.log(`   Capital: $${CAPITAL_USD} → ${session.capitalSol.toFixed(4)} SOL`);

  // Trade size = 10% of capital per trade (conservative for dry run)
  const TRADE_SIZE_SOL = Math.min(
    session.capitalSol * 0.10,
    parseFloat(process.env.MAX_TRADE_SIZE_SOL || '0.02')
  );
  console.log(`   Trade size per route: ${TRADE_SIZE_SOL.toFixed(4)} SOL`);

  // 3. Fetch initial token candidates
  console.log(`\n🔍 Fetching token candidates from launchpads...`);
  const candidates = await fetchCandidates();
  console.log(`   Found ${candidates.length} candidate tokens`);

  // 4. Pre-screen all candidates once (parallel, cached for 10min)
  console.log(`\n🛡  Pre-screening ${candidates.length} tokens (parallel)...`);
  let approvedTokens: Array<{ mint: string; cat: string }> = [];
  await Promise.all(candidates.map(async mint => {
    const screen = await screenTokenFull(mint);
    const cat    = ['mSoLz','J1tos','bSo13','orcaE'].some(p => mint.startsWith(p)) ? 'defi'
                 : ['EPjFW','Es9vM'].some(p => mint.startsWith(p)) ? 'bluechip' : 'meme';
    if (screen.safe) {
      approvedTokens.push({ mint, cat });
    } else {
      session.tokensBlocked.push(`${mint.slice(0,8)}…: ${screen.flags.join(',')}`);
      console.log(`   ⛔ ${mint.slice(0,8)}… blocked — ${screen.flags.join(', ')}`);
    }
  }));
  session.tokensDiscovered = candidates.length;
  session.tokensApproved   = approvedTokens.length;
  console.log(`   ✅ ${approvedTokens.length}/${candidates.length} tokens passed screening`);

  // Theoretical P&L comparison (ATA rent saved)
  const ataSavedPerTrade = (ATA_RENT_LAM - GAS_FLOOR_LAM) / 1e9 * session.solPriceUsd;
  console.log(`   💰 ATA pre-created = $${ataSavedPerTrade.toFixed(3)} saved per trade on seeded mints`);

  // 5. [1] Parallel quote loop — batch 5 at a time
  const CONCURRENCY  = 5;
  let candidateIdx   = 0;
  let nextReport     = startTime + REPORT_EVERY * 60 * 1000;
  let nextDiscover   = startTime + 5  * 60 * 1000;
  let nextRescreen   = startTime + 10 * 60 * 1000;

  console.log(`\n▶  Hot scan loop — ${approvedTokens.length} approved routes | batch:${CONCURRENCY} | per-cat slippage\n`);

  while (Date.now() < endTime) {
    if (Date.now() > nextDiscover) {
      const fresh   = await fetchCandidates();
      const newMints = fresh.filter(m => !candidates.includes(m));
      if (newMints.length) {
        console.log(`   🆕 +${newMints.length} new tokens — screening...`);
        await Promise.all(newMints.map(async mint => {
          const screen = await screenTokenFull(mint);
          if (screen.safe) { approvedTokens.push({ mint, cat: 'meme' }); session.tokensApproved++; }
          else session.tokensBlocked.push(`${mint.slice(0,8)}…: ${screen.flags.join(',')}`);
        }));
        candidates.push(...newMints);
        session.tokensDiscovered = candidates.length;
      }
      nextDiscover = Date.now() + 5 * 60 * 1000;
    }
    if (Date.now() > nextRescreen) { screenCache.clear(); nextRescreen = Date.now() + 10 * 60 * 1000; }
    if (approvedTokens.length === 0) { await new Promise(r => setTimeout(r, 2000)); continue; }

    // [1] Batch CONCURRENCY routes at once
    const batch = [];
    for (let i = 0; i < CONCURRENCY; i++) {
      batch.push(approvedTokens[candidateIdx % approvedTokens.length]);
      candidateIdx++;
    }

    // Run batch in parallel
    const results = await Promise.allSettled(
      batch.map(({ mint, cat }) => simArbRoute(mint, TRADE_SIZE_SOL, cat))
    );

    for (let i = 0; i < results.length; i++) {
      session.routesScanned++;
      const r = results[i];
      if (r.status !== 'fulfilled' || r.value === null) continue;
      const result = r.value;
      const { mint, cat } = batch[i];

      if (result.found && result.profitBps >= MIN_PROFIT_BPS) {
        session.opportunitiesFound++;
        session.simulatedTradesExecuted++;
        session.simulatedPnlSol += result.profitSol;
        if (!session.bestOpportunity || result.profitBps > parseFloat(session.bestOpportunity.profitBps)) {
          session.bestOpportunity = {
            mint: mint.slice(0,8)+'…', cat, profitSol: result.profitSol.toFixed(6),
            profitBps: result.profitBps.toFixed(2), tradeSOL: TRADE_SIZE_SOL,
            gasModel: ATA_PRE_CREATED_MINTS.has(mint) ? 'ATA-prebuilt' : 'ATA-rent',
            capturedAt: new Date().toISOString(),
          };
        }
        console.log(`✅ [SIM] ${mint.slice(0,8)}… [${cat}] slip:${CAT_SLIP[cat]||50}bps | +${result.profitBps.toFixed(2)}bps +${result.profitSol.toFixed(6)}SOL | gas:${result.gasSol.toFixed(6)}SOL [DRY RUN]`);
      } else if (Math.random() < 0.05) {
        console.log(`   [SCAN] ${mint.slice(0,8)}… [${cat}] | ${result.profitBps.toFixed(2)}bps | gas:${result.gasSol.toFixed(6)}SOL`);
      }
    }

    await new Promise(r => setTimeout(r, 5000)); // 5s between batches — stays within Jupiter free-tier 60/min

    if (Date.now() > nextReport) {
      checkpoint(`${REPORT_EVERY}min checkpoint`);
      nextReport = Date.now() + REPORT_EVERY * 60 * 1000;
      saveResults();
    }
  }

  // Final report
  session.endedAt = new Date().toISOString();
  session.simulatedPnlUsd = session.simulatedPnlSol * session.solPriceUsd;
  checkpoint('FINAL SUMMARY');

  console.log(`\n╔══════════════════ SIMULATION COMPLETE ════════════════╗`);
  console.log(`║  Duration        : ${DURATION_MIN} minutes`);
  console.log(`║  Capital start   : $${CAPITAL_USD} (${session.capitalSol.toFixed(4)} SOL)`);
  console.log(`║  Routes scanned  : ${session.routesScanned}`);
  console.log(`║  Tokens blocked  : ${session.tokensBlocked.length}`);
  console.log(`║  Opps found      : ${session.opportunitiesFound}`);
  console.log(`║  Sim trades      : ${session.simulatedTradesExecuted}`);
  console.log(`║  Sim PnL         : ${session.simulatedPnlSol.toFixed(6)} SOL ($${session.simulatedPnlUsd.toFixed(2)})`);
  console.log(`║  Best opp        : ${JSON.stringify(session.bestOpportunity)}`);
  console.log(`║  Parse errors    : ${session.inputParseErrors.length}`);
  console.log(`║  Rate-lim warns  : ${session.rateLimitWarnings.length}`);
  if (session.inputParseErrors.length)
    console.log(`║  Errors          : \n║    ${session.inputParseErrors.slice(0,5).join('\n║    ')}`);
  console.log(`║  Results file    : dry_run_results.json`);
  console.log(`╚═══════════════════════════════════════════════════════╝`);

  saveResults();
}

function saveResults() {
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(session, null, 2), 'utf-8');
}

main().catch(e => {
  console.error('Simulation error:', e);
  session.inputParseErrors.push(`FATAL: ${e.message}`);
  saveResults();
  process.exit(1);
});
