/**
 * score_expanded.mjs  —  Expanded Token Target Scorer
 * ─────────────────────────────────────────────────────────────────────────────
 * Dynamically discovers tokens from PumpFun, Bags.fm, DexScreener trending,
 * Raydium top pairs, and Meteora pools BEYOND blue-chips.
 *
 * Key improvements over score_live.mjs:
 *   - Adaptive slippage: 30bps (bluechip) | 100bps (meme) | 200bps (new launch)
 *   - Trade size: 0.1 SOL (smaller = more routes succeed on thin pools)
 *   - Dynamic discovery from 5 sources before scoring
 *   - Category-aware scoring bonuses
 *   - Filters: min $500 liquidity, not banned mint list
 * ─────────────────────────────────────────────────────────────────────────────
 * Usage:  node scripts/score_expanded.mjs [--limit 30]
 */
import dotenv from 'dotenv';
dotenv.config();
import { writeFileSync } from 'fs';

const WSOL  = 'So11111111111111111111111111111111111111112';
const LITE  = 'https://lite-api.jup.ag/swap/v1';
const KEY   = process.env.JUPITER_API_KEY || '';
const BAGS1 = process.env.BAGS_API_KEY    || '';
const HDRS  = KEY ? { 'x-api-key': KEY } : {};

const ARGS       = process.argv.slice(2);
const MAX_TOKENS = parseInt(ARGS[ARGS.indexOf('--limit') + 1] || '50');
const TRADE_LAM  = 100_000_000; // 0.1 SOL per leg

// ── Slippage by category ─────────────────────────────────────────────────────
const SLIP = { bluechip: 30, defi: 50, meme: 100, launch: 200, native: 150 };

// ── Category weights (used in score formula) ─────────────────────────────────
const CAT_BONUS = { launch: 1.2, meme: 1.0, defi: 0.6, bluechip: 0.5, native: 0.6 };

