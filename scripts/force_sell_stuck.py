#!/usr/bin/env python3
import json
import time
import urllib.request
from pathlib import Path

MINT = 'CCPhx7tUrr7b54Y8ugCAsqrYJbeFVRcp39naNfgDpump'
RAW = 20193421996
OUT = Path('/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/force_sell.json')
url = f'https://quote-api.jup.ag/v6/quote?inputMint={MINT}&outputMint=So11111111111111111111111111111111111111112&amount={RAW}&slippageBps=800'

try:
    with urllib.request.urlopen(url, timeout=12) as r:
        q = json.loads(r.read())
    out_sol = int(q.get('outAmount', 0)) / 1e9
except Exception as e:
    out_sol = 0.0

force_sell = {
    'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'total_est_sol': out_sol,
    'count': 1,
    'sells': [{
        'mint': MINT,
        'amount': RAW,
        'uiAmt': 20193.42,
        'estSolOut': out_sol,
        'reason': 'ORPHAN_SWEEP',
        'ts': int(time.time() * 1000),
    }]
}
OUT.write_text(json.dumps(force_sell, indent=2))
print('Queued force_sell.json for ' + MINT)
