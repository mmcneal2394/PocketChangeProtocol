#!/usr/bin/env python3
"""Queue both orphan mints for force-sell"""
import json, time, urllib.request
from pathlib import Path

BASE   = Path("/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot")
RPC    = "https://nd-622-626-774.p2pify.com/89d5bb214e0ab0b5b25397cd9ca79d95"
JUP    = "https://quote-api.jup.ag/v6"
WSOL   = "So11111111111111111111111111111111111111112"
WALLET = "DPx63B2v3fe6hQMUcXWCTfPy9HW6iZaZdH5FvjcztQ13"

ORPHAN_MINTS = [
    "CvtGDRWUcPuQKbbFNdSbwa8ygvo21oKNHDXsomonji3J",
    "8b6EQrUjEeUZMhzu781rwX5KcsDJzKxoSK428EUmUHEp",
]

def rpc_call(method, params):
    body = json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode()
    req  = urllib.request.Request(RPC, data=body, headers={"Content-Type":"application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())

def jup_quote(mint, raw):
    try:
        url = f"{JUP}/quote?inputMint={mint}&outputMint={WSOL}&amount={raw}&slippageBps=800"
        with urllib.request.urlopen(url, timeout=12) as r:
            q = json.loads(r.read())
        return int(q.get("outAmount", 0)) / 1e9
    except Exception as e:
        print(f"  Jupiter error for {mint[:16]}: {e}")
        return 0.0

# Get all token account balances for wallet
print("Scanning wallet...")
resp = rpc_call("getTokenAccountsByOwner", [
    WALLET,
    {"programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},
    {"encoding": "jsonParsed"}
])
balances = {}
for a in resp.get("result", {}).get("value", []):
    info = a["account"]["data"]["parsed"]["info"]
    mint = info["mint"]
    raw  = int(info["tokenAmount"].get("amount", 0))
    ui   = float(info["tokenAmount"].get("uiAmount") or 0)
    if raw > 0:
        balances[mint] = {"raw": raw, "ui": ui}

print(f"Found {len(balances)} non-zero token accounts")

sells = []
total_est = 0.0
for mint in ORPHAN_MINTS:
    bal = balances.get(mint)
    if not bal:
        print(f"  {mint[:20]}... — NOT IN WALLET (already sold or wrong mint)")
        continue
    raw = bal["raw"]
    ui  = bal["ui"]
    print(f"  {mint[:20]}...  tokens={ui:.4f}  raw={raw}")
    est = jup_quote(mint, raw)
    print(f"    → est {est:.6f} SOL")
    total_est += est
    sells.append({
        "mint":      mint,
        "amount":    raw,
        "uiAmt":     ui,
        "estSolOut": est,
        "reason":    "ORPHAN_SWEEP",
        "ts":        int(time.time() * 1000),
    })

if not sells:
    print("Nothing to queue — mints not found in wallet")
else:
    out = BASE / "signals/force_sell.json"
    out.write_text(json.dumps({
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "total_est_sol": total_est,
        "count": len(sells),
        "sells": sells,
    }, indent=2))
    print(f"\nWritten force_sell.json ({len(sells)} positions, est ~{total_est:.5f} SOL)")
    print("Restart sniper now to pick up new code + execute sells")
