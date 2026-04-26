import { NextRequest, NextResponse } from 'next/server';
import { BROWSER_UA, fetchDexScreenerSolanaSearches } from '../_shared/market';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

async function getDexScreenerSpikes() {
  try {
    const signals = [];
    const pairs = await fetchDexScreenerSolanaSearches(['solana', 'meme solana', 'new solana']);
    for (const pair of pairs.slice(0, 80)) {
      const buysH1  = pair.txns?.h1?.buys  || 0;
      const buysH6  = (pair.txns?.h6?.buys || 0) / 6;
      const volH1   = Number(pair.volume?.h1 || 0);
      const priceChg = Number(pair.priceChange?.h1 || 0);
      const ratio   = buysH1 / Math.max(buysH6, 1);
      if (ratio < 1.5 && Math.abs(priceChg) < 5) continue;
      const score = Math.min(
        (ratio >= 3 ? 25 : ratio >= 1.5 ? 15 : 0) +
        (volH1 >= 50_000 ? 20 : volH1 >= 10_000 ? 10 : 0) +
        (priceChg >= 10 ? 15 : priceChg >= 5 ? 8 : 0),
        100
      );
      signals.push({
        type:    ratio >= 3 && volH1 >= 50_000 ? 'CONVICTION' : 'MOMENTUM',
        symbol:  pair.baseToken?.symbol || 'UNK',
        mint:    pair.baseToken?.address || '',
        score,
        sources: ['dexscreener_spike'],
        action:  score >= 65 ? 'SCAN_ARB' : 'MONITOR',
        evidence: { spike_ratio: Math.round(ratio * 10) / 10, vol_h1: Math.round(volH1), price_change_h1: priceChg },
      });
    }
    return signals;
  } catch { return []; }
}

async function getDexScreenerScannerFallback() {
  try {
    const signals = [];
    const pairs = await fetchDexScreenerSolanaSearches(['solana', 'meme solana', 'new solana']);
    for (const pair of pairs.slice(0, 80)) {
      const mint = pair.baseToken?.address || '';
      const liq = Number(pair.liquidity?.usd || 0);
      const vol24 = Number(pair.volume?.h24 || 0);
      const buysH1 = Number(pair.txns?.h1?.buys || 0);
      const buysM5 = Number(pair.txns?.m5?.buys || 0);
      const priceChg24 = Number(pair.priceChange?.h24 || 0);
      const priceChg1 = Number(pair.priceChange?.h1 || 0);
      if (!mint || liq < 12_000 || vol24 < 40_000) continue;

      const score = Math.min(
        (liq >= 100_000 ? 20 : liq >= 30_000 ? 14 : 8) +
        (vol24 >= 500_000 ? 20 : vol24 >= 100_000 ? 14 : 8) +
        (priceChg24 >= 20 ? 18 : priceChg24 >= 10 ? 10 : priceChg1 >= 3 ? 6 : 0) +
        (buysH1 >= 50 ? 12 : buysH1 >= 20 ? 8 : buysM5 >= 5 ? 5 : 0),
        100,
      );

      if (score < 40) continue;

      signals.push({
        type: score >= 65 ? 'CONVICTION' : 'MOMENTUM',
        symbol: pair.baseToken?.symbol || 'UNK',
        mint,
        score,
        sources: ['dexscreener_scan'],
        action: score >= 65 ? 'SCAN_ARB' : 'MONITOR',
        evidence: {
          liquidity_usd: Math.round(liq),
          volume_h24: Math.round(vol24),
          buys_h1: buysH1,
          price_change_h24: priceChg24,
        },
      });
    }
    return signals;
  } catch {
    return [];
  }
}

async function getPumpFunGraduations() {
  // Use DexScreener to find recent Solana tokens as pump.fun alternative
  try {
    const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1', {
      headers: { 'User-Agent': BROWSER_UA },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter((t: any) => t.chainId === 'solana')
      .slice(0, 8)
      .map((t: any) => ({
        type: 'GRADUATION',
        symbol: t.symbol || t.tokenAddress?.slice(0, 8) || 'UNK',
        mint:   t.tokenAddress || '',
        score:  30,
        sources: ['boosted'],
        action: 'SCREEN',
        evidence: { boost_amount: t.amount, description: (t.description || '').slice(0, 60) },
      }));
  } catch { return []; }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const minScore = Number(searchParams.get('minScore') || 40);

  const [spikes, graduations, scannerFallback] = await Promise.all([
    getDexScreenerSpikes(),
    getPumpFunGraduations(),
    getDexScreenerScannerFallback(),
  ]);
  const allSignals = [...spikes, ...graduations, ...scannerFallback];

  // Merge by mint
  const merged = new Map<string, any>();
  for (const s of allSignals) {
    if (!s.mint) continue;
    if (merged.has(s.mint)) {
      const ex = merged.get(s.mint)!;
      ex.score   += Math.round(s.score * 0.5);
      ex.sources  = [...new Set([...ex.sources, ...s.sources])];
      if (ex.sources.length >= 2) ex.type = 'CONVICTION';
    } else {
      merged.set(s.mint, { ...s });
    }
  }

  const signals = Array.from(merged.values())
    .filter(s => s.score >= minScore)
    .sort((a, b) => b.score - a.score);

  return NextResponse.json({ signals, generated_at: new Date().toISOString() }, { headers: CORS });
}

export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }
