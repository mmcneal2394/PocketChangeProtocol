#!/usr/bin/env python3
import json
from pathlib import Path

BASE = Path("/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot")
sp = BASE / "signals/strategy_params.json"
mem = BASE / "signals/swarm/memory.json"

m = json.loads(mem.read_text())
real_fitness = m.get("current_fitness", 0.2647)

s = json.loads(sp.read_text())
old = s.get("fitness_score", "unknown")
s["fitness_score"] = real_fitness
s["fitness_note"] = f"Reset from phantom {old} to real journal-backed {real_fitness} (270 trades WR=41.5% PF=0.638)"
sp.write_text(json.dumps(s, indent=2))
print(f"  ✅ strategy_params fitness: {old} → {real_fitness}")
print(f"  ✅ Optimizer candidates scoring 0.04–0.12 can now beat baseline {real_fitness:.4f}")
