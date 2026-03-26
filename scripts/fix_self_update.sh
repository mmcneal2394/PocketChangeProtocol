#!/bin/bash
# Fix all 3 breaks in the self-update loop
# Break 1: proposals.json uses 'param_changes[{param,value}]' not 'parameter' & 'suggested_value'
# Break 2: memory.json current_fitness=-1.0 / empty baseline → never sees improvement
# Break 3: auto_apply_agent SNIPER_MAX_HOLD safe max = 3600000ms (60min!) — must be 600000 (10min)

BASE=/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot
SWARM=$BASE/scripts/maintain/swarm
SIGNALS=$BASE/signals

echo "=== PCP SELF-UPDATE LOOP FIX ==="

# ── Fix 1: auto_apply_agent.py ────────────────────────────────────────────────
# Fix SNIPER_MAX_HOLD safe max (60min → 10min)
echo ""
echo "-- Fix 1: Clamp SNIPER_MAX_HOLD safe max in auto_apply_agent.py --"
sed -i 's/"SNIPER_MAX_HOLD": (300000, 3600000, int)/"SNIPER_MAX_HOLD": (60000, 600000, int)/' $SWARM/auto_apply_agent.py
grep 'SNIPER_MAX_HOLD' $SWARM/auto_apply_agent.py

# Fix param key mismatch: proposals use 'param_changes[{param,value}]'
# auto_apply reads prop.get("parameter") and prop.get("suggested_value")
# Patch the run() function to also handle 'param_changes' format
echo ""
echo "-- Fix 2: Patch proposal key parsing to handle both formats --"
python3 << 'PYEOF'
import re
path = "/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/swarm/auto_apply_agent.py"
with open(path, 'r') as f:
    content = f.read()

# Find the proposals loop and add param_changes handling
old_loop = '''    for prop in proposals:
        # Only apply HIGH priority proposals automatically
        priority  = (prop.get("priority") or prop.get("severity") or "").upper()
        param_raw = prop.get("parameter") or prop.get("param") or ""
        value_raw = prop.get("suggested_value") or prop.get("value")
        rationale = prop.get("rationale", "")[:120]'''

new_loop = '''    # Flatten param_changes format: [{param, value}] → individual entries
    flat_proposals = []
    for prop in proposals:
        pchanges = prop.get("param_changes", [])
        if pchanges:
            for pc in pchanges:
                flat_proposals.append({
                    "priority":        prop.get("priority", "HIGH"),
                    "parameter":       pc.get("param", ""),
                    "suggested_value": pc.get("value"),
                    "rationale":       prop.get("rationale", prop.get("title", ""))[:120],
                })
        else:
            flat_proposals.append(prop)

    for prop in flat_proposals:
        # Only apply HIGH priority proposals automatically
        priority  = (prop.get("priority") or prop.get("severity") or "HIGH").upper()
        param_raw = prop.get("parameter") or prop.get("param") or ""
        value_raw = prop.get("suggested_value") or prop.get("value")
        rationale = prop.get("rationale", "")[:120]'''

if old_loop in content:
    content = content.replace(old_loop, new_loop)
    with open(path, 'w') as f:
        f.write(content)
    print("  ✅ Patched param_changes flattening into auto_apply_agent.py")
else:
    print("  ⚠️  Could not find loop target — may already be patched or format changed")
PYEOF

# ── Fix 3: memory_agent.py — seed baseline from trade journal on first run ───
echo ""
echo "-- Fix 3: Seed memory.json baseline from trade journal --"
python3 << 'PYEOF'
import json
from pathlib import Path

SIGNALS = Path("/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals")
SWARM   = SIGNALS / "swarm"
MEM     = SWARM / "memory.json"
JOURNAL = SIGNALS / "trade_journal.jsonl"

mem = {}
try:
    mem = json.loads(MEM.read_text()) if MEM.exists() else {}
except:
    pass

