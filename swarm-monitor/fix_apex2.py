path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    lines = f.readlines()

# Find and replace the Apex force-sell block (lines 678-682 area)
new_lines = []
i = 0
patched = False
while i < len(lines):
    line = lines[i]
    # Match the exact line
    if 'isHighConviction === false' in line and not patched:
        # Replace the 4-line block (if/console/forceExit/reason)
        new_lines.append('            if (isHighConviction === false) {\n')
        new_lines.append('                 // NEUTERED: Apex no longer force-dumps. Tightens SL instead.\n')
        new_lines.append('                 console.log(`[SNIPER] ⚠️ APEX flagged ${pos.symbol} (${apexRedFlags} red flags) — tightening SL, not dumping`);\n')
        new_lines.append('                 pos.stopLossPct = 0.05; // Tight SL for flagged tokens\n')
        # Skip the old lines (console.log, forceExit, apexCancelReason)
        i += 1
        while i < len(lines) and '}' not in lines[i]:
            i += 1
        # Don't skip the closing brace
        patched = True
        continue
    new_lines.append(line)
    i += 1

with open(path, 'w') as f:
    f.writelines(new_lines)

if patched:
    print('PATCHED: Apex force-sell replaced with SL tightening')
else:
    print('ERROR: Could not find isHighConviction block')
