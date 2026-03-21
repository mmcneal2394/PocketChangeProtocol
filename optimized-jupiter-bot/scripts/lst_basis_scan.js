/**
 * LST BASIS SCANNER + EXECUTOR
 * ═══════════════════════════════════════════════════════════════════
 *  Monitors mSOL and jitoSOL NAV (net asset value) vs DEX pool price.
 *  Marinade/Jito publish on-chain exchange rates that grow ~8% APY.
 *  When pool price < NAV, buy LST cheap in pool → redeem at NAV.
 *  When pool price > NAV, buy SOL cheap, stake for LST → sell at premium.
 *
 *  Sources:
 *    mSOL NAV:    Marinade state account (on-chain, precise)
 *    jitoSOL NAV: Jito stake pool state account (on-chain)
 *    Pool price:  Jupiter /price API (aggregates all DEX pools)
 * ═══════════════════════════════════════════════════════════════════
 */
'use strict';
require('dotenv').config();

const nodeFetch  = require('node-fetch');
const { Connection, PublicKey } = require('@solana/web3.js');

const HELIUS_RPC = process.env.RPC_ENDPOINT || 'https://mainnet.helius-rpc.com/?api-key=df082a16-aebf-4ec4-8ad6-86abfa06c8fc';
const JUP_KEY   = process.env.JUPITER_API_KEY || '05aa94b2-05d5-4993-acfe-30e18dc35ff1';
const JUP_H_GET  = { 'x-api-key': JUP_KEY };  // GET requests — no Content-Type
const JUP_H      = { 'Content-Type': 'application/json', 'x-api-key': JUP_KEY };  // POST
const JUP_PRICE = 'https://api.jup.ag/price/v3';  // ?ids=MINT&vsToken=MINT


// Token mints
const SOL_MINT   = 'So11111111111111111111111111111111111111112';
const MSOL_MINT  = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So';
const JITOSOL_MINT = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';
const BSOL_MINT  = 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1';

// Marinade state account (holds mSOL exchange rate)
const MARINADE_STATE = new PublicKey('8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC');

const conn = new Connection(HELIUS_RPC, { commitment: 'confirmed' });

function log(m) { console.log(`[${new Date().toISOString().slice(11,19)}] [lst-scan] ${m}`); }

// ── Marinade mSOL Exchange Rate (on-chain) ────────────────────────────────────
// Marinade state layout: bytes 210-226 hold lamports_per_signature and msol_supply
// Simpler: use Marinade stats API which reads the same state
async function getMsolNav() {
  try {
    const r = await nodeFetch('https://api.marinade.finance/msol/price_sol', { timeout: 4000 });
    const t = await r.text();
    const p = parseFloat(t);  // returns raw float e.g. 1.3682060955964617
    if (p > 0) return p;
  } catch(_) {}
  return 0;
}

// ── jitoSOL Exchange Rate ─────────────────────────────────────────────────────
async function getJitosolNav() {
  try {
    // Jito stake pool stats — returns SOL per jitoSOL
    const r = await nodeFetch('https://kobe.mainnet.jito.network/api/v1/validators/vote_accounts?limit=1', { timeout: 4000 });
    const j = await r.json();
    // Fallback: use stake pool API
    throw new Error('try stake pool');
  } catch(_) {}
  try {
    // Jito's stake pool exchange rate
    const r = await nodeFetch('https://stake.jito.network/api/v1/sol_per_jitosol', { timeout: 4000 });
    const t = await r.text();
    const p = parseFloat(t);
    if (p > 0) return p;
  } catch(_) {}
  try {
    // Use Jupiter to estimate jitoSOL/SOL ratio via price API
    const r = await nodeFetch(`${JUP_PRICE}?ids=${JITOSOL_MINT}`, { headers: JUP_H_GET, timeout: 4000 });
    const j = await r.json();
    return parseFloat(j?.data?.[JITOSOL_MINT]?.price) || 0;
  } catch(_) {}
  return 0;
}

// ── DEX Pool Price via Jupiter ────────────────────────────────────────────────
// Cache SOL USD price (refresh every 30s)
let solUsdPrice = 0;
let solUsdFetched = 0;
async function getSolUsd() {
  if (solUsdPrice > 0 && Date.now() - solUsdFetched < 30_000) return solUsdPrice;
  try {
    const r = await nodeFetch(`https://api.jup.ag/price/v3?ids=${SOL_MINT}`, { headers: JUP_H_GET, timeout: 4000 });
    const j = await r.json();
    // Jupiter v3 shape: { mintAddress: { usdPrice: N } }
    const p = parseFloat(j?.[SOL_MINT]?.usdPrice) || 0;
    if (p > 0) { solUsdPrice = p; solUsdFetched = Date.now(); return p; }
  } catch(_) {}
  // CoinGecko fallback
  try {
    const r = await nodeFetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { timeout: 5000 });
    const j = await r.json();
    const p = j?.solana?.usd || 0;
    if (p > 0) { solUsdPrice = p; solUsdFetched = Date.now(); return p; }
  } catch(_) {}
  return solUsdPrice || 0;
}

