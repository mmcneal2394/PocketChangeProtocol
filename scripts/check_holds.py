#!/usr/bin/env python3
import json
import time

try:
    with open('/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/sniper_positions.json') as f:
        d = json.load(f)
        
    positions = d.get('positions', [])
    print(f"Total active positions: {len(positions)}")
    
    now = time.time() * 1000
    for p in positions:
        hold_ms = now - p.get('ts', now)
        is_stuck = hold_ms > 360000
        mint = p.get('mint', 'Unknown')
        print(f"Mint: {mint} | Held for: {hold_ms/1000/60:.1f} mins | {'STUCK' if is_stuck else 'OK'}")
        
    print("\nBlacklist count:", len(d.get('blacklist', [])))

except Exception as e:
    print(f"Error reading positions: {e}")
