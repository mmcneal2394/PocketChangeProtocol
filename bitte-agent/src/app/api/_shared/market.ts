export const WSOL = "So11111111111111111111111111111111111111112";

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36";

export async function fetchDexScreenerSolanaSearch(query: string): Promise<any[]> {
  const res = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`, {
    headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.pairs || []).filter((pair: any) => pair.chainId === "solana");
}

export async function fetchDexScreenerSolanaSearches(queries: string[]): Promise<any[]> {
  const seen = new Set<string>();
  const merged: any[] = [];
  const results = await Promise.allSettled(queries.map((query) => fetchDexScreenerSolanaSearch(query)));

  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const pair of result.value) {
      const key = pair.pairAddress || pair.baseToken?.address || pair.url;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(pair);
    }
  }

  return merged;
}

function parseJupiterPrice(payload: any): number {
  const direct = Number(payload?.[WSOL]?.usdPrice || 0);
  if (Number.isFinite(direct) && direct > 0) return direct;

  const nestedUsd = Number(payload?.data?.[WSOL]?.usdPrice || 0);
  if (Number.isFinite(nestedUsd) && nestedUsd > 0) return nestedUsd;

  const nestedLegacy = Number(payload?.data?.[WSOL]?.price || 0);
  if (Number.isFinite(nestedLegacy) && nestedLegacy > 0) return nestedLegacy;

  return 0;
}

export async function fetchSolPriceUsd(): Promise<number> {
  for (const url of [
    `https://lite-api.jup.ag/price/v3?ids=${WSOL}`,
    `https://api.jup.ag/price/v3?ids=${WSOL}`,
  ]) {
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) continue;
      const payload = await res.json();
      const price = parseJupiterPrice(payload);
      if (price > 0) return price;
    } catch {
      // Try the next provider.
    }
  }

  try {
    const pairs = await fetchDexScreenerSolanaSearch(`${WSOL} usdc`);
    for (const pair of pairs) {
      const price = Number(pair?.priceUsd || 0);
      if (Number.isFinite(price) && price > 0) return price;
    }
  } catch {
    // Fall through to zero.
  }

  return 0;
}
