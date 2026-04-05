path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

fixes = []

# 1. Liquidity: $20K is way too high for memecoins. Drop to $5K.
old = "livePair.liquidity > 0 && livePair.liquidity < 20000"
new = "livePair.liquidity > 0 && livePair.liquidity < 5000"
if old in content:
    content = content.replace(old, new)
    fixes.append('Liquidity floor: $5K (was $20K — too restrictive)')

# 2. 5m momentum: +3% too strict. Drop to +1% (just needs to be moving up)
old = "livePair.priceChange5m < 3"
new = "livePair.priceChange5m < 1"
if old in content:
    content = content.replace(old, new)
    fixes.append('Live 5m gate: +1% (was +3%)')

old = "mom5m < 3"
new = "mom5m < 1"
if old in content:
    content = content.replace(old, new)
    fixes.append('Trending 5m gate: +1% (was +3%)')

# 3. Top10 holders: 40% too tight for new tokens. Bump to 55%.
old = "top10Pct <= 40"
new = "top10Pct <= 55"
if old in content:
    content = content.replace(old, new)
    fixes.append('Top10 holder cap: 55% (was 40%)')

# 4. Keep overbought ceiling (30% / 100%) — that's good protection

with open(path, 'w') as f:
    f.write(content)

for f in fixes:
    print('  OK ' + f)
print('Applied ' + str(len(fixes)) + ' fixes')
