#!/usr/bin/env python3
import json
from pathlib import Path
p = Path('/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/sniper_positions.json')
d = json.loads(p.read_text())
mint = 'FQ8T5dNMZzRLhrjih6H4UPLX9bFf8QJ7RQ5W5VxdEaB'
if mint not in d['blacklist']:
    d['blacklist'].append(mint)
    p.write_text(json.dumps(d, indent=2))
    print(f'Blacklisted {mint[:16]}... (no Jupiter route, unroutable dust)')
else:
    print('Already in blacklist')
