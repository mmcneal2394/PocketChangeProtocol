path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    lines = f.readlines()

# Add GLOBAL_OB_CEILING after line 127 (GLOBAL_HOLD_MIN)
new_lines = []
inserted = False
for i, line in enumerate(lines):
    new_lines.append(line)
    if 'let GLOBAL_HOLD_MIN' in line and not inserted:
        new_lines.append('let GLOBAL_OB_CEILING = 150; // Overbought ceiling % — Gemma4 can tighten dynamically\n')
        inserted = True
        print(f'  Inserted GLOBAL_OB_CEILING after line {i+1}')

# Also add to config:update handler
code = ''.join(new_lines)

# Find where GLOBAL_TP_PCT is set in config:update and add ceiling
if 'overboughtCeiling' not in code:
    code = code.replace(
        'GLOBAL_TP_PCT = cfg.maxTPpct * 100;',
        'GLOBAL_TP_PCT = cfg.maxTPpct * 100;\n          if (cfg.overboughtCeiling) GLOBAL_OB_CEILING = cfg.overboughtCeiling;'
    )
    print('  Wired config:update to set GLOBAL_OB_CEILING')

with open(path, 'w') as f:
    f.write(code)

print('Done.')
