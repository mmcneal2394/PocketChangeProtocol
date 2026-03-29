#!/usr/bin/env python3
import json
d=json.load(open("/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/sniper_positions.json"))
for b in d.get("blacklist",[]):
    if b.startswith("CCPhx7t"):
        print(b)
