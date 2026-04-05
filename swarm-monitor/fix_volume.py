path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    code = f.read()

# Add volume check using livePair.volume1h right after the liquidity check
# Find the LOW LIQ skip block and add volume check after it
old = """          if (livePair && livePair.priceChange5m < 1) {
            console.log(`[SNIPER] 📉 LIVE DUMP SKIP: ${symbol} — price ${livePair.priceChange5m.toFixed(1)}% in 5m`);"""

new = """          // MINIMUM VOLUME CHECK: skip tokens with no real trading activity
          if (livePair && livePair.volume1h < 1000) {
            console.log(`[SNIPER] 📉 LOW VOL SKIP: ${symbol} — vol $${livePair.volume1h.toFixed(0)} < $1K/1h`);
            const pub = RedisBus.getPublisher();
            await pub.setex(REDIS_KEYS.cooldown(v.mint), 300, '1');
            continue;
          }
          if (livePair && livePair.priceChange5m < 1) {
            console.log(`[SNIPER] 📉 LIVE DUMP SKIP: ${symbol} — price ${livePair.priceChange5m.toFixed(1)}% in 5m`);"""

if 'LOW VOL SKIP' not in code:
    code = code.replace(old, new)
    print('OK: Added minimum $1K/1h volume check')
else:
    print('Already present')

# Also use livePair volume when available instead of the weak estimate
old_vol = "const vol1h    = trending?.volume1h  || v.solVolume60s * 60; // estimate from 60s SOL vol"
new_vol = "let vol1h    = trending?.volume1h  || v.solVolume60s * 60; // estimate from 60s SOL vol"
if old_vol in code:
    code = code.replace(old_vol, new_vol)
    print('OK: Made vol1h mutable for livePair override')

# Update vol1h with livePair data when we have it
old_mom = "            mom5m = livePair.priceChange5m;"
new_mom = """            mom5m = livePair.priceChange5m;
            if (livePair.volume1h > vol1h) vol1h = livePair.volume1h; // use real volume"""
if 'use real volume' not in code:
    code = code.replace(old_mom, new_mom, 1)
    print('OK: Override vol1h with livePair volume when available')

with open(path, 'w') as f:
    f.write(code)
