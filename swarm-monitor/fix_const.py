path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

fixes = []

# Fix 1: const -> let for variables we reassign in the live DexScreener block
content = content.replace('        const pc1h     = trending?.priceChange1h ?? 0;', '        let pc1h     = trending?.priceChange1h ?? 0;')
content = content.replace('        const mom5m       = trending?.priceChange5m ?? undefined;', '        let mom5m: number | undefined       = trending?.priceChange5m ?? undefined;')
content = content.replace('        const mom1m       = trending?.priceChange1m ?? undefined;', '        let mom1m: number | undefined       = trending?.priceChange1m ?? undefined;')
fixes.append('Fixed const -> let for pc1h, mom5m, mom1m (reassigned in live DexScreener block)')

# Fix 2: null check on livePair.liquidity - the condition already checks livePair but
# the log accesses it outside the condition. Let me find the issue:
old_liq_check = 'livePair.liquidity > 0 && livePair.liquidity < 3000'
new_liq_check = 'livePair && livePair.liquidity > 0 && livePair.liquidity < 3000'
if old_liq_check in content:
    content = content.replace(old_liq_check, new_liq_check)
    fixes.append('Added null check on livePair before accessing liquidity')

with open(path, 'w') as f:
    f.write(content)

for f in fixes:
    print(f'  OK {f}')
print(f'Applied {len(fixes)} fixes')
