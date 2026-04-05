path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

# Fix 1: Apex Predator - only force sell if manipulation AND position is losing
# Before: any manipulation flag = instant dump
# After: manipulation flag + negative PnL = dump, but if profitable let trailing stop handle it
old = """            if (isHighConviction === false) {
                 console.log(`[SNIPER] 🚨 APEX PREDATOR RETRO-FIRE-SELL: ${pos.symbol} flagged for CRIME (Score ≤ 3) — DUMPING IMMEDIATELY!`);
                 forceExit = true;
                 apexCancelReason = 'APEX: MANIPULATION DETECTED';
            }"""

new = """            if (isHighConviction === false) {
                 // Only force-sell manipulated tokens if we're losing money on them
                 // If we're green, let the trailing stop handle the exit naturally
                 console.log(`[SNIPER] ⚠️ APEX flagged ${pos.symbol} (${apexRedFlags} red flags) — monitoring, not force-selling`);
                 // Tighten SL instead of dumping: if profitable lock gains, if losing cut at -5%
                 pos.stopLossPct = 0.05; // Override SL to -5% for flagged tokens
            }"""

if old in content:
    content = content.replace(old, new)
    print('FIX 1: Apex no longer force-dumps — tightens SL to -5% instead')
else:
    print('WARN: Apex force-sell block not found')

# Fix 2: Also soften the $4M mcap force exit - log it but don't instant-dump
old2 = """                 console.log(`[SNIPER] 🚨 $4M MAX MCAP TRIGGERED: Thin liquidity mapped by Apex. Dumping instantly!`);
                 forceExit = true;
                 apexCancelReason = 'APEX: $4M MCAP / NO LIQUIDITY';"""

new2 = """                 console.log(`[SNIPER] ⚠️ $4M MCAP + thin liquidity on ${pos.symbol} — tightening SL`);
                 pos.stopLossPct = 0.03; // Very tight SL for thin liquidity at high mcap"""

if old2 in content:
    content = content.replace(old2, new2)
    print('FIX 2: $4M mcap check tightens SL instead of force-dumping')
else:
    print('WARN: $4M mcap block not found')

with open(path, 'w') as f:
    f.write(content)
print('DONE: Apex Predator neutered — positions get room to breathe')
