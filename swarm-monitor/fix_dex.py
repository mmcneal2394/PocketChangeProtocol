path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

fixes = []

# 1. Add a DexScreener pair lookup function near the top (after imports)
# Find a good insertion point - after the REDIS_KEYS or loadVelocity function
fetch_fn = """
// ── DexScreener Real-Time Pair Lookup ─────────────────────────────────────
async function fetchDexScreenerPair(mint: string): Promise<{liquidity: number, priceChange5m: number, priceChange1h: number, volume1h: number, boosted: boolean} | null> {
  try {
    const res = await fetch(\`https://api.dexscreener.com/latest/dex/tokens/\${mint}\`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.pairs || data.pairs.length === 0) return null;
    // Pick the highest-liquidity pair
    const pair = data.pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return {
      liquidity: pair.liquidity?.usd || 0,
      priceChange5m: pair.priceChange?.m5 || 0,
      priceChange1h: pair.priceChange?.h1 || 0,
      volume1h: pair.volume?.h1 || 0,
      boosted: !!(pair.boosts?.active && pair.boosts.active > 0),
    };
  } catch { return null; }
}
"""

# Insert after "function loadVelocity" block
marker = "function loadAllVelocityMints()"
if marker in content:
    idx = content.index(marker)
    # Find the line start
    line_start = content.rfind('\n', 0, idx)
    content = content[:line_start] + '\n' + fetch_fn + '\n' + content[line_start:]
    fixes.append('Added fetchDexScreenerPair() for real-time liquidity + boosted check')

# 2. Replace the NO DATA SKIP with a live DexScreener lookup
old_nodata = """        // Require we have SOME price data — don't blind-buy unknown tokens
        if (!trending) {
          console.log(`[SNIPER] 📉 NO DATA SKIP: ${symbol} — no DexScreener data, could be dead`);
          const pub = RedisBus.getPublisher();
          await pub.setex(REDIS_KEYS.cooldown(v.mint), 300, '1');
          continue;
        }"""

new_nodata = """        // If no cached trending data, do a LIVE DexScreener lookup
        if (!trending) {
          const livePair = await fetchDexScreenerPair(v.mint);
          if (!livePair || livePair.liquidity < 5000) {
            console.log(`[SNIPER] 📉 NO PAIR SKIP: ${symbol} — no DEX pair or liq $${livePair?.liquidity?.toFixed(0) || '0'} < $5K`);
            const pub = RedisBus.getPublisher();
            await pub.setex(REDIS_KEYS.cooldown(v.mint), 300, '1');
            continue;
          }
          if (livePair.priceChange5m < 0) {
            console.log(`[SNIPER] 📉 LIVE DUMP SKIP: ${symbol} — price ${livePair.priceChange5m.toFixed(1)}% in 5m`);
            const pub = RedisBus.getPublisher();
            await pub.setex(REDIS_KEYS.cooldown(v.mint), 300, '1');
            continue;
          }
          // Token is live on DEX with real liquidity — use live data
          console.log(`[SNIPER] ✅ LIVE DEX DATA: ${symbol} — liq $${livePair.liquidity.toFixed(0)} | 5m: ${livePair.priceChange5m > 0 ? '+' : ''}${livePair.priceChange5m.toFixed(1)}%${livePair.boosted ? ' 🚀 BOOSTED' : ''}`);
          // Override variables with live data
          mom5m = livePair.priceChange5m;
          pc1h = livePair.priceChange1h;
        }"""

if old_nodata in content:
    content = content.replace(old_nodata, new_nodata)
    fixes.append('Replaced NO DATA SKIP with live DexScreener pair lookup + liquidity check')

with open(path, 'w') as f:
    f.write(content)

for f in fixes:
    print(f'  OK {f}')
print(f'Applied {len(fixes)} fixes')