# Only seed if baseline is empty/negative
cur_fit = float(mem.get("current_fitness", -1.0))
if cur_fit < 0:
    # Compute real fitness from trade journal
    sells = []
    if JOURNAL.exists():
        for line in JOURNAL.read_text().splitlines():
            try:
                trade = json.loads(line)
                if trade.get("action") == "SELL" and "pnlSol" in trade:
                    sells.append(trade)
            except:
                pass
    
    if len(sells) >= 20:
        wins   = [t for t in sells if t["pnlSol"] >= 0]
        losses = [t for t in sells if t["pnlSol"] < 0]
        wr     = len(wins) / len(sells)
        gross_w = sum(t["pnlSol"] for t in wins)
        gross_l = abs(sum(t["pnlSol"] for t in losses)) or 0.0001
        pf      = gross_w / gross_l
        # fitness = win_rate * profit_factor (standard formula)
        fitness = wr * pf
        
        # Also extract current params from .env
        env_path = Path("/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/.env")
        env_params = {}
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                if line.startswith("SNIPER_"):
                    k, _, v = line.partition("=")
                    env_params[k.strip()] = v.strip()
        
        mem["current_fitness"] = round(fitness, 4)
        mem["current_params"]  = env_params
        mem["promoted"]        = False
        mem["seeded_from"]     = f"{len(sells)} journal trades"
        mem["win_rate"]        = round(wr * 100, 1)
        mem["profit_factor"]   = round(pf, 3)
        
        MEM.write_text(json.dumps(mem, indent=2))
        print(f"  ✅ Seeded memory.json: fitness={fitness:.4f} WR={wr*100:.1f}% PF={pf:.3f} ({len(sells)} trades)")
    else:
        print(f"  ⚠️  Only {len(sells)} trades in journal — need ≥20 to seed baseline")
else:
    print(f"  ✓  memory.json already has fitness={cur_fit} — no seed needed")
PYEOF

# ── Fix 4: Update proposals.json with correct format ─────────────────────────
echo ""
echo "-- Fix 4: Rewrite proposals.json to use correct {parameter,suggested_value} format --"
python3 << 'PYEOF'
import json
from pathlib import Path

SWARM = Path("/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/swarm")
P = SWARM / "proposals.json"
if not P.exists():
    print("  ⚠️  proposals.json not found")
else:
    data = json.loads(P.read_text())
    props = data.get("proposals", [])
    fixed = []
    for prop in props:
        pchanges = prop.get("param_changes", [])
        if pchanges:
            for pc in pchanges:
                fixed.append({
                    "priority":        "HIGH",
                    "parameter":       pc.get("param", ""),
                    "suggested_value": pc.get("value"),
                    "rationale":       prop.get("rationale", prop.get("title", ""))[:120],
                })
        else:
            fixed.append(prop)
    data["proposals"] = fixed
    P.write_text(json.dumps(data, indent=2))
    print(f"  ✅ proposals.json normalized: {len(fixed)} proposals ready")
    for p in fixed:
        print(f"     {p.get('parameter')} = {p.get('suggested_value')}  [{p.get('priority')}]")
PYEOF

# ── Verify the full loop ──────────────────────────────────────────────────────
echo ""
echo "-- Verify self-update loop integrity --"
echo ""
echo "  memory.json fitness baseline:"
python3 -c "import json; m=json.load(open('/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/swarm/memory.json')); print(f'  fitness={m.get(\"current_fitness\")} promoted={m.get(\"promoted\")} WR={m.get(\"win_rate\")}% PF={m.get(\"profit_factor\")}')" 2>/dev/null

echo ""
echo "  proposals.json:"
python3 -c "import json; p=json.load(open('/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/swarm/proposals.json')); [print(f'  [{x.get(\"priority\")}] {x.get(\"parameter\")}={x.get(\"suggested_value\")}') for x in p.get('proposals',[])]" 2>/dev/null

echo ""
echo "  SNIPER_MAX_HOLD bounds in auto_apply_agent.py:"
grep 'SNIPER_MAX_HOLD' $SWARM/auto_apply_agent.py

echo ""
echo "=== DONE — Restarting optimizer to pick up changes ==="
pm2 restart pcp-optimizer 2>&1 | grep optimizer | tail -1
