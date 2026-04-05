import json, time

d = json.load(open('/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/sniper_positions.json'))
s = d['stats']
p = s.get('pausedUntil', 0)
now = time.time() * 1000
remain = max(0, int((p - now) / 60000))
print(f"Paused: {p > now}")
print(f"Remaining: {remain} min")
print(f"Consecutive losses: {s.get('consecutiveLosses', 0)}")

# Clear the pause
d['stats']['pausedUntil'] = 0
d['stats']['consecutiveLosses'] = 0
json.dump(d, open('/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/sniper_positions.json', 'w'), indent=2)
print("Cleared pause — trading enabled")