// Get LST pool price in SOL = lstUSD / solUSD
async function getDexPrice(lstMint) {
  try {
    const [rLst, solUsd] = await Promise.all([
      nodeFetch(`https://api.jup.ag/price/v3?ids=${lstMint}`, { headers: JUP_H_GET, timeout: 4000 }).then(r => r.json()),
      getSolUsd(),
    ]);
    // Jupiter v3 shape: { mintAddress: { usdPrice: N } }
    const lstUsd = parseFloat(rLst?.[lstMint]?.usdPrice) || 0;
    if (!lstUsd || !solUsd) return 0;
    return lstUsd / solUsd;  // SOL per 1 LST (pool-derived price)
  } catch(_) { return 0; }
}

// ── Drift Funding Rate ────────────────────────────────────────────────────────
async function getDriftFundingRate() {
  try {
    // Drift v2 stats API
    const r = await nodeFetch('https://mainnet-beta.api.drift.trade/v2/markets/SOL-PERP', { timeout: 5000 });
    const j = await r.json();
    // fundingRate1H is in units of 1e-9 per oracle, convert to bps/hr
    const raw = j?.market?.amm?.last24HAvgFundingRate
             || j?.result?.last24HAvgFundingRate
             || 0;
    return parseFloat(raw) * 10_000; // to bps
  } catch(_) {}
  return 0;
}

// ── Main scanner ──────────────────────────────────────────────────────────────
let scanCount = 0;
let bestOpportunity = { type: 'none', bps: 0 };

async function scan() {
  scanCount++;

  // Fetch all prices in parallel
  const [msolNav, jitosolNav, msolDex, jitosolDex, driftRate] = await Promise.allSettled([
    getMsolNav(),
    getJitosolNav(),
    getDexPrice(MSOL_MINT),
    getDexPrice(JITOSOL_MINT),
    getDriftFundingRate(),
  ]);

  const mNav   = msolNav.value    || 0;
  const jNav   = jitosolNav.value || 0;
  const mPool  = msolDex.value    || 0;
  const jPool  = jitosolDex.value || 0;
  const drift  = driftRate.value  || 0;

  // Basis in bps: positive = pool BELOW NAV (buy opportunity), negative = pool ABOVE NAV
  const msolBasis   = mNav  && mPool  ? Math.round(((mNav  - mPool)  / mNav)  * 10_000) : 0;
  const jitosolBasis = jNav && jPool  ? Math.round(((jNav  - jPool)  / jNav)  * 10_000) : 0;

  log(`📊 SCAN #${scanCount} | mSOL_NAV=${mNav.toFixed(5)} pool=${mPool.toFixed(5)} basis=${msolBasis}bps | jitoSOL_NAV=${jNav.toFixed(5)} pool=${jPool.toFixed(5)} basis=${jitosolBasis}bps | drift=${drift.toFixed(3)}bps/hr`);
  if (mNav && mPool && msolBasis !== 0)    log(`  ⭐ mSOL:    ${msolBasis}bps  ${msolBasis > 0 ? '🟢 BUY POOL (cheap)' : '🔴 SELL POOL (prem)'}`);
  if (jNav && jPool && jitosolBasis !== 0) log(`  ⭐ jitoSOL: ${jitosolBasis}bps  ${jitosolBasis > 0 ? '🟢 BUY POOL (cheap)' : '🔴 SELL POOL (prem)'}`);
  if (Math.abs(drift) > 2)                 log(`  ⭐ Drift SOL-PERP: ${drift > 0 ? '+' : ''}${drift.toFixed(3)}bps/hr  ${drift > 0 ? '💰 SHORT+LONG (earn funding)' : '💰 LONG+SHORT (earn funding)'}`);

  // Track best live opportunity
  const candidates = [
    { type: 'mSOL_BUY',       bps: msolBasis },
    { type: 'jitoSOL_BUY',    bps: jitosolBasis },
    { type: 'DRIFT_FUNDING',  bps: Math.abs(drift) },
  ];
  const best = candidates.sort((a, b) => b.bps - a.bps)[0];
  if (best.bps > bestOpportunity.bps) bestOpportunity = best;
}

async function main() {
  log('═══════════════════════════════════════════════════');
  log('  LST BASIS + DRIFT FUNDING SCANNER');
  log('  Scanning: mSOL, jitoSOL, Drift SOL-PERP');
  log('  Looking for: pool < NAV (buy cheap LST) or');
  log('               pool > NAV (stake + sell LST)');
  log('               funding rate > 5bps/hr (delta-neutral)');
  log('═══════════════════════════════════════════════════');

  // Initial scan
  await scan();

  // Scan every 5s
  setInterval(async () => {
    try { await scan(); } catch(e) { log(`Scan err: ${e.message}`); }
  }, 5_000);

  // Summary every 60s
  setInterval(() => {
    log(`⏱  Scans: ${scanCount} | Best live opp: ${bestOpportunity.type} @ ${bestOpportunity.bps}bps`);
    bestOpportunity = { type: 'none', bps: 0 }; // reset for next window
  }, 60_000);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });



