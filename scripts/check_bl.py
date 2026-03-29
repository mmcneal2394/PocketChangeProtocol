#!/usr/bin/env python3
import json

try:
    with open('/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/sniper_positions.json') as f:
        d = json.load(f)
        
    bl = d.get('blacklist', [])
    for b in bl:
        if b.startswith('CCPhx7t'):
            print("Found in blacklist:", b)
except Exception as e:
    print(f"Error reading positions: {e}")
