import { NextRequest, NextResponse } from 'next/server';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36';

function scoreToken(t: any): number {
  let score = 0;
  const liq   = t.liquidity_usd   || 0;
  const vol24 = t.volume_usd_24h  || 0;
  const age_h = t.age_hours       ?? 24;
  const src   = t.source          || '';

  if (liq >= 100_000) score += 20; else if (liq >= 30_000) score += 14; else if (liq >= 8_000) score += 8;
  if (vol24 >= 500_000) score += 20; else if (vol24 >= 100_000) score += 14; else if (vol24 >= 30_000) score += 8;
  if (age_h <= 6) score += 15; else if (age_h <= 24) score += 10; else if (age_h <= 72) score += 5;
  if (src === 'seeded') score += 30;
  if (src === 'boosted') score += 15;
  if (src === 'dexscreener') score += 10;
  return Math.min(score, 100);
}

async function fetchDexscreener(query: string): Promise<any[]> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.pairs || []).filter((p: any) => p.chainId === 'solana');
}

const SEEDED = [
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC',    source: 'seeded', age_hours: 0 },
  { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT',    source: 'seeded', age_hours: 0 },
  { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'MSOL',    source: 'seeded', age_hours: 0 },
  { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'jitoSOL', source: 'seeded', age_hours: 0 },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK',   source: 'seeded', age_hours: 0 },
  { mint: 'EKpQGSJt7KHZGF2v8pTU3s6ixHqJYqaGYcqDsGNXoMbv', symbol: 'WIF',   source: 'seeded', age_hours: 0 },
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  symbol: 'JUP',   source: 'seeded', age_hours: 0 },
];

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const minLiq  = Number(searchParams.get('minLiq')  || 8000);
  const minVol  = Number(searchParams.get('minVol')  || 20000);
  const maxAge  = Number(searchParams.get('maxAge')  || 48);
  const limit   = Math.min(Number(searchParams.get('limit') || 10), 25);

  const seen   = new Set<string>();
  const tokens: any[] = [];

  // Multi-query DexScreener
  const queries = ['solana', 'meme solana', 'new solana'];
  const results = await Promise.allSettled(queries.map(fetchDexscreener));
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const pair of r.value) {
      const liq   = Number(pair.liquidity?.usd || 0);
      const vol24 = Number(pair.volume?.h24 || 0);
      const ts    = pair.pairCreatedAt || 0;
      const age_h = ts ? (Date.now() - ts) / 3_600_000 : 24;
      const mint  = pair.baseToken?.address || '';
      if (!mint || seen.has(mint)) continue;
      if (liq < minLiq * 0.5) continue;
      if (age_h > maxAge) continue;
      seen.add(mint);
      tokens.push({
        mint, age_hours: Math.round(age_h * 10) / 10,
        symbol:           pair.baseToken?.symbol || 'UNK',
        name:             pair.baseToken?.name   || '',
        liquidity_usd:    liq,
        volume_usd_24h:   vol24,
        price_usd:        Number(pair.priceUsd || 0),
        price_change_24h: Number(pair.priceChange?.h24 || 0),
        source: 'dexscreener',
      });
    }
  }

  // Always add seeded tokens
  for (const s of SEEDED) {
    if (!seen.has(s.mint)) { seen.add(s.mint); tokens.push({ ...s, liquidity_usd: 0, volume_usd_24h: 0, price_usd: 0, price_change_24h: 0, name: '' }); }
  }

  // Score and sort
  const scored = tokens
    .map(t => ({ ...t, score: scoreToken(t) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Get SOL price
  let sol_price_usd = 0;
  try {
    const pr = await fetch('https://lite-api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112', { signal: AbortSignal.timeout(4000) });
    const pd = await pr.json();
    sol_price_usd = Number(pd?.data?.['So11111111111111111111111111111111111111112']?.price || 0);
  } catch {}

  return NextResponse.json({ tokens: scored, scanned_at: new Date().toISOString(), sol_price_usd }, { headers: CORS });
}

export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }
