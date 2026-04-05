"""
Add minimum token age filter: tokens must be at least 30 minutes old.
Fresh launches are deployer-pumped bait.
"""

path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

fixes = []

# Add age filter right after the unbonded reject
old_unbonded = """  // BONDED ONLY: reject tokens with no DEX pool (prebonded pump.fun)
  if (poolLiq <= 0) {
     console.log(`[SNIPER] 🐜 UNBONDED REJECT: ${symbol} has no DEX liquidity — prebonded pump.fun token`);
     logMissedTarget({ mint, symbol, reason: "No DEX pool (unbonded)", poolLiq: 0 });
     return;
  }"""

new_unbonded = """  // BONDED ONLY: reject tokens with no DEX pool (prebonded pump.fun)
  if (poolLiq <= 0) {
     console.log(`[SNIPER] 🐜 UNBONDED REJECT: ${symbol} has no DEX liquidity — prebonded pump.fun token`);
     logMissedTarget({ mint, symbol, reason: "No DEX pool (unbonded)", poolLiq: 0 });
     return;
  }
  // AGE FILTER: reject tokens younger than 30 minutes (fresh launches = deployer bait)
  if (tokenAgeSec !== undefined && tokenAgeSec < 1800) {
     console.log(`[SNIPER] 🐜 FRESH LAUNCH REJECT: ${symbol} only ${(tokenAgeSec/60).toFixed(0)}m old (min 30m)`);
     logMissedTarget({ mint, symbol, reason: "Too young (<30min)", age: tokenAgeSec });
     return;
  }"""

if old_unbonded in content:
    content = content.replace(old_unbonded, new_unbonded)
    fixes.append('Added 30-minute minimum token age filter')

with open(path, 'w') as f:
    f.write(content)

for f in fixes:
    print(f'  OK {f}')
print(f'Applied {len(fixes)} fixes')
