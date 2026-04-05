path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

fixes = []

# Add price direction check right before trySnipe call
old_trysnipe = """        await trySnipe(v.mint, symbol, vol1h, pc1h,
                       buys1h, sells1h, buyRatio,
                       ta?.signal, ta?.confidence,
                       tokenAgeSec, mom5m, mom1m, createdAt);"""

new_trysnipe = """        // PRICE DIRECTION CHECK: Don't buy dead/dumping tokens
        if (mom5m !== undefined && mom5m < 0) {
          console.log(`[SNIPER] 📉 DEAD TOKEN SKIP: ${symbol} price DOWN ${mom5m.toFixed(1)}% in 5m — not buying dumps`);
          continue;
        }
        if (mom1m !== undefined && mom1m < -3) {
          console.log(`[SNIPER] 📉 CRASHING SKIP: ${symbol} price DOWN ${mom1m.toFixed(1)}% in 1m — active dump`);
          continue;
        }
        // Require we have SOME price data — don't blind-buy unknown tokens
        if (!trending) {
          console.log(`[SNIPER] 📉 NO DATA SKIP: ${symbol} — no DexScreener data, could be dead`);
          const pub = RedisBus.getPublisher();
          await pub.setex(REDIS_KEYS.cooldown(v.mint), 300, '1');
          continue;
        }

        await trySnipe(v.mint, symbol, vol1h, pc1h,
                       buys1h, sells1h, buyRatio,
                       ta?.signal, ta?.confidence,
                       tokenAgeSec, mom5m, mom1m, createdAt);"""

if old_trysnipe in content:
    content = content.replace(old_trysnipe, new_trysnipe)
    fixes.append('Added price direction check: reject 5m negative, 1m crash, and no-data tokens')

with open(path, 'w') as f:
    f.write(content)

for f in fixes:
    print(f'  OK {f}')
print(f'Applied {len(fixes)} fixes')
