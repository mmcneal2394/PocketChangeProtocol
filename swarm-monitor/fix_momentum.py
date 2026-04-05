path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

fixes = []

# 1. Block velocity-only entries (no DexScreener data = no buy)
old1 = "console.log(`[SNIPER] ⚡ NO DEX DATA, velocity-only: ${symbol}`);"
new1 = """console.log(`[SNIPER] 🚫 NO DEX DATA REJECT: ${symbol} — cannot confirm momentum`);
            const pub2 = RedisBus.getPublisher();
            await pub2.setex(REDIS_KEYS.cooldown(v.mint), 300, '1');
            continue;"""

# Need to also handle the else block structure
old_else = """          } else {
            console.log(`[SNIPER] ⚡ NO DEX DATA, velocity-only: ${symbol}`);
          }"""
new_else = """          } else {
            console.log(`[SNIPER] 🚫 NO DEX DATA REJECT: ${symbol} — cannot confirm momentum`);
            const coolPub = RedisBus.getPublisher();
            await coolPub.setex(REDIS_KEYS.cooldown(v.mint), 300, '1');
            continue;
          }"""

if old_else in content:
    content = content.replace(old_else, new_else)
    fixes.append('Block tokens with no DexScreener data')

# 2. Require positive momentum for tokens WITH data
old2 = 'mom5m < -5'
new2 = 'mom5m < 0 && pc1h < 5'
# Find it in the DEAD TOKEN SKIP line
dead_line = 'DEAD TOKEN SKIP'
if dead_line in content and old2 in content:
    # Replace only in the dead token context
    idx = content.index(dead_line)
    region_start = content.rfind('if (', 0, idx)
    region_end = content.index('continue;', idx) + len('continue;')
    region = content[region_start:region_end]
    if old2 in region:
        new_region = region.replace(old2, new2)
        new_region = new_region.replace('DEAD TOKEN SKIP', 'NO MOMENTUM SKIP')
        new_region = new_region.replace('not buying dumps', 'no upward momentum')
        content = content[:region_start] + new_region + content[region_end:]
        fixes.append('Require positive 5m OR +5% 1h (no dead tokens)')

# 3. Reject ANY negative 5m on live DexScreener lookup
old3 = 'livePair.priceChange5m < -5'
new3 = 'livePair.priceChange5m < 0'
if old3 in content:
    content = content.replace(old3, new3)
    fixes.append('Reject any negative 5m on live DexScreener check')

with open(path, 'w') as f:
    f.write(content)

for f in fixes:
    print('  OK ' + f)
print('Applied ' + str(len(fixes)) + ' fixes')
