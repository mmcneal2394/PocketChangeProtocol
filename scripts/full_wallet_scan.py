#!/usr/bin/env python3
"""Full wallet scan including Token-2022 program"""
import json, urllib.request
from pathlib import Path

RPC    = "https://nd-622-626-774.p2pify.com/89d5bb214e0ab0b5b25397cd9ca79d95"
WALLET = "DPx63B2v3fe6hQMUcXWCTfPy9HW6iZaZdH5FvjcztQ13"
WSOL   = "So11111111111111111111111111111111111111112"
SKIP   = {WSOL, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"}

TARGET_MINTS = {
    "CvtGDRWUcPuQKbbFNdSbwa8ygvo21oKNHDXsomonji3J",
    "8b6EQrUjEeUZMhzu781rwX5KcsDJzKxoSK428EUmUHEp",
    "FQ8T5dNMZzRLhrjih6H4UPLX9bFf8QJ7RQ5W5VxdEaB",
}

PROGRAMS = [
    ("SPL Token",    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    ("Token-2022",   "TokenzQdBNbLqP5VgrXfHWpEkaHpewngN5HEf1UdHqV"),
]

def rpc(method, params):
    body = json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode()
    req  = urllib.request.Request(RPC, data=body, headers={"Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f"  RPC error: {e}")
        return {}

pos_data  = json.loads(Path("/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/sniper_positions.json").read_text())
blacklist = set(pos_data.get("blacklist", []))
tracked   = {p["mint"] for p in pos_data.get("positions", [])}

all_tokens = {}
for prog_name, prog_id in PROGRAMS:
    resp = rpc("getTokenAccountsByOwner", [WALLET, {"programId": prog_id}, {"encoding": "jsonParsed"}])
    accounts = resp.get("result", {}).get("value", [])
    for a in accounts:
        try:
            info   = a["account"]["data"]["parsed"]["info"]
            mint   = info["mint"]
            raw    = int(info["tokenAmount"].get("amount", 0))
            ui_amt = float(info["tokenAmount"].get("uiAmount") or 0)
            if raw > 0:
                all_tokens[mint] = {"raw": raw, "ui": ui_amt, "prog": prog_name}
        except:
            pass

print(f"Total non-zero token accounts: {len(all_tokens)}")
print()
for mint, bal in all_tokens.items():
    if mint in SKIP:
        continue
    flag = ""
    if mint in TARGET_MINTS: flag = " <<< TARGET ORPHAN"
    elif mint in tracked:    flag = " [TRACKED]"
    elif mint in blacklist:  flag = " [BLACKLISTED]"
    else:                    flag = " [UNKNOWN ORPHAN]"
    print(f"  {mint[:24]}...  {bal['ui']:.4f}  raw={bal['raw']}  [{bal['prog']}]{flag}")
