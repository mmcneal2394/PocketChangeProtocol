export const WSOL = "So11111111111111111111111111111111111111112";
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

function getPairs(payload: any): any[] {
  if (Array.isArray(payload?.pairs)) return payload.pairs;
  if (Array.isArray(payload)) return payload;
  return [];
}

export async function fetchDexScreenerSolanaSearch(query: string): Promise<any[]> {
  const url = `https://api.dexscreener.com/latest/dex/search/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA },
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });
  if (!response.ok) return [];

  const payload = await response.json();
  return getPairs(payload).filter((pair: any) => pair?.chainId === "solana");
}

export async function fetchDexScreenerSolanaSearches(queries: string[]): Promise<any[]> {
  const settled = await Promise.allSettled(queries.map((query) => fetchDexScreenerSolanaSearch(query)));
  const seen = new Set<string>();
  const pairs: any[] = [];

  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const pair of result.value) {
      const address = pair?.pairAddress || pair?.baseToken?.address;
      if (!address || seen.has(address)) continue;
      seen.add(address);
      pairs.push(pair);
    }
  }

  return pairs;
}

export async function fetchSolPriceUsd(): Promise<number> {
  const jupiterUrls = [
    `https://lite-api.jup.ag/price/v3?ids=${WSOL}`,
    `https://api.jup.ag/price/v3?ids=${WSOL}`,
  ];

  for (const url of jupiterUrls) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": BROWSER_UA },
        signal: AbortSignal.timeout(6000),
        cache: "no-store",
      });
      if (!response.ok) continue;
      const payload = await response.json();
      const usdPrice = Number(payload?.[WSOL]?.usdPrice || payload?.data?.[WSOL]?.price || 0);
      if (usdPrice > 0) return usdPrice;
    } catch {
      // Fall through to the next source.
    }
  }

  try {
    const pairs = await fetchDexScreenerSolanaSearch("SOL USDC");
    const pair = pairs.find((item: any) => Number(item?.priceUsd || 0) > 0);
    const usdPrice = Number(pair?.priceUsd || 0);
    if (usdPrice > 0) return usdPrice;
  } catch {
    // Fall through to the final zero fallback.
  }

  return 0;
}
