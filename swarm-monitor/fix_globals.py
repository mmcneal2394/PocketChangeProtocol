path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

# Fix: Use GLOBAL overrides instead of per-position stale values
content = content.replace(
    "    let targetTP = pos.maxTPpct || 0.20;\n    let targetSL = pos.stopLossPct || 0.50;\n    const targetTime = pos.maxHoldMinutes || 10;",
    "    let targetTP = GLOBAL_TP_PCT || pos.maxTPpct || 0.20;\n    let targetSL = GLOBAL_SL_PCT || pos.stopLossPct || 0.50;\n    const targetTime = GLOBAL_HOLD_MIN || pos.maxHoldMinutes || 10;"
)

with open(path, 'w') as f:
    f.write(content)
print('FIXED: TP/SL/Hold now read from GLOBAL overrides first, then per-position fallback')