// ── Known tokens to ALWAYS include (anchors) ─────────────────────────────────
const ANCHORS = [
  { name: 'USDC',    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', cat: 'bluechip' },
  { name: 'BONK',    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', cat: 'meme'     },
  { name: 'WIF',     mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYtM2wYSzRo', cat: 'meme'     },
  { name: 'POPCAT',  mint: '7GCihgDB8fe6KNjn2gN7ZDB2h2n2i2Z7pW2r2YjN1e8p', cat: 'meme'     },
  { name: 'BOME',    mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgM2W8qT',  cat: 'meme'     },
  { name: 'RAY',     mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', cat: 'bluechip' },
  { name: 'JUP',     mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbPwdrsxGBK',   cat: 'bluechip' },
  { name: 'MSOL',    mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  cat: 'defi'     },
  { name: 'jitoSOL', mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', cat: 'defi'     },
  { name: 'bSOL',    mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  cat: 'defi'     },
  { name: 'ORCA',    mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',  cat: 'defi'     },
  { name: 'TRUMP',   mint: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', cat: 'meme'     },
  { name: 'MELANIA', mint: 'FUAfBo2jgks6gB4Z4LfZkqSZgzNucisEHqnNebaRxM1P', cat: 'meme'     },
  { name: 'FARTCOIN',mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump', cat: 'meme'     },
  { name: 'AI16Z',   mint: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC', cat: 'meme'     },
];

// ── Fetch helpers ─────────────────────────────────────────────────────────────
async function fetchJson(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(t);
    return r.ok ? r.json().catch(() => null) : null;
  } catch { clearTimeout(t); return null; }
}

// ══ Discovery sources ════════════════════════════════════════════════════════

async function fromPumpFun() {
  const out = [];
  // Trending + graduated
  const [trending, koth] = await Promise.all([
    fetchJson('https://frontend-api.pump.fun/coins?offset=0&limit=20&sort=market_cap&order=DESC&includeNsfw=false'),
    fetchJson('https://frontend-api.pump.fun/coins/king-of-the-hill?includeNsfw=false'),
  ]);
  for (const c of [...(trending || []), koth].flat().filter(Boolean)) {
    if (c?.mint) out.push({ name: c.symbol || c.name?.slice(0,8) || c.mint.slice(0,6), mint: c.mint, cat: 'launch', liqEst: c.usd_market_cap || 0 });
  }
  console.log(`  [PumpFun]   ${out.length} tokens`);
  return out;
}

async function fromBagsFm() {
  const out = [];
  const headers = BAGS1 ? { Authorization: `Bearer ${BAGS1}` } : {};
  const data = await fetchJson('https://public-api-v2.bags.fm/api/v1/tokens?limit=20&sort=volume_24h', { headers });
  const tokens = data?.tokens || data?.data || (Array.isArray(data) ? data : []);
  for (const t of tokens) {
    const mint = t.mint_address || t.address || t.mint;
    if (mint) out.push({ name: t.symbol || t.name?.slice(0,8) || mint.slice(0,6), mint, cat: 'launch', liqEst: t.liquidity_usd || 0 });
  }
  console.log(`  [Bags.fm]   ${out.length} tokens`);
  return out;
}

async function fromDexScreenerTrending() {
  const out = [];
  // Top gainers on Solana (last hour)
  const data = await fetchJson('https://api.dexscreener.com/token-boosts/top/v1');
  const pairs = (Array.isArray(data) ? data : data?.pairs || []).filter(p => p.chainId === 'solana' || p.chain === 'solana');
  for (const p of pairs.slice(0, 20)) {
    const mint = p.tokenAddress || p.baseToken?.address;
    if (mint && mint !== WSOL) out.push({ name: p.baseToken?.symbol || p.symbol || mint.slice(0,6), mint, cat: 'meme', liqEst: p.liquidity?.usd || 0 });
  }
  console.log(`  [DexScreener] ${out.length} tokens`);
  return out;
}

async function fromDexScreenerSolPairs() {
  const out = [];
  const data = await fetchJson('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
  const pairs = (data?.pairs || []).filter(p => p.chainId === 'solana' && (p.liquidity?.usd || 0) > 500);
  pairs.sort((a, b) => (b.volume?.h1 || 0) - (a.volume?.h1 || 0)); // sort by 1h volume
  for (const p of pairs.slice(0, 25)) {
    const mint = p.baseToken?.address;
    if (mint && mint !== WSOL) {
      const liq = p.liquidity?.usd || 0;
      const vol = p.volume?.h1 || 0;
      const cat = liq > 500_000 ? 'defi' : vol > 10_000 ? 'meme' : 'launch';
      out.push({ name: p.baseToken?.symbol || mint.slice(0,6), mint, cat, liqEst: liq });
    }
  }
  console.log(`  [DexScreener SOL pairs] ${out.length} tokens`);
  return out;
}

async function fromRaydium() {
  const out = [];
  const data = await fetchJson('https://api.raydium.io/v2/main/pairs');
  if (!Array.isArray(data)) return out;
  const sorted = data.filter(p => p.liquidity > 500).sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0)).slice(0, 20);
  for (const p of sorted) {
    const mints = [p.baseMint, p.quoteMint].filter(m => m && m !== WSOL && m !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    for (const mint of mints) out.push({ name: p.name?.split('-')[0] || mint.slice(0,6), mint, cat: 'defi', liqEst: p.liquidity || 0 });
  }
  console.log(`  [Raydium]   ${out.length} tokens`);
  return out;
}

// ══ Score + quote ════════════════════════════════════════════════════════════

async function getSpread(mint, cat) {
  const slip = SLIP[cat] || 100;
  const q1 = await fetchJson(`${LITE}/quote?inputMint=${WSOL}&outputMint=${mint}&amount=${TRADE_LAM}&slippageBps=${slip}`, { headers: HDRS });
  if (!q1?.outAmount) return null;
  const q2 = await fetchJson(`${LITE}/quote?inputMint=${mint}&outputMint=${WSOL}&amount=${q1.outAmount}&slippageBps=${slip}`, { headers: HDRS });
  if (!q2?.outAmount) return null;
  const bps    = ((Number(q2.outAmount) - TRADE_LAM) / TRADE_LAM) * 10000;
  const impact = parseFloat(q1.priceImpactPct || 0) + parseFloat(q2.priceImpactPct || 0);
  const routes = (q1.routePlan?.length || 0) + (q2.routePlan?.length || 0);
  return { bps, impact, routes };
}

function weightedScore(spreadBps, liqUsd, cat, rugScore) {
  const sN = spreadBps === null ? 0 : Math.min(100, Math.max(0, (spreadBps + 200) / 4));
  const lN = liqUsd > 0 ? Math.min(100, (Math.log10(Math.max(liqUsd, 1)) / 7) * 100) : 0;
  const cN = (CAT_BONUS[cat] || 0.5) * 100;
  const rN = rugScore < 300 ? 80 : rugScore < 800 ? 50 : Math.max(0, 100 - rugScore / 10);
  // spread×35, liq×25, category×20, safety×10 (normalised to 90)
  return ((sN * 35) + (lN * 25) + (cN * 20) + (rN * 10)) / 90;
}

// ══ Main ════════════════════════════════════════════════════════════════════

console.log('\n╔═══════════════════════════════════════════════════════╗');
console.log('║   PCP Arb Engine — Expanded Token Scoring            ║');
console.log('║   0.1 SOL trade | adaptive slippage | 5 sources     ║');
console.log(`╚═══════════════════════════════════════════════════════╝\n`);

console.log('  Discovering tokens...');
const [pfTokens, bagsTokens, dsTokens, dsSolPairs, rayTokens] = await Promise.all([
  fromPumpFun(), fromBagsFm(), fromDexScreenerTrending(), fromDexScreenerSolPairs(), fromRaydium(),
]);

// Merge + deduplicate by mint
const seen = new Set();
const all = [];
for (const tk of [...ANCHORS, ...pfTokens, ...bagsTokens, ...dsTokens, ...dsSolPairs, ...rayTokens]) {
  if (!seen.has(tk.mint) && tk.mint && tk.mint !== WSOL) {
    seen.add(tk.mint);
    all.push(tk);
  }
}

// Cap at MAX_TOKENS — prioritise launch/meme first
const prioritised = [
  ...all.filter(t => t.cat === 'launch'),
  ...all.filter(t => t.cat === 'meme'),
  ...all.filter(t => t.cat === 'defi'),
  ...all.filter(t => t.cat === 'bluechip'),
  ...all.filter(t => t.cat === 'native'),
].slice(0, MAX_TOKENS);

console.log(`\n  Total unique tokens: ${all.length} → scoring top ${prioritised.length}\n`);
console.log(`  Category breakdown: launch:${prioritised.filter(t=>t.cat==='launch').length} meme:${prioritised.filter(t=>t.cat==='meme').length} defi:${prioritised.filter(t=>t.cat==='defi').length} bluechip:${prioritised.filter(t=>t.cat==='bluechip').length}\n`);

console.log('  Scanning live Jupiter spreads (0.1 SOL, adaptive slippage)...\n');

const rows = [];
for (const t of prioritised) {
  const spread = await getSpread(t.mint, t.cat);
  const bps    = spread?.bps ?? null;
  const impact = spread?.impact ?? null;
  const liqK   = (t.liqEst || 0) / 1000;
  const score  = weightedScore(bps, t.liqEst || 0, t.cat, 500);
  const flag   = bps === null ? '❓' : bps > 5 ? '🟢' : bps > -20 ? '🟡' : '🔴';

  rows.push({ name: t.name, cat: t.cat, mint: t.mint, bps, impact, liqK, score, spread });
  process.stdout.write(
    `  ${flag} ${t.name.slice(0,9).padEnd(10)} [${t.cat.padEnd(7)}] ` +
    `spread: ${bps !== null ? bps.toFixed(2)+'bps' : 'NO-QUOTE'.padEnd(10)} ` +
    `impact: ${impact !== null ? impact.toFixed(3)+'%' : '---'} ` +
    `score: ${score.toFixed(1)}\n`
  );
  await new Promise(r => setTimeout(r, 500));
}

// Sort by score
rows.sort((a, b) => b.score - a.score);

// ── Print final table ────────────────────────────────────────────────────────
console.log('\n\n══════════ RANKED TARGETS (beyond blue-chips) ══════════════════════════════════');
console.log('Rank  Token      Category  Score  SpreadBPS  Impact%   Liq($K)   Action');
console.log('─'.repeat(90));
rows.forEach((r, i) => {
  const flag = r.bps === null ? '❓' : r.bps > 5 ? '🟢' : r.bps > -20 ? '🟡' : '🔴';
  const action = r.bps > 5    ? '✅ SCAN NOW'
               : r.bps > -20  ? '🔍 Monitor'
               : r.bps === null ? '⚠️ Retry+slip'
               : '❌ Skip';
  console.log(
    `${flag} #${String(i+1).padEnd(3)}` +
    ` ${(r.name||'?').slice(0,9).padEnd(10)} ` +
    `${r.cat.padEnd(9)} ` +
    `${r.score.toFixed(1).padStart(5)}  ` +
    `${(r.bps !== null ? r.bps.toFixed(2) : 'N/A').padStart(9)}  ` +
    `${(r.impact !== null ? r.impact.toFixed(3)+'%' : 'N/A').padStart(8)}  ` +
    `${('$'+(r.liqK > 0 ? r.liqK.toFixed(0)+'K' : '?')).padStart(8)}  ` +
    `${action}`
  );
});
console.log('─'.repeat(90));

const greenCount  = rows.filter(r => r.bps !== null && r.bps > 5).length;
const yellowCount = rows.filter(r => r.bps !== null && r.bps > -20 && r.bps <= 5).length;
console.log(`\n✅ ${greenCount} ACTIVE opps (spread >5bps) | 🟡 ${yellowCount} marginal | ❌ rest below threshold`);
console.log(`🏆 TOP: ${rows[0]?.name} (score: ${rows[0]?.score.toFixed(1)}, spread: ${rows[0]?.bps?.toFixed(2) ?? 'N/A'}bps)\n`);

// Save
writeFileSync('expanded_scores.json', JSON.stringify(rows.map((r, i) => ({
  rank: i + 1, name: r.name, category: r.cat, mint: r.mint,
  score: r.score.toFixed(1),
  spreadBps: r.bps?.toFixed(2) ?? null,
  priceImpact: r.impact?.toFixed(4) ?? null,
  liquidityUsd: r.liqK > 0 ? '$' + (r.liqK).toFixed(0) + 'K' : 'unknown',
  action: r.bps > 5 ? 'SCAN' : r.bps > -20 ? 'monitor' : r.bps === null ? 'retry' : 'skip',
})), null, 2));
console.log('💾 Saved → expanded_scores.json\n');
