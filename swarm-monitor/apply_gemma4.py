path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

fixes = []

# 1. Apply Gemma 4 recommendation: min liquidity $20K (from $10K)
#    This ensures tokens have real DEX liquidity pools, not just bonding curve
old_liq = "livePair.liquidity > 0 && livePair.liquidity < 10000"
new_liq = "livePair.liquidity > 0 && livePair.liquidity < 20000"
if old_liq in content:
    content = content.replace(old_liq, new_liq)
    fixes.append('Liquidity floor: $20K (Gemma4 recommendation — ensures sellable DEX pools)')

# 2. Tighten 5m change from +2% to +3%
old_5m = "livePair.priceChange5m < 2"
new_5m = "livePair.priceChange5m < 3"
if old_5m in content:
    content = content.replace(old_5m, new_5m)
    fixes.append('5m momentum gate: +3% (from +2%)')

# Also update the trending data check
old_mom = "mom5m < 2"
new_mom = "mom5m < 3"
if old_mom in content:
    content = content.replace(old_mom, new_mom)
    fixes.append('Trending 5m gate: +3% (from +2%)')

# 3. Tighten top10 holder to 40%
old_holder = "top10Pct <= 50"
new_holder = "top10Pct <= 40"
if old_holder in content:
    content = content.replace(old_holder, new_holder)
    fixes.append('Top10 holder cap: 40% (from 50%)')

# 4. Tighten stop loss to -4% (from -5%)
old_sl = "STOP_LOSS_PERCENT || '50'"
if old_sl in content:
    # The default is already overridden by .env. Let's update .env
    pass

# 5. Add a sell-ability pre-check: before buying, verify Jupiter has a reverse quote
# Find the Jupiter quote section and add reverse check
old_quote_check = "// Execute buy"
if old_quote_check in content:
    # Not found literally, let's find the actual buy execution point
    pass

with open(path, 'w') as f:
    f.write(content)

for f in fixes:
    print('  OK ' + f)
print('Applied ' + str(len(fixes)) + ' fixes')

# Update .env stop loss
env_path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/.env'
with open(env_path) as f:
    env = f.read()
env = env.replace('STOP_LOSS_PERCENT=5', 'STOP_LOSS_PERCENT=4')
with open(env_path, 'w') as f:
    f.write(env)
print('  OK .env STOP_LOSS_PERCENT=4')
