path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

fixes = []

# Add 5-min cooldown after age reject
old1 = '     logMissedTarget({ mint, symbol, reason: "Too young (<30min)", age: tokenAgeSec });\n     return;'
new1 = '     logMissedTarget({ mint, symbol, reason: "Too young (<5min)", age: tokenAgeSec });\n     await pub.setex(REDIS_KEYS.cooldown(mint), 300, \'1\');\n     return;'
if old1 in content:
    content = content.replace(old1, new1)
    fixes.append('5-min cooldown on age reject')

# Try alternate string
old1b = '     logMissedTarget({ mint, symbol, reason: "Too young (<5min)", age: tokenAgeSec });\n     return;'
new1b = '     logMissedTarget({ mint, symbol, reason: "Too young (<5min)", age: tokenAgeSec });\n     await pub.setex(REDIS_KEYS.cooldown(mint), 300, \'1\');\n     return;'
if old1b in content and 'cooldown' not in content.split(old1b)[0][-100:]:
    content = content.replace(old1b, new1b)
    fixes.append('5-min cooldown on age reject (alt)')

# Add 5-min cooldown after liquidity reject  
old2 = '     logMissedTarget({ mint, symbol, reason: "Below $5K liquidity floor", poolLiq });\n     return;'
new2 = '     logMissedTarget({ mint, symbol, reason: "Below $5K liquidity floor", poolLiq });\n     await pub.setex(REDIS_KEYS.cooldown(mint), 300, \'1\');\n     return;'
if old2 in content:
    content = content.replace(old2, new2)
    fixes.append('5-min cooldown on liquidity reject')

# Add 5-min cooldown after confidence reject
old3 = '     logMissedTarget({ mint, symbol, reason: "Target Qualifier Confidence Too Low", confidence: confidenceScore, poolLiq });\n     return;'
new3 = '     logMissedTarget({ mint, symbol, reason: "Target Qualifier Confidence Too Low", confidence: confidenceScore, poolLiq });\n     await pub.setex(REDIS_KEYS.cooldown(mint), 300, \'1\');\n     return;'
if old3 in content:
    content = content.replace(old3, new3)
    fixes.append('5-min cooldown on confidence reject')

with open(path, 'w') as f:
    f.write(content)

for f in fixes:
    print(f'  OK {f}')
print(f'Applied {len(fixes)} fixes')
