#!/usr/bin/env python3
"""
Force Orphan Sweep — finds real token balances in wallet, sells them NOW via Jupiter.
Runs independently of the sniper — uses the keypair directly.
"""
import json, os, time, urllib.request, base64, struct
from pathlib import Path

BASE     = Path("/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot")
ENV_FILE = BASE / ".env"
JOURNAL  = BASE / "signals/trade_journal.jsonl"

env = {}
for line in ENV_FILE.read_text().splitlines():
    if "=" in line and not line.startswith("#"):
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip().strip('"')

WALLET  = env.get("WALLET_PUBLIC_KEY", "")
RPC     = env.get("RPC_ENDPOINT", "https://api.mainnet-beta.solana.com")
JUP_API = "https://quote-api.jup.ag/v6"
WSOL    = "So11111111111111111111111111111111111111112"

SKIP = {
    WSOL,
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",  # USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",  # USDT
}

# Load blacklist from sniper_positions.json
POSITIONS_FILE = BASE / "signals/sniper_positions.json"
pos_data   = json.loads(POSITIONS_FILE.read_text()) if POSITIONS_FILE.exists() else {}
blacklist  = set(pos_data.get("blacklist", []))
positions  = pos_data.get("positions", [])
tracked    = {p["mint"] for p in positions}

def rpc(method, params):
    body = json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode()
    req  = urllib.request.Request(RPC, data=body, headers={"Content-Type":"application/json"})
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            return json.loads(r.read())
    except Exception as e:
        print(f"  RPC error: {e}")
        return {}

def jup(path):
    try:
        with urllib.request.urlopen(f"{JUP_API}{path}", timeout=12) as r:
            return json.loads(r.read())
    except Exception as e:
        return {}

print("=" * 55)
print(" ORPHAN SWEEP — LIVE WALLET SCAN")
print("=" * 55)
print(f" Wallet: {WALLET}")
print(f" Tracked positions: {len(tracked)}")
print(f" Blacklisted mints: {len(blacklist)}")
print()

# Get all SPL token balances
resp = rpc("getTokenAccountsByOwner", [
    WALLET,
    {"programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},
    {"encoding": "jsonParsed"}
])
accounts = resp.get("result", {}).get("value", [])

orphans = []
for acct in accounts:
    info    = acct["account"]["data"]["parsed"]["info"]
    mint    = info["mint"]
    amt_obj = info["tokenAmount"]
    ui_amt  = float(amt_obj.get("uiAmount") or 0)
    raw     = int(amt_obj.get("amount") or 0)

    if mint in SKIP or ui_amt == 0 or raw == 0:
        continue

    status = "TRACKED" if mint in tracked else ("BLACKLISTED" if mint in blacklist else "ORPHAN")
    orphans.append({
        "mint":    mint,
        "raw":     raw,
        "uiAmt":  ui_amt,
        "status":  status,
        "pubkey":  acct["pubkey"],
    })
    icon = "✅" if status == "TRACKED" else ("🚫" if status == "BLACKLISTED" else "❗")
    print(f" {icon} {mint[:16]}...  {ui_amt:.4f}  [{status}]")

print()
true_orphans = [o for o in orphans if o["status"] in ("ORPHAN", "BLACKLISTED")]
print(f" → Total non-zero tokens: {len(orphans)}")
print(f" → Need sweeping:         {len(true_orphans)}")
print()

if not true_orphans:
    print(" ✅ No orphans to sweep. Wallet is clean.")
    exit(0)

# Write force_sell.json for sniper to pick up
force_sells = []
total_est_sol = 0.0

for o in true_orphans:
    mint = o["mint"]
    raw  = o["raw"]
    ui   = o["uiAmt"]

    q = jup(f"/quote?inputMint={mint}&outputMint={WSOL}&amount={raw}&slippageBps=500&onlyDirectRoutes=false")
    if not q or not q.get("outAmount"):
        print(f" ⚠️  No route for {mint[:16]}... — skipping (dust)")
        continue

    out_sol = int(q["outAmount"]) / 1e9
    total_est_sol += out_sol
    print(f" 💱 {mint[:16]}...  {ui:.4f} tokens → ~{out_sol:.5f} SOL")
    force_sells.append({
        "mint":      mint,
        "amount":    raw,
        "uiAmt":     ui,
        "estSolOut": out_sol,
        "reason":    "ORPHAN_SWEEP",
        "ts":        int(time.time() * 1000),
    })

print()
print(f" Total estimated recovery: ~{total_est_sol:.5f} SOL")
print()

if force_sells:
    out_file = BASE / "signals/force_sell.json"
    out_file.write_text(json.dumps({
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "total_est_sol": total_est_sol,
        "count": len(force_sells),
        "sells": force_sells,
    }, indent=2))
    print(f" 📝 Written: signals/force_sell.json ({len(force_sells)} positions)")
    print(f" ⏳ Sniper will execute on next poll (~20s)")
    print(f" 📋 Check: tail -f /root/.pm2/logs/pcp-sniper-out.log | grep -i orphan")
else:
    print(" No routable orphans — nothing to write")

print("=" * 55)
