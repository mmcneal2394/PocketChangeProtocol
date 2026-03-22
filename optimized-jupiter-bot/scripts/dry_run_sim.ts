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
const CAPITAL_USD   = parseFloat(args[args.indexOf('--capital')   + 1] || '200');
const DURATION_MIN  = parseInt (args[args.indexOf('--duration')   + 1] || '60');
const REPORT_EVERY  = parseInt (args[args.indexOf('--report')     + 1] || '5'); // min

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ── Rate-limit tracker ────────────────────────────────────────────────────────
const RL = {
  jupiter:     { calls: 0, errors429: 0, lastReset: Date.now(), windowMs: 60_000, maxPerMin: 60  },
  dexscreener: { calls: 0, errors429: 0, lastReset: Date.now(), windowMs: 60_000, maxPerMin: 30  },
  rugcheck:    { calls: 0, errors429: 0, lastReset: Date.now(), windowMs: 60_000, maxPerMin: 20  },
  helius:      { calls: 0, errors429: 0, lastReset: Date.now(), windowMs: 60_000, maxPerMin: 100 },
  pumpfun:     { calls: 0, errors429: 0, lastReset: Date.now(), windowMs: 60_000, maxPerMin: 10  },
};

function trackCall(source: keyof typeof RL, status: number) {
  const r = RL[source];
  const now = Date.now();
  if (now - r.lastReset > r.windowMs) { r.calls = 0; r.lastReset = now; }
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
      'jupiter',
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

  // Fallback — user confirmed ~$90 (2026-03-22)
  console.warn(`   ⚠️  All price APIs failed — using fallback: $90`);
  return 90;
}

// ── In-process screen cache (10 min TTL) ─────────────────────────────────────
const screenCache = new Map<string, { result: { safe: boolean; score: number; flags: string[] }; ts: number }>();
const SCREEN_TTL = 10 * 60 * 1000;

// ── Screener summary (lightweight, cached) ────────────────────────────────────
async function screenTokenLight(mint: string): Promise<{ safe: boolean; score: number; flags: string[] }> {
  const cached = screenCache.get(mint);
  if (cached && Date.now() - cached.ts < SCREEN_TTL) return cached.result;

  const flags: string[] = [];
  let score = 100;

  // Run DexScreener + Rugcheck in parallel
  const [dsRes, rugRes] = await Promise.all([
    rateLimitedFetch('dexscreener', `https://api.dexscreener.com/latest/dex/tokens/${mint}`),
    rateLimitedFetch('rugcheck',    `https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`),
  ]);

  if (dsRes.status  === 429) session.rateLimitWarnings.push(`DexScreener 429 ${mint.slice(0,8)}`);
  if (rugRes.status === 429) session.rateLimitWarnings.push(`Rugcheck 429 ${mint.slice(0,8)}`);

  const solPairs = (dsRes.data?.pairs || []).filter((p: any) => p.chainId === 'solana');
  const maxLiq   = solPairs.length ? Math.max(...solPairs.map((p: any) => p.liquidity?.usd || 0)) : 0;
  if (maxLiq < 500)    { flags.push(`low-liq($${maxLiq.toFixed(0)})`); score -= 25; }
  if (maxLiq > 100000) score += 10;

  const rugScore = rugRes.data?.score ?? rugRes.data?.risk_score;
  if (rugScore != null && rugScore > 800) { flags.push(`rug-score-${rugScore}`); score -= 30; }

  const result = { safe: score >= 40, score: Math.max(0, score), flags };
  screenCache.set(mint, { result, ts: Date.now() });
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

  // Use authenticated Jupiter endpoint + API key from .env
  const API_KEY = process.env.JUPITER_API_KEY || '';
  const headers: any = API_KEY ? { 'x-api-key': API_KEY } : {};

  // Quote leg 1: SOL → Token (use lite-api)
  const LITE   = 'https://lite-api.jup.ag/swap/v1';
  const q1Url  = `${LITE}/quote?inputMint=${WSOL}&outputMint=${mint}&amount=${lamports}&slippageBps=${slip}`;
  const { data: q1, status: q1Status } = await rateLimitedFetch('jupiter', q1Url, { headers });
  if (q1Status === 429) { session.rateLimitWarnings.push(`Jupiter 429 leg1 ${mint.slice(0,8)}`); return null; }
  if (!q1?.outAmount) {
    if (q1Status !== 0) session.inputParseErrors.push(`q1 null outAmount ${mint.slice(0,8)} (${q1Status})`);
    return null;
  }

  const interAmt = Number(q1.outAmount);
  if (isNaN(interAmt) || interAmt <= 0) { session.inputParseErrors.push(`q1 invalid: "${q1.outAmount}" ${mint.slice(0,8)}`); return null; }

  // Quote leg 2: Token → SOL
  const q2Url = `${LITE}/quote?inputMint=${mint}&outputMint=${WSOL}&amount=${interAmt}&slippageBps=${slip}`;
  const { data: q2, status: q2Status } = await rateLimitedFetch('jupiter', q2Url, { headers });
  if (q2Status === 429) { session.rateLimitWarnings.push(`Jupiter 429 leg2 ${mint.slice(0,8)}`); return null; }
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
    const screen = await screenTokenLight(mint);
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
          const screen = await screenTokenLight(mint);
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

    await new Promise(r => setTimeout(r, 2000)); // 2s between batches

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
