#!/usr/bin/env python3
"""Queue the found orphan for force-sell via the sniper"""
import json, time, urllib.request
from pathlib import Path

MINT    = "FQ8T5dNMZzRLhrjih6H4UPLX9bFf8QJ7RQ5W5VxdEaB"  # from wallet scan
RAW     = 8653971450
RPC     = "https://nd-622-626-774.p2pify.com/89d5bb214e0ab0b5b25397cd9ca79d95"
JUP_API = "https://quote-api.jup.ag/v6"
WSOL    = "So11111111111111111111111111111111111111112"
BASE    = Path("/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot")
OUT     = BASE / "signals/force_sell.json"

print(f"Orphan: {MINT[:20]}...  raw={RAW}")

# Get Jupiter quote
url = f"{JUP_API}/quote?inputMint={MINT}&outputMint={WSOL}&amount={RAW}&slippageBps=500"
try:
    with urllib.request.urlopen(url, timeout=12) as r:
        q = json.loads(r.read())
    out_sol = int(q.get("outAmount", 0)) / 1e9
    print(f"Jupiter route: → {out_sol:.6f} SOL")
except Exception as e:
    print(f"Jupiter error: {e} — queuing anyway with est=0")
    out_sol = 0.0

force_sell = {
    "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "total_est_sol": out_sol,
    "count": 1,
    "sells": [{
        "mint":      MINT,
        "amount":    RAW,
        "uiAmt":     8653.9714,
        "estSolOut": out_sol,
        "reason":    "ORPHAN_SWEEP",
        "ts":        int(time.time() * 1000),
    }]
}

OUT.write_text(json.dumps(force_sell, indent=2))
print(f"Written: {OUT}")
print(f"Sniper will execute on next poll (~20s)")
print(f"Watch: tail -f /root/.pm2/logs/pcp-sniper-out.log | grep -i orphan")
