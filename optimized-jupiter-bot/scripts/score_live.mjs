import dotenv from 'dotenv';
dotenv.config();

const WSOL  = 'So11111111111111111111111111111111111111112';
const TRADE = 500_000_000; // 0.5 SOL in lamports
const SLIP  = 30;
const BASE  = 'https://lite-api.jup.ag/swap/v1';
const KEY   = process.env.JUPITER_API_KEY || '';
const HDRS  = KEY ? { 'x-api-key': KEY } : {};

const TARGETS = [
  { n: 'USDC',    m: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', cat: 'bluechip',  liqEst: 75775,  rug: 500  },
  { n: 'USDT',    m: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',  cat: 'bluechip',  liqEst: 871504, rug: 500  },
  { n: 'BONK',    m: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', cat: 'meme',      liqEst: 821,    rug: 500  },
  { n: 'WIF',     m: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYtM2wYSzRo', cat: 'meme',      liqEst: 4200,   rug: 500  },
  { n: 'POPCAT',  m: '7GCihgDB8fe6KNjn2gN7ZDB2h2n2i2Z7pW2r2YjN1e8p', cat: 'meme',      liqEst: 900,    rug: 500  },
  { n: 'BOME',    m: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgM2W8qT',  cat: 'meme',      liqEst: 600,    rug: 500  },
  { n: 'JUP',     m: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbPwdrsxGBK',   cat: 'bluechip',  liqEst: 12000,  rug: 500  },
  { n: 'RAY',     m: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', cat: 'bluechip',  liqEst: 3492,   rug: 2998 },
  { n: 'JTO',     m: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',  cat: 'bluechip',  liqEst: 739,    rug: 500  },
  { n: 'PYTH',    m: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3AkTftx2K2aFCh', cat: 'bluechip',  liqEst: 200,    rug: 500  },
  { n: 'MSOL',    m: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  cat: 'defi',      liqEst: 1619,   rug: 500  },
  { n: 'jitoSOL', m: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', cat: 'defi',      liqEst: 4497,   rug: 500  },
  { n: 'bSOL',    m: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  cat: 'defi',      liqEst: 618,    rug: 500  },
  { n: 'ORCA',    m: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',  cat: 'defi',      liqEst: 715,    rug: 500  },
  { n: 'PCP',     m: '4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS', cat: 'native',    liqEst: 10,     rug: 500  },
];

const CAT_BONUS = { meme: 1.0, bluechip: 0.7, defi: 0.5, native: 0.6 };

async function quote(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { headers: HDRS, signal: ctrl.signal });
    clearTimeout(t);
    return r.ok ? r.json() : null;
  } catch { clearTimeout(t); return null; }
}

async function getSpread(m) {
  const q1 = await quote(`${BASE}/quote?inputMint=${WSOL}&outputMint=${m}&amount=${TRADE}&slippageBps=${SLIP}`);
  if (!q1?.outAmount) return null;
  const q2 = await quote(`${BASE}/quote?inputMint=${m}&outputMint=${WSOL}&amount=${q1.outAmount}&slippageBps=${SLIP}`);
  if (!q2?.outAmount) return null;
  const bps = ((Number(q2.outAmount) - TRADE) / TRADE) * 10000;
  const impact = parseFloat(q1.priceImpactPct || 0) + parseFloat(q2.priceImpactPct || 0);
  return { bps, impact };
}

console.log('\n\u23F3 Fetching live round-trip spreads for ' + TARGETS.length + ' tokens...\n');
const rows = [];
for (const t of TARGETS) {
  const spread = await getSpread(t.m);
  const bps    = spread?.bps ?? null;
  const impact = spread?.impact ?? null;

  // Normalize to 0-100
  const sN = bps === null ? 0 : Math.min(100, Math.max(0, (bps + 200) / 4));
  const lN = t.liqEst > 0 ? Math.min(100, (Math.log10(t.liqEst * 1000) / 8) * 100) : 0;
  const cN = (CAT_BONUS[t.cat] || 0.5) * 100;
  const rN = Math.max(0, 100 - (t.rug / 10));

  const score = (sN * 35 + lN * 25 + cN * 15 + rN * 10) / 85;

  rows.push({ n: t.n, cat: t.cat, bps, impact, liqK: t.liqEst, rug: t.rug, score, sN, lN, cN, rN });
  const flag = bps === null ? '\u2753' : bps > 0 ? '\uD83D\uDFE2' : bps > -30 ? '\uD83D\uDFE1' : '\uD83D\uDD34';
  const bpsStr = bps !== null ? bps.toFixed(2) + 'bps' : 'NO-QUOTE';
  console.log(`  ${flag} ${t.n.padEnd(9)} ${bpsStr.padStart(11)}  impact:${impact !== null ? impact.toFixed(3)+'%' : '--'}  liq:$${String(t.liqEst)+'K'}  rug:${t.rug}  score:${score.toFixed(1)}`);
  await new Promise(r => setTimeout(r, 600));
}

rows.sort((a, b) => b.score - a.score);
console.log('\n\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 WEIGHTED TARGET SCORES (live) \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
console.log('Rank  Token      Category   Score  SpreadBps  Impact%   Liq($K)  Rug   [spd/liq/cat/rug breakdown]');
console.log('\u2500'.repeat(100));
rows.forEach((r, i) => {
  const flag = r.bps === null ? '\u2753' : r.bps > 0 ? '\uD83D\uDFE2' : r.bps > -30 ? '\uD83D\uDFE1' : '\uD83D\uDD34';
  const bpsStr = r.bps !== null ? r.bps.toFixed(2) : 'N/A';
  console.log(
    `${flag} #${String(i+1).padEnd(3)}  ${r.n.padEnd(10)} ${r.cat.padEnd(10)} ${r.score.toFixed(1).padStart(5)}  ` +
    `${bpsStr.padStart(9)}  ${r.impact !== null ? r.impact.toFixed(3)+'%' : 'N/A'.padStart(5)}  ` +
    `${String(r.liqK+'K').padStart(8)}  ${String(r.rug).padStart(5)}  ` +
    `[${r.sN.toFixed(0)}/${r.lN.toFixed(0)}/${r.cN.toFixed(0)}/${r.rN.toFixed(0)}]`
  );
});
console.log('\u2500'.repeat(100));
console.log('\nWeights: Spread\xD735% | Liquidity\xD725% | Category\xD715% | Rug-Safety\xD710% (normalised to 85)');
console.log('\uD83C\uDFC6 TOP TARGET: ' + rows[0].n + ' | score: ' + rows[0].score.toFixed(1) + ' | spread: ' + (rows[0].bps?.toFixed(2) ?? 'N/A') + 'bps\n');

import { writeFileSync } from 'fs';
writeFileSync('target_scores.json', JSON.stringify(rows.map(r => ({
  rank: rows.indexOf(r)+1, name: r.n, category: r.cat,
  score: r.score.toFixed(1),
  spreadBps: r.bps?.toFixed(2) ?? null,
  priceImpactPct: r.impact?.toFixed(4) ?? null,
  liquidityKusd: r.liqK.toFixed(0) + 'K',
  rugcheckScore: r.rug,
  breakdown: { spread: r.sN.toFixed(1), liquidity: r.lN.toFixed(1), category: r.cN.toFixed(1), rugSafety: r.rN.toFixed(1) },
})), null, 2));
console.log('\uD83D\uDCBE Saved \u2192 target_scores.json');
