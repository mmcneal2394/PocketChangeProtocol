import { NextRequest, NextResponse } from "next/server";
import { fetchDexScreenerSolanaSearches, fetchSolPriceUsd } from "@/lib/public-market";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function scoreToken(token: any): number {
  let score = 0;
  const liquidityUsd = token.liquidity_usd || 0;
  const volumeUsd24h = token.volume_usd_24h || 0;
  const ageHours = token.age_hours ?? 24;
  const source = token.source || "";

  if (liquidityUsd >= 100_000) score += 20;
  else if (liquidityUsd >= 30_000) score += 14;
  else if (liquidityUsd >= 8_000) score += 8;

  if (volumeUsd24h >= 500_000) score += 20;
  else if (volumeUsd24h >= 100_000) score += 14;
  else if (volumeUsd24h >= 30_000) score += 8;

  if (ageHours <= 6) score += 15;
  else if (ageHours <= 24) score += 10;
  else if (ageHours <= 72) score += 5;

  if (source === "seeded") score += 30;
  if (source === "boosted") score += 15;
  if (source === "dexscreener") score += 10;

  return Math.min(score, 100);
}

const SEEDED = [
  { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", source: "seeded", age_hours: 0 },
  { mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", symbol: "USDT", source: "seeded", age_hours: 0 },
  { mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So", symbol: "MSOL", source: "seeded", age_hours: 0 },
  { mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", symbol: "jitoSOL", source: "seeded", age_hours: 0 },
  { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "BONK", source: "seeded", age_hours: 0 },
  { mint: "EKpQGSJt7KHZGF2v8pTU3s6ixHqJYqaGYcqDsGNXoMbv", symbol: "WIF", source: "seeded", age_hours: 0 },
  { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", symbol: "JUP", source: "seeded", age_hours: 0 },
];

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const minLiquidityUsd = Number(searchParams.get("minLiq") || 8000);
  const minVolumeUsd = Number(searchParams.get("minVol") || 20000);
  const maxAgeHours = Number(searchParams.get("maxAge") || 48);
  const limit = Math.min(Number(searchParams.get("limit") || 10), 25);

  const seen = new Set<string>();
  const tokens: any[] = [];

  const pairs = await fetchDexScreenerSolanaSearches(["solana", "meme solana", "new solana"]);
  for (const pair of pairs) {
    const liquidityUsd = Number(pair.liquidity?.usd || 0);
    const volumeUsd24h = Number(pair.volume?.h24 || 0);
    const createdAt = pair.pairCreatedAt || 0;
    const ageHours = createdAt ? (Date.now() - createdAt) / 3_600_000 : 24;
    const mint = pair.baseToken?.address || "";
    if (!mint || seen.has(mint)) continue;
    if (liquidityUsd < minLiquidityUsd * 0.5) continue;
    if (volumeUsd24h < minVolumeUsd * 0.25) continue;
    if (ageHours > maxAgeHours) continue;

    seen.add(mint);
    tokens.push({
      mint,
      age_hours: Math.round(ageHours * 10) / 10,
      symbol: pair.baseToken?.symbol || "UNK",
      name: pair.baseToken?.name || "",
      liquidity_usd: liquidityUsd,
      volume_usd_24h: volumeUsd24h,
      price_usd: Number(pair.priceUsd || 0),
      price_change_24h: Number(pair.priceChange?.h24 || 0),
      source: "dexscreener",
    });
  }

  for (const seeded of SEEDED) {
    if (seen.has(seeded.mint)) continue;
    seen.add(seeded.mint);
    tokens.push({
      ...seeded,
      liquidity_usd: 0,
      volume_usd_24h: 0,
      price_usd: 0,
      price_change_24h: 0,
      name: "",
    });
  }

  const scored = tokens
    .map((token) => ({ ...token, score: scoreToken(token) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);

  const solPriceUsd = await fetchSolPriceUsd();

  return NextResponse.json(
    { tokens: scored, scanned_at: new Date().toISOString(), sol_price_usd: solPriceUsd },
    { headers: CORS },
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
