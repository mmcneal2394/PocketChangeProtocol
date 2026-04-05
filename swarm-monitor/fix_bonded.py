"""
Fix the bonded-only filter: Allow pump.fun tokens that Jupiter can actually route.
The issue is that poolLiq comes from DexScreener momentum data which only shows 
Raydium/Orca pools. Pump.fun tokens ARE tradeable via Jupiter even before bonding.

Change: Instead of hard-rejecting poolLiq <= 0, only reject if BOTH:
1. No DexScreener liquidity AND
2. Token has pump.fun suffix (prebonded marker)
But actually, just remove the unbonded reject entirely and rely on the 
quote-based slippage check (3% max) to filter untradeable tokens.
The getQuote call at line 560 will return null if there's no route.
"""
path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

fixes = []

# Remove the strict unbonded reject - let Jupiter's quote handle it
old_unbonded = """  // BONDED ONLY: reject tokens with no DEX pool (prebonded pump.fun)
  if (poolLiq <= 0) {
     console.log(`[SNIPER] 🐜 UNBONDED REJECT: ${symbol} has no DEX liquidity — prebonded pump.fun token`);
     logMissedTarget({ mint, symbol, reason: "No DEX pool (unbonded)", poolLiq: 0 });
     return;
  }
  // AGE FILTER: reject tokens younger than 5 minutes (fresh launches = deployer bait)
  if (tokenAgeSec !== undefined && tokenAgeSec < 300) {
     console.log(`[SNIPER] 🐜 FRESH LAUNCH REJECT: ${symbol} only ${(tokenAgeSec/60).toFixed(0)}m old (min 5m)`);
     logMissedTarget({ mint, symbol, reason: "Too young (<30min)", age: tokenAgeSec });
     return;
  }
  // Market cap floor: reject anything under $5K liquidity
  if (poolLiq < 5000) {
     console.log(`[SNIPER] 🐜 MCAP/LIQ REJECT: ${symbol} liquidity $${poolLiq.toFixed(0)} < $5K floor`);
     logMissedTarget({ mint, symbol, reason: "Below $5K liquidity floor", poolLiq });
     return;
  }"""

new_unbonded = """  // AGE FILTER: reject tokens younger than 5 minutes
  if (tokenAgeSec !== undefined && tokenAgeSec < 300) {
     console.log(`[SNIPER] 🐜 FRESH LAUNCH REJECT: ${symbol} only ${(tokenAgeSec/60).toFixed(0)}m old (min 5m)`);
     logMissedTarget({ mint, symbol, reason: "Too young (<5min)", age: tokenAgeSec });
     return;
  }
  // LIQUIDITY: If DexScreener reports liquidity, require minimum $5K
  // For pump.fun bonding curve tokens, poolLiq may be 0 - Jupiter still routes them
  if (poolLiq > 0 && poolLiq < 5000) {
     console.log(`[SNIPER] 🐜 LOW LIQ REJECT: ${symbol} liquidity $${poolLiq.toFixed(0)} < $5K`);
     logMissedTarget({ mint, symbol, reason: "Below $5K liquidity", poolLiq });
     return;
  }"""

if old_unbonded in content:
    content = content.replace(old_unbonded, new_unbonded)
    fixes.append('Removed hard unbonded reject - Jupiter quote handles routing')
    fixes.append('Kept $5K floor for tokens WITH known liquidity')
    fixes.append('Kept 5-min age filter')

with open(path, 'w') as f:
    f.write(content)

for f in fixes:
    print(f'  OK {f}')
print(f'Applied {len(fixes)} fixes')
