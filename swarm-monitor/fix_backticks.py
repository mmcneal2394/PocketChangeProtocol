path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

# Fix escaped backticks in the fetch URL
old = "const res = await fetch(\\`https://api.dexscreener.com/latest/dex/tokens/\\${mint}\\`"
new = "const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`"
if old in content:
    content = content.replace(old, new)
    print('OK Fixed escaped backticks in fetch URL')
else:
    print('SKIP: escaped backticks not found, trying alternate')
    # Try raw escaped version
    old2 = 'fetch(\\\\`https://api.dexscreener.com/latest/dex/tokens/\\\\${mint}\\\\`'
    if old2 in content:
        content = content.replace(old2, 'fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`')
        print('OK Fixed double-escaped backticks')
    else:
        # Just show what's actually in the file around 'dexscreener'
        idx = content.find('dexscreener')
        if idx > -1:
            print('Context:', repr(content[idx-40:idx+80]))

with open(path, 'w') as f:
    f.write(content)
