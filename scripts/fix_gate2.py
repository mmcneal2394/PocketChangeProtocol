#!/usr/bin/env python3
"""
Fix auto_apply_agent.py Gate 2:
Replace simulation-history champion baseline with real live fitness from strategy_params.json
The old approach compared against experiment_log.jsonl champion_fitness=0.952 (Achieved in simulation
on 2026-03-25 with a different dataset). This caused the optimizer to never promote improvements
against a phantom baseline. Now uses the live journal-backed fitness as the comparison point.
"""
from pathlib import Path

PATH = Path("/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/swarm/auto_apply_agent.py")
content = PATH.read_text()

OLD = '''    # Gate 2: fitness must have improved by >10% vs longitudinal history
    # Reads fitness_history.jsonl (cross-session) rather than in-session history[]
    # so session resets don't break the comparison baseline.
    current_fitness = mem.get("current_fitness", -999)
    HISTORY_LOG = SWARM / "fitness_history.jsonl"
    MIN_IMPROVEMENT = 0.10

    prev_fitness = -1.0  # fallback if no history yet
    if HISTORY_LOG.exists():
        hist_lines = [l for l in HISTORY_LOG.read_text().split("\\n") if l.strip()]
        if len(hist_lines) >= 2:
            # Use the rolling champion from the last recorded cycle as baseline
            recent = [json.loads(l) for l in hist_lines[-10:]]  # look back 10 cycles
            champion_vals = [e.get("champion_fitness", -1.0) for e in recent if e.get("champion_fitness") is not None]
            prev_fitness = max(champion_vals) if champion_vals else -1.0

    improvement = current_fitness - prev_fitness
    if improvement < MIN_IMPROVEMENT:
        result["skipped_reason"] = f"Fitness improvement {improvement:.3f} < {MIN_IMPROVEMENT} (cross-session champion: {prev_fitness:.3f})"'''

NEW = '''    # Gate 2: fitness must have improved vs LIVE baseline in strategy_params.json
    # Using strategy_params.json (journal-backed real fitness) not simulation history.
    # Simulation champion scores (0.95+) were achieved on different datasets and
    # created a phantom baseline that blocked all real improvements.
    current_fitness = mem.get("current_fitness", -999)
    MIN_IMPROVEMENT = 0.10

    # Live baseline: read from strategy_params.json (written by MemoryAgent on promotions,
    # or seeded from trade journal). This reflects ACTUAL live performance.
    strategy_params = _read_json(SIGNALS / "strategy_params.json")
    prev_fitness = float(strategy_params.get("fitness_score", 0.0))

    # Safety: if prev_fitness is suspiciously high (>0.5) and we have <50 live trades,
    # treat it as potentially from simulation and discount it
    journal_path = SIGNALS / "trade_journal.jsonl"
    live_trades  = sum(1 for l in journal_path.read_text().splitlines() if '"action":"SELL"' in l) if journal_path.exists() else 0
    if prev_fitness > 0.5 and live_trades < 50:
        print(f"  [AutoApply] ⚠️  Baseline {prev_fitness:.3f} may be simulation — discounting (only {live_trades} live trades)")
        prev_fitness = min(prev_fitness, 0.3)

    improvement = current_fitness - prev_fitness
    if improvement < MIN_IMPROVEMENT:
        result["skipped_reason"] = f"Fitness improvement {improvement:.3f} < {MIN_IMPROVEMENT} (live baseline: {prev_fitness:.3f}, {live_trades} trades)"'''

if OLD in content:
    content = content.replace(OLD, NEW)
    PATH.write_text(content)
    print("✅ Gate 2 patched — now uses live strategy_params.json baseline")
    print("   Phantom simulation baseline (0.952) is permanently removed")
else:
    print("⚠️  Could not find Gate 2 block — check if already patched")
    # Show what's there
    for i, line in enumerate(content.split('\n')):
        if 'Gate 2' in line or 'prev_fitness' in line or 'champion' in line:
            print(f"  L{i+1}: {line}")
