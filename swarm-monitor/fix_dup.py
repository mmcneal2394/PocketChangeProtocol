path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    lines = f.readlines()

# Remove lines 600-610 (the first duplicate mayhem block)
# Keep the one at 611+ (right before getQuote)
start = 599  # 0-indexed for line 600
end = 610    # 0-indexed for line 611 (exclusive)

# Verify we're removing the right block
block = ''.join(lines[start:end])
if 'MAYHEM MODE FILTER' in block and lines[end].strip().startswith('// MAYHEM MODE FILTER'):
    del lines[start:end]
    print(f'OK Removed duplicate mayhem block (lines 600-610)')
else:
    print(f'SKIP: block at lines 600-610 does not match expected mayhem duplicate')
    print(f'Content: {block[:200]}')

with open(path, 'w') as f:
    f.writelines(lines)

# Verify only 1 remains
with open(path) as f:
    content = f.read()
count = content.count('MAYHEM MODE FILTER')
print(f'Remaining MAYHEM blocks: {count}')
