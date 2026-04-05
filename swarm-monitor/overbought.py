path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

fixes = []

# Add overbought ceiling AFTER the LIVE DEX DATA line
# If 5m change is > 30%, the spike already happened — we'd buy the top
# If 1h change is > 100%, the token already mooned — late entry
old_live_dex = "          // Token is live on DEX with real liquidity — use live data"
new_overbought = """          // OVERBOUGHT CEILING: if price already spiked too much, we'd buy the top
          if (livePair.priceChange5m > 30) {
            console.log('[SNIPER] \\u{26a0}\\ufe0f OVERBOUGHT SKIP: ' + symbol + ' — +' + livePair.priceChange5m.toFixed(0) + '% in 5m (ceiling: 30%)');
            const pub = RedisBus.getPublisher();
            await pub.setex(REDIS_KEYS.cooldown(v.mint), 300, '1');
            continue;
          }
          if (livePair.priceChange1h > 100) {
            console.log('[SNIPER] \\u{26a0}\\ufe0f LATE ENTRY SKIP: ' + symbol + ' — +' + livePair.priceChange1h.toFixed(0) + '% in 1h (ceiling: 100%)');
            const pub = RedisBus.getPublisher();
            await pub.setex(REDIS_KEYS.cooldown(v.mint), 600, '1');
            continue;
          }
          // Token is live on DEX with real liquidity — use live data"""

if old_live_dex in content:
    content = content.replace(old_live_dex, new_overbought, 1)
    fixes.append('Added overbought ceiling: 5m > +30% = skip, 1h > +100% = skip')

with open(path, 'w') as f:
    f.write(content)

for f in fixes:
    print('  OK ' + f)
print('Applied ' + str(len(fixes)) + ' fixes')
