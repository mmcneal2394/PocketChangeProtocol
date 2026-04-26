import { NextRequest, NextResponse } from "next/server";
import { BROWSER_UA, fetchDexScreenerSolanaSearches } from "@/lib/public-market";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function getDexScreenerSpikes() {
  try {
    const signals = [];
    const pairs = await fetchDexScreenerSolanaSearches(["solana", "meme solana", "new solana"]);
    for (const pair of pairs.slice(0, 80)) {
      const buysH1 = pair.txns?.h1?.buys || 0;
      const buysH6 = (pair.txns?.h6?.buys || 0) / 6;
      const volH1 = Number(pair.volume?.h1 || 0);
      const priceChange = Number(pair.priceChange?.h1 || 0);
      const ratio = buysH1 / Math.max(buysH6, 1);
      if (ratio < 1.5 && Math.abs(priceChange) < 5) continue;
      const score = Math.min(
        (ratio >= 3 ? 25 : ratio >= 1.5 ? 15 : 0) +
          (volH1 >= 50_000 ? 20 : volH1 >= 10_000 ? 10 : 0) +
          (priceChange >= 10 ? 15 : priceChange >= 5 ? 8 : 0),
        100,
      );
      signals.push({
        type: ratio >= 3 && volH1 >= 50_000 ? "CONVICTION" : "MOMENTUM",
        symbol: pair.baseToken?.symbol || "UNK",
        mint: pair.baseToken?.address || "",
        score,
        sources: ["dexscreener_spike"],
        action: score >= 65 ? "SCAN_ARB" : "MONITOR",
        evidence: {
          spike_ratio: Math.round(ratio * 10) / 10,
          vol_h1: Math.round(volH1),
          price_change_h1: priceChange,
        },
      });
    }
    return signals;
  } catch {
    return [];
  }
}

async function getDexScreenerScannerFallback() {
  try {
    const signals = [];
    const pairs = await fetchDexScreenerSolanaSearches(["solana", "meme solana", "new solana"]);
    for (const pair of pairs.slice(0, 80)) {
      const mint = pair.baseToken?.address || "";
      const liquidityUsd = Number(pair.liquidity?.usd || 0);
      const volumeH24 = Number(pair.volume?.h24 || 0);
      const buysH1 = Number(pair.txns?.h1?.buys || 0);
      const buysM5 = Number(pair.txns?.m5?.buys || 0);
      const priceChangeH24 = Number(pair.priceChange?.h24 || 0);
      const priceChangeH1 = Number(pair.priceChange?.h1 || 0);
      if (!mint || liquidityUsd < 12_000 || volumeH24 < 40_000) continue;

      const score = Math.min(
        (liquidityUsd >= 100_000 ? 20 : liquidityUsd >= 30_000 ? 14 : 8) +
          (volumeH24 >= 500_000 ? 20 : volumeH24 >= 100_000 ? 14 : 8) +
          (priceChangeH24 >= 20 ? 18 : priceChangeH24 >= 10 ? 10 : priceChangeH1 >= 3 ? 6 : 0) +
          (buysH1 >= 50 ? 12 : buysH1 >= 20 ? 8 : buysM5 >= 5 ? 5 : 0),
        100,
      );

      if (score < 40) continue;

      signals.push({
        type: score >= 65 ? "CONVICTION" : "MOMENTUM",
        symbol: pair.baseToken?.symbol || "UNK",
        mint,
        score,
        sources: ["dexscreener_scan"],
        action: score >= 65 ? "SCAN_ARB" : "MONITOR",
        evidence: {
          liquidity_usd: Math.round(liquidityUsd),
          volume_h24: Math.round(volumeH24),
          buys_h1: buysH1,
          price_change_h24: priceChangeH24,
        },
      });
    }
    return signals;
  } catch {
    return [];
  }
}

async function getPumpFunGraduations() {
  try {
    const response = await fetch("https://api.dexscreener.com/token-boosts/top/v1", {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(6000),
      cache: "no-store",
    });
    if (!response.ok) return [];
    const data = await response.json();
    if (!Array.isArray(data)) return [];
    return data
      .filter((item: any) => item.chainId === "solana")
      .slice(0, 8)
      .map((item: any) => ({
        type: "GRADUATION",
        symbol: item.symbol || item.tokenAddress?.slice(0, 8) || "UNK",
        mint: item.tokenAddress || "",
        score: 30,
        sources: ["boosted"],
        action: "SCREEN",
        evidence: {
          boost_amount: item.amount,
          description: (item.description || "").slice(0, 60),
        },
      }));
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const minScore = Number(searchParams.get("minScore") || 40);

  const [spikes, graduations, scannerFallback] = await Promise.all([
    getDexScreenerSpikes(),
    getPumpFunGraduations(),
    getDexScreenerScannerFallback(),
  ]);
  const merged = new Map<string, any>();

  for (const signal of [...spikes, ...graduations, ...scannerFallback]) {
    if (!signal.mint) continue;
    if (merged.has(signal.mint)) {
      const current = merged.get(signal.mint)!;
      current.score += Math.round(signal.score * 0.5);
      current.sources = [...new Set([...current.sources, ...signal.sources])];
      if (current.sources.length >= 2) current.type = "CONVICTION";
      continue;
    }
    merged.set(signal.mint, { ...signal });
  }

  const mergedSignals = Array.from(merged.values()).sort((left, right) => right.score - left.score);
  const primarySignals = mergedSignals.filter((signal) => signal.score >= minScore);
  const signals =
    primarySignals.length > 0
      ? primarySignals
      : mergedSignals
          .filter((signal) => signal.score >= 25)
          .slice(0, 5)
          .map((signal) => ({
            ...signal,
            action: "MONITOR",
            evidence: {
              ...(signal.evidence || {}),
              fallback_floor: true,
            },
          }));

  return NextResponse.json(
    { signals, generated_at: new Date().toISOString() },
    { headers: CORS },
  );
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}
