path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

fixes = []

# 1. Fix exit targets: use GLOBAL values directly, not position values
# Replace the confusing fallback chain
old_exit1 = "let targetTP = GLOBAL_TP_PCT || pos.maxTPpct || 0.20;"
new_exit1 = "let targetTP = GLOBAL_TP_PCT; // 12% from .env, override via push_params"
if old_exit1 in content:
    content = content.replace(old_exit1, new_exit1)
    fixes.append('Fixed targetTP: use GLOBAL_TP_PCT only (12%)')

old_exit2 = "let targetSL = GLOBAL_SL_PCT || pos.stopLossPct || 0.50;"
new_exit2 = "let targetSL = GLOBAL_SL_PCT; // 5% from .env, override via push_params"
count = content.count(old_exit2)
if count > 0:
    content = content.replace(old_exit2, new_exit2)
    fixes.append(f'Fixed targetSL: use GLOBAL_SL_PCT only (5%) [{count} occurrences]')

# Also fix the display line
old_disp1 = "let dynamicTP = GLOBAL_TP_PCT || pos.maxTPpct || 0.20;"
new_disp1 = "let dynamicTP = GLOBAL_TP_PCT;"
if old_disp1 in content:
    content = content.replace(old_disp1, new_disp1)
    fixes.append('Fixed display targetTP')

old_disp2 = "let dynamicSL = GLOBAL_SL_PCT || pos.stopLossPct || 0.50;"
new_disp2 = "let dynamicSL = GLOBAL_SL_PCT;"
if old_disp2 in content:
    content = content.replace(old_disp2, new_disp2)
    fixes.append('Fixed display targetSL')

# 2. Fix forceExit reason: time-based exit should say TIME_EXIT not FORCE_EXIT
old_force = "let forceExit = heldMs > MAX_HOLD_MS || !!pos.engineForceEvict; // 6min hard cap or manual dump from network"
new_force = "let forceExit = !!pos.engineForceEvict; // Only external force (Redis command)"
if old_force in content:
    content = content.replace(old_force, new_force)
    fixes.append('Fixed: time-based exit no longer triggers FORCE_EXIT label')

with open(path, 'w') as f:
    f.write(content)

for f in fixes:
    print('  OK ' + f)
print('Applied ' + str(len(fixes)) + ' fixes')
