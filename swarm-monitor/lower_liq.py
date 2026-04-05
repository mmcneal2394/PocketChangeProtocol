path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

# Allow $0 liq (pump.fun bonding curve) through - only block known low liq > 0
# The Jupiter quote + slippage check at 3% will protect us from truly untradeable tokens
old = "livePair.liquidity < 5000"
new = "livePair.liquidity > 0 && livePair.liquidity < 3000"
if old in content:
    content = content.replace(old, new)
    print('OK: lowered liquidity floor to $3K, allow $0 (pump.fun bonding curve) through')

with open(path, 'w') as f:
    f.write(content)
