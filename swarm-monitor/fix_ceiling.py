path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    code = f.read()

# Raise overbought ceiling from 30% to 150% for 5m
code = code.replace(
    "livePair.priceChange5m > 30)",
    "livePair.priceChange5m > 150)"
)
code = code.replace(
    "ceiling: 30%",
    "ceiling: 150%"
)

# Also raise 1h ceiling from 100% to 500%
code = code.replace(
    "livePair.priceChange1h > 100)",
    "livePair.priceChange1h > 500)"
)

# Also clear the pausedUntil so it can trade NOW
code_check = code.count("priceChange5m > 150")
print(f'5m ceiling raised to 150%: {code_check} occurrence(s)')
code_check2 = code.count("priceChange1h > 500")
print(f'1h ceiling raised to 500%: {code_check2} occurrence(s)')

with open(path, 'w') as f:
    f.write(code)

# Also clear the loss streak pause so trading starts immediately
import json
pos_path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/sniper_positions.json'
d = json.load(open(pos_path))
d['stats']['pausedUntil'] = 0
d['stats']['consecutiveLosses'] = 0
json.dump(d, open(pos_path, 'w'), indent=2)
print('Cleared loss streak pause — trading enabled NOW')
