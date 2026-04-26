import { NextRequest, NextResponse } from "next/server";
import { fetchSolPriceUsd, WSOL } from "@/lib/public-market";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const JUPITER_QUOTE_URL = "https://lite-api.jup.ag/swap/v1/quote";

const ROUTES = [
  { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", slippageBps: 30 },
  { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", slippageBps: 30 },
  { mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", symbol: "MSOL", slippageBps: 20 },
  { mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", symbol: "jitoSOL", slippageBps: 20 },
  { mint: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1", symbol: "bSOL", slippageBps: 20 },
  { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "BONK", slippageBps: 100 },
  { mint: "EKpQGSJt7KHZGF2v8pTU3s6ixHqJYqaGYcqDsGNXoMbv", symbol: "WIF", slippageBps: 100 },
  { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", symbol: "JUP", slippageBps: 50 },
  { mint: "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE", symbol: "ORCA", slippageBps: 40 },
  { mint: "4k3DyjzvzpRFmzGNFk1G8hNKHHkCpAb3NXFHHqFiNNo6", symbol: "RAY", slippageBps: 40 },
];

async function quoteRoute(
  inputMint: string,
  outputMint: string,
  amount: number,
  slippageBps: number,
): Promise<{ outAmount: number } | null> {
  try {
    const response = await fetch(
      `${JUPITER_QUOTE_URL}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`,
      { signal: AbortSignal.timeout(6000), cache: "no-store" },
    );
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const capitalSol = Number(searchParams.get("capitalSol") || 0.2);
  const minBps = Number(searchParams.get("minBps") || 0);
  const lamports = Math.round(capitalSol * 1_000_000_000);

  const settled = await Promise.allSettled(
    ROUTES.map(async (route) => {
      const firstLeg = await quoteRoute(WSOL, route.mint, lamports, route.slippageBps);
      if (!firstLeg?.outAmount) return null;

      const tokenOut = Number(firstLeg.outAmount);
      const secondLeg = await quoteRoute(route.mint, WSOL, tokenOut, route.slippageBps);
      if (!secondLeg?.outAmount) return null;

      const solOut = Number(secondLeg.outAmount);
      const grossBps = ((solOut - lamports) / lamports) * 10_000;
      const gasSol = 5_000 / 1_000_000_000;
      const tipSol = Math.max(0, ((solOut - lamports) / 1_000_000_000) * 0.5);
      const netSol = (solOut - lamports) / 1_000_000_000 - gasSol - tipSol;
      const netBps = (netSol / capitalSol) * 10_000;

      return {
        symbol: route.symbol,
        mint: route.mint,
        gross_bps: Math.round(grossBps * 100) / 100,
        net_bps: Math.round(netBps * 100) / 100,
        net_sol: Math.round(netSol * 1e6) / 1e6,
        capital_sol: capitalSol,
        profitable: netBps > 0,
      };
    }),
  );

  const solPriceUsd = await fetchSolPriceUsd();
  const windows = settled
    .filter((result) => result.status === "fulfilled" && result.value && result.value.net_bps >= minBps)
    .map((result) => (result as PromiseFulfilledResult<any>).value)
    .sort((left, right) => right.net_bps - left.net_bps);

  return NextResponse.json(
    {
      windows,
      profitable_count: windows.filter((window) => window.net_bps > 0).length,
      scanned_at: new Date().toISOString(),
      sol_price_usd: solPriceUsd,
    },
    { headers: CORS },
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
