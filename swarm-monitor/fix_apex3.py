path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

# Simply comment out the force-exit lines while keeping the log
content = content.replace(
    "                 console.log(`[SNIPER] 🚨 APEX PREDATOR RETRO-FIRE-SELL: ${pos.symbol} flagged for CRIME (Score ≤ 3) — DUMPING IMMEDIATELY!`);\n                 forceExit = true;\n                 apexCancelReason = 'APEX: MANIPULATION DETECTED';",
    "                 // [DISABLED] Apex no longer force-dumps positions\n                 // forceExit = true;\n                 // apexCancelReason = 'APEX: MANIPULATION DETECTED';"
)

with open(path, 'w') as f:
    f.write(content)
print('DONE: forceExit and apexCancelReason lines commented out')
