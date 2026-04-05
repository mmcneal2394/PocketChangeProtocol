path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    lines = f.readlines()

# Fix: the removal left a dangling } on line 1052
# Find the line
for i, line in enumerate(lines):
    if 'force_sell.json: REMOVED' in line:
        # Check if next line is just `}`
        if i+1 < len(lines) and lines[i+1].strip() == '}':
            del lines[i+1]
            print(f'OK Removed dangling closing brace at line {i+2}')
        # Also check if there's an orphan `if` before the comment
        if i > 0 and lines[i-1].strip().startswith('//'):
            pass  # comment line, OK 
        break

with open(path, 'w') as f:
    f.writelines(lines)
