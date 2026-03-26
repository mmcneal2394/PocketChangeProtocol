#!/usr/bin/env python3
"""Scan wallet using backup RPC and show orphan positions"""
import json, urllib.request

WALLET  = "DPx63B2v3fe6hQMUcXWCTfPy9HW6iZaZdH5FvjcztQ13"
RPC     = "https://nd-622-626-774.p2pify.com/89d5bb214e0ab0b5b25397cd9ca79d95"
WSOL    = "So11111111111111111111111111111111111111112"
SKIP    = {
    WSOL,
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
}

import json
from pathlib import Path
pos_data  = json.loads(Path("/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/sniper_positions.json").read_text())
blacklist = set(pos_data.get("blacklist", []))
tracked   = {p["mint"] for p in pos_data.get("positions", [])}

body = json.dumps({"jsonrpc":"2.0","id":1,"method":"getTokenAccountsByOwner","params":[
    WALLET,
    {"programId":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},
    {"encoding":"jsonParsed"}
]}).encode()
req = urllib.request.Request(RPC, data=body, headers={"Content-Type":"application/json"})
with urllib.request.urlopen(req, timeout=15) as r:
    d = json.loads(r.read())

accounts = d.get("result",{}).get("value",[])
nonzero = []
for a in accounts:
    info   = a["account"]["data"]["parsed"]["info"]
    mint   = info["mint"]
    ui_amt = float(info["tokenAmount"].get("uiAmount") or 0)
    raw    = int(info["tokenAmount"].get("amount") or 0)
    if mint in SKIP or ui_amt == 0 or raw == 0:
        continue
    status = "TRACKED" if mint in tracked else ("BLACKLISTED" if mint in blacklist else "ORPHAN")
    nonzero.append((mint, ui_amt, raw, status))

print(f"Non-zero token accounts: {len(nonzero)}")
for mint, ui, raw, st in nonzero:
    print(f"  [{st:>11}] {mint[:20]}...  tokens={ui:.4f}  raw={raw}")
