import { NextRequest, NextResponse } from 'next/server';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const WSOL = 'So11111111111111111111111111111111111111112';
const JUP  = 'https://lite-api.jup.ag/swap/v1/quote';

const ROUTES = [
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC',    slippageBps: 30  },
  { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: 'USDT',    slippageBps: 30  },
  { mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', symbol: 'MSOL',    slippageBps: 20  },
  { mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', symbol: 'jitoSOL', slippageBps: 20  },
  { mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  symbol: 'bSOL',    slippageBps: 20  },
  { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK',   slippageBps: 100 },
  { mint: 'EKpQGSJt7KHZGF2v8pTU3s6ixHqJYqaGYcqDsGNXoMbv', symbol: 'WIF',   slippageBps: 100 },
  { mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  symbol: 'JUP',    slippageBps: 50  },
  { mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',  symbol: 'ORCA',   slippageBps: 40  },
  { mint: '4k3DyjzvzpRFmzGNFk1G8hNKHHkCpAb3NXFHHqFiNNo6', symbol: 'RAY',   slippageBps: 40  },
];

async function quoteRoute(mint: string, lamports: number, slippageBps: number): Promise<{ outAmount: number } | null> {
  try {
    const res = await fetch(`${JUP}?inputMint=${WSOL}&outputMint=${mint}&amount=${lamports}&slippageBps=${slippageBps}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const capitalSol = Number(searchParams.get('capitalSol') || 0.2);
  const minBps     = Number(searchParams.get('minBps')     || 0);
  const lamports   = Math.round(capitalSol * 1_000_000_000);

  const results = await Promise.allSettled(
    ROUTES.map(async (r) => {
      const q1 = await quoteRoute(r.mint, lamports, r.slippageBps);
      if (!q1?.outAmount) return null;
      const tokenOut = Number(q1.outAmount);
      const q2 = await quoteRoute(WSOL, tokenOut, r.slippageBps);
      if (!q2?.outAmount) return null;
      const solOut    = Number(q2.outAmount);
      const grossBps  = (solOut - lamports) / lamports * 10_000;
      const gasSol    = 5_000 / 1_000_000_000;
      const tipSol    = Math.max(0, (solOut - lamports) / 1_000_000_000 * 0.5);
      const netSol    = (solOut - lamports) / 1_000_000_000 - gasSol - tipSol;
      const netBps    = netSol / capitalSol * 10_000;
      return { symbol: r.symbol, mint: r.mint, gross_bps: Math.round(grossBps * 100) / 100, net_bps: Math.round(netBps * 100) / 100, net_sol: Math.round(netSol * 1e6) / 1e6, capital_sol: capitalSol, profitable: netBps > 0 };
    })
  );

  let solPrice = 0;
  try {
    const pr = await fetch('https://lite-api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112', { signal: AbortSignal.timeout(4000) });
    const pd = await pr.json();
    solPrice = Number(pd?.data?.['So11111111111111111111111111111111111111112']?.price || 0);
  } catch {}

  const windows = results
    .filter(r => r.status === 'fulfilled' && r.value && r.value.net_bps >= minBps)
    .map(r => (r as any).value)
    .sort((a, b) => b.net_bps - a.net_bps);

  return NextResponse.json({ windows, profitable_count: windows.filter((w: any) => w.net_bps > 0).length, scanned_at: new Date().toISOString(), sol_price_usd: solPrice }, { headers: CORS });
}

export function OPTIONS() { return new NextResponse(null, { status: 204, headers: CORS }); }
