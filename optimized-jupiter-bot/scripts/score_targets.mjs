/**
 * score_targets.mjs  —  Live weighted target scoring
 * Run: node scripts/score_targets.mjs
 */
import dotenv from 'dotenv';
dotenv.config();

const WSOL    = 'So11111111111111111111111111111111111111112';
const JBASE   = (process.env.JUPITER_ENDPOINT || 'https://quote-api.jup.ag').replace(/\/+$/, '');
const API_KEY = process.env.JUPITER_API_KEY || '';
const SLIP    = 30; // reduced slippage for cleaner spread estimate
const TRADE   = 0.5e9; // 0.5 SOL in lamports (larger = reveals real spread)

const TARGETS = [
  // ── Blue chips ────────────────────────────────────────────────────────────
  { name: 'USDC',   mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', category: 'bluechip' },
  { name: 'USDT',   mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', category: 'bluechip' },
  { name: 'JUP',    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbPwdrsxGBK',   category: 'bluechip' },
  { name: 'RAY',    mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', category: 'bluechip' },
  { name: 'JTO',    mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',  category: 'bluechip' },
  { name: 'PYTH',   mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3AkTftx2K2aFCh', category: 'bluechip' },
  // ── Meme / high-vol ───────────────────────────────────────────────────────
  { name: 'BONK',   mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', category: 'meme'     },
  { name: 'WIF',    mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYtM2wYSzRo', category: 'meme'     },
  { name: 'POPCAT', mint: '7GCihgDB8fe6KNjn2gN7ZDB2h2n2i2Z7pW2r2YjN1e8p', category: 'meme'     },
  { name: 'BOME',   mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgM2W8qT',  category: 'meme'     },
  // ── DeFi / yield ──────────────────────────────────────────────────────────
  { name: 'MSOL',   mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', category: 'defi'     },
  { name: 'jitoSOL',mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', category: 'defi'     },
  { name: 'bSOL',   mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  category: 'defi'     },
  { name: 'ORCA',   mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',  category: 'defi'     },
  // ── Native PCP ────────────────────────────────────────────────────────────
  { name: 'PCP',    mint: '4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS', category: 'native'   },
];

// Weight table for scoring (all add to 100)
const WEIGHTS = {
  spread_bps:        35,  // raw arb spread WSOL→X→WSOL  (higher = better)
  liquidity:         25,  // log10 of DexScreener USD liq (deeper = better)
  volume_score:      20,  // 24h volume rank              (busier = better)
  category_bonus:    10,  // meme > bluechip > defi for arb
  rug_safety:        10,  // rugcheck score (inverse)
};

const CATEGORY_BONUS = { meme: 1.0, bluechip: 0.7, defi: 0.5, native: 0.6 };

async function fetchJson(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(t);
    return r.ok ? r.json().catch(() => null) : null;
  } catch { clearTimeout(t); return null; }
}

async function getSpread(mint) {
  const hdrs = API_KEY ? { 'x-api-key': API_KEY } : {};
  // Use working lite-api endpoint
  const LITE = 'https://lite-api.jup.ag/swap/v1';

  const q1 = await fetchJson(`${LITE}/quote?inputMint=${WSOL}&outputMint=${mint}&amount=${TRADE}&slippageBps=${SLIP}`, { headers: hdrs });
  if (!q1?.outAmount) return null;

  const q2 = await fetchJson(`${LITE}/quote?inputMint=${mint}&outputMint=${WSOL}&amount=${q1.outAmount}&slippageBps=${SLIP}`, { headers: hdrs });
  if (!q2?.outAmount) return null;

  // Real round-trip profit in bps
  const gross = Number(q2.outAmount) - TRADE;
  const bps   = (gross / TRADE) * 10000;

  // Also grab price impact as secondary signal
  const impact1 = parseFloat(q1.priceImpactPct || '0');
  const impact2 = parseFloat(q2.priceImpactPct || '0');

  return { bps, impact: impact1 + impact2 };
}


async function getDexData(mint) {
  const d = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  const pairs = (d?.pairs || []).filter(p => p.chainId === 'solana');
  if (!pairs.length) return { liqUsd: 0, vol24h: 0 };
  const maxPair = pairs.reduce((a, b) => (b.liquidity?.usd || 0) > (a.liquidity?.usd || 0) ? b : a);
  return { liqUsd: maxPair.liquidity?.usd || 0, vol24h: maxPair.volume?.h24 || 0 };
}

async function getRugScore(mint) {
  const d = await fetchJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`);
  return d?.score ?? d?.risk_score ?? 500; // 500 = unknown
}

async function scoreTarget(t) {
  const [spreadResult, dex, rugRaw] = await Promise.all([
    getSpread(t.mint),
    getDexData(t.mint),
    getRugScore(t.mint),
  ]);

  const spreadBps  = spreadResult?.bps ?? null;
  const priceImpact = spreadResult?.impact ?? null;

  // Normalize each dimension 0–100
  const spreadNorm  = spreadBps === null ? 0 : Math.min(100, Math.max(0, (spreadBps + 200) / 4)); // -200..+200 bps → 0..100
  const liqNorm     = dex.liqUsd > 0 ? Math.min(100, (Math.log10(dex.liqUsd) / 8) * 100) : 0;
  const volNorm     = dex.vol24h  > 0 ? Math.min(100, (Math.log10(dex.vol24h)  / 8) * 100) : 0;
  const catNorm     = (CATEGORY_BONUS[t.category] || 0.5) * 100;
  const rugNorm     = Math.max(0, 100 - (rugRaw / 10));

  const weighted =
    (spreadNorm  * WEIGHTS.spread_bps)  / 100 +
    (liqNorm     * WEIGHTS.liquidity)   / 100 +
    (volNorm     * WEIGHTS.volume_score)/ 100 +
    (catNorm     * WEIGHTS.category_bonus)/100 +
    (rugNorm     * WEIGHTS.rug_safety)  / 100;

  return {
    name:        t.name,
    category:    t.category,
    mint:        t.mint.slice(0, 8) + '…',
    spreadBps:   spreadBps !== null ? spreadBps.toFixed(2) : 'N/A',
    priceImpact: priceImpact !== null ? priceImpact.toFixed(4) + '%' : 'N/A',
    liqUsd:      dex.liqUsd > 0 ? `$${(dex.liqUsd/1000).toFixed(0)}K` : '?',
    vol24h:      dex.vol24h  > 0 ? `$${(dex.vol24h/1000).toFixed(0)}K` : '?',
    rugScore:    rugRaw,
    score:       weighted.toFixed(1),
    breakdown: {
      spread: spreadNorm.toFixed(1), liq: liqNorm.toFixed(1),
      vol: volNorm.toFixed(1), cat: catNorm.toFixed(1), rug: rugNorm.toFixed(1),
    },
  };
}


console.log('\n⏳ Scoring ' + TARGETS.length + ' targets live (this takes ~60s)...\n');

const results = await Promise.all(TARGETS.map(scoreTarget));
results.sort((a, b) => parseFloat(b.score) - parseFloat(a.score));

// ── Print table ─────────────────────────────────────────────────────────────
const PAD = (s, n) => String(s).padEnd(n);
const RPAD = (s, n) => String(s).padStart(n);

console.log(PAD('Rank', 4) + PAD('Token', 9) + PAD('Cat', 9) + RPAD('Score', 6) +
  RPAD('SpreadBps', 11) + RPAD('Liq', 10) + RPAD('Vol24h', 10) + RPAD('Rug', 6) +
  '  Breakdown(spd/liq/vol/cat/rug)');
console.log('─'.repeat(110));

results.forEach((r, i) => {
  const flag = parseFloat(r.spreadBps) > 0 ? '🟢' : parseFloat(r.spreadBps) > -30 ? '🟡' : '🔴';
  console.log(
    PAD(`#${i+1}`, 4) + PAD(r.name, 9) + PAD(r.category, 9) +
    RPAD(r.score, 6) + RPAD(r.spreadBps, 11) +
    RPAD(r.liqUsd, 10) + RPAD(r.vol24h, 10) + RPAD(r.rugScore, 6) +
    `  ${flag} [${r.breakdown.spread}/${r.breakdown.liq}/${r.breakdown.vol}/${r.breakdown.cat}/${r.breakdown.rug}]`
  );
});

console.log('\n─'.repeat(110));
console.log('🏆 TOP ARB TARGET: ' + results[0].name + ' (score: ' + results[0].score + ', spread: ' + results[0].spreadBps + ' bps)');
console.log('\nBreakdown weights: spread×35 | liquidity×25 | volume×20 | category×10 | rug-safety×10\n');

// Save as JSON
import { writeFileSync } from 'fs';
writeFileSync('target_scores.json', JSON.stringify(results, null, 2));
console.log('💾 Saved → target_scores.json');
