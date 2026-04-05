"""
Final comprehensive fix:
1. Fix display log to use GLOBAL TP/SL (not per-position stale values)
2. Remove leftover Apex reference in display block
3. Add market cap floor ($25K) and bonded-only filter
"""

path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

fixes = []

# FIX 1: Display block uses GLOBAL values instead of pos.* values
old_display = "      let dynamicTP = pos.maxTPpct || 0.20;\n      let dynamicSL = pos.stopLossPct || 0.50;"
new_display = "      let dynamicTP = GLOBAL_TP_PCT || pos.maxTPpct || 0.20;\n      let dynamicSL = GLOBAL_SL_PCT || pos.stopLossPct || 0.50;"
if old_display in content:
    content = content.replace(old_display, new_display)
    fixes.append('Display log now uses GLOBAL TP/SL')

# FIX 2: Remove Apex SL widening in display block (line 791)
old_apex_display = "      if (apexRedFlags === 0 && isHighConviction && peak < 15) dynamicSL += 0.10;"
new_apex_display = "      // Apex widening removed"
if old_apex_display in content:
    content = content.replace(old_apex_display, new_apex_display)
    fixes.append('Removed Apex SL widening from display')

# FIX 3: Add MIN_MCAP filter ($25K) to trySnipe function
# Find the trySnipe function's liquidity check and add mcap check after it
old_liq = '  if (poolLiq > 0 && poolLiq < 3000) { // Extremely low liquidity = slippage death'
new_liq = '''  // Market cap floor: reject anything under $25K (prebonded pump.fun junk)
  if (poolLiq > 0 && poolLiq < 25000) {
     console.log(`[SNIPER] 🐜 MCAP/LIQ REJECT: ${symbol} liquidity $${poolLiq.toFixed(0)} < $25K floor`);
     logMissedTarget({ mint, symbol, reason: "Below $25K liquidity floor", poolLiq });
     return;
  }

  if (poolLiq > 0 && poolLiq < 3000) { // Extremely low liquidity = slippage death'''
if old_liq in content:
    content = content.replace(old_liq, new_liq)
    fixes.append('Added $25K mcap/liquidity floor')

with open(path, 'w') as f:
    f.write(content)

for f in fixes:
    print(f'  OK {f}')
print(f'\nApplied {len(fixes)} fixes')
