path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

# Fix the default velocity values - buyRatio60s should be between 0-1 (percentage)
# and buys/sells numbers should be high enough to pass filters
old = """            mintsObj[m] = {
              buys60s: 10, sells60s: 2, buyRatio60s: 5.0,
              velocity: 15, isAccelerating: true, solVolume60s: 1.0,
            };"""

new = """            mintsObj[m] = {
              buys60s: 25, sells60s: 5, buyRatio60s: 0.83,
              velocity: 20, isAccelerating: true, solVolume60s: 2.0,
            };"""

if old in content:
    content = content.replace(old, new)
    with open(path, 'w') as f:
        f.write(content)
    print('FIXED: buyRatio60s corrected to 0.83 (83% buys)')
else:
    print('ERROR: target not found')
