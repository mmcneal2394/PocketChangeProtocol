import json

f = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/sniper_positions.json'
data = json.load(open(f))

fixed = 0
for p in data['positions']:
    if p.get('symbol') == 'Solana':
        p['openedAt'] = 1  # force forceExit on next poll cycle
        fixed += 1
        print(f"Marked {p['symbol']} ({p['mint'][:12]}...) for force-exit")

open(f, 'w').write(json.dumps(data, indent=2))
print(f"Done. {fixed} position(s) marked for force-exit.")
