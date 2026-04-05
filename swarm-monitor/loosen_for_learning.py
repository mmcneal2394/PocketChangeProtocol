path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

fixes = []

# Change: If no trending data AND DexScreener returns no pair, still let through
# if RugCheck says safe AND velocity is strong. We need to take some trades to learn.
old_nopair = """          if (!livePair || livePair.liquidity < 5000) {
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
          }"""

new_nopair = """          if (livePair && livePair.liquidity < 5000) {
            console.log(`[SNIPER] 📉 LOW LIQ SKIP: ${symbol} — liq $${livePair.liquidity.toFixed(0)} < $5K`);
            const pub = RedisBus.getPublisher();
            await pub.setex(REDIS_KEYS.cooldown(v.mint), 300, '1');
            continue;
          }
          if (livePair && livePair.priceChange5m < -5) {
            console.log(`[SNIPER] 📉 LIVE DUMP SKIP: ${symbol} — price ${livePair.priceChange5m.toFixed(1)}% in 5m`);
            const pub = RedisBus.getPublisher();
            await pub.setex(REDIS_KEYS.cooldown(v.mint), 300, '1');
            continue;
          }"""

if old_nopair in content:
    content = content.replace(old_nopair, new_nopair)
    fixes.append('Loosened: allow tokens without DexScreener data if velocity is strong')
    fixes.append('Loosened: only skip 5m dumps worse than -5% (was any negative)')

# Also change the dead token skip for 5m: only reject if strongly negative
old_dead = """        if (mom5m !== undefined && mom5m < 0) {
          console.log(`[SNIPER] 📉 DEAD TOKEN SKIP: ${symbol} price DOWN ${mom5m.toFixed(1)}% in 5m — not buying dumps`);
          continue;
        }"""
new_dead = """        if (mom5m !== undefined && mom5m < -5) {
          console.log(`[SNIPER] 📉 DEAD TOKEN SKIP: ${symbol} price DOWN ${mom5m.toFixed(1)}% in 5m — not buying dumps`);
          continue;
        }"""
if old_dead in content:
    content = content.replace(old_dead, new_dead)
    fixes.append('Loosened: only skip tokens dumping >5% in 5m (was any negative)')

with open(path, 'w') as f:
    f.write(content)

for f in fixes:
    print(f'  OK {f}')
print(f'Applied {len(fixes)} fixes')
