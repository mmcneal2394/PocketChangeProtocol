#!/usr/bin/env python3
"""Check backtest_results top fitness and diagnose why MemoryAgent keeps reading 0.952"""
import json
from pathlib import Path

BASE = Path("/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot")
BT   = BASE / "signals/swarm/backtest_results.json"
SP   = BASE / "signals/strategy_params.json"

sp_data = json.loads(SP.read_text())
print(f"strategy_params.json fitness_score = {sp_data.get('fitness_score')}")

bt_data = json.loads(BT.read_text())
results = bt_data.get("results", [])
print(f"backtest_results: {len(results)} candidates, trades_used={bt_data.get('trades_used')}")
for r in results[:5]:
    print(f"  fitness={r.get('fitness', '?'):.4f}  wr={r.get('win_rate','?')}%  hash={r.get('param_hash','?')}")

if results:
    best = results[0]
    cur  = sp_data.get("fitness_score", 0)
    print(f"\nbest={best.get('fitness',0):.4f}  current={cur:.4f}  ratio={best.get('fitness',0)/max(cur,0.001):.3f}x (need >1.10x to promote)")
    
    # Simulate MemoryAgent decision
    PROMOTE_THRESHOLD = 1.10
    if best.get("fitness", 0) > cur * PROMOTE_THRESHOLD:
        print("  → Would PROMOTE ✅")
    else:
        print(f"  → Would NOT promote (need fitness > {cur * PROMOTE_THRESHOLD:.4f})")
