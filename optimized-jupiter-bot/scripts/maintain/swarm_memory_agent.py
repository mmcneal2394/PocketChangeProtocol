"""
memory_agent.py — MemoryAgent
Reads backtest_results.json, compares best candidate vs current strategy_params.json.
Promotes to production if >10% fitness improvement. Appends all experiments to experiment_log.jsonl.
Generates a running summary in swarm_summary.md.
"""
from __future__ import annotations
import json
from pathlib import Path
from datetime import datetime, timezone

SIGNALS      = Path(__file__).parents[3] / "signals"   # parents[3] = bot root from scripts/maintain/swarm/
SWARM        = SIGNALS / "swarm"
STRATEGY     = SIGNALS / "strategy_params.json"
BT_RESULTS   = SWARM / "backtest_results.json"
EXP_LOG      = SWARM / "experiment_log.jsonl"
HISTORY_LOG  = SWARM / "fitness_history.jsonl"  # cross-session longitudinal memory
SUMMARY      = SWARM / "swarm_summary.md"

PROMOTE_THRESHOLD = 1.10  # must be 10% better to promote

def load_current_params() -> dict:
    if STRATEGY.exists():
        try:
            return json.loads(STRATEGY.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}

def run() -> dict:
    SWARM.mkdir(parents=True, exist_ok=True)

    if not BT_RESULTS.exists():
        print("[MemoryAgent] No backtest results found")
        return {}

    bt = json.loads(BT_RESULTS.read_text(encoding="utf-8"))
    results = bt.get("results", [])
    if not results:
        print("[MemoryAgent] Empty backtest results")
        return {}

    current = load_current_params()
    current_fitness = float(current.get("fitness_score", 0.0))

    best = results[0]
    best_fitness = float(best.get("fitness", 0.0))

    promoted = False
    if best_fitness > current_fitness * PROMOTE_THRESHOLD and best_fitness > 0:
        # Build new strategy_params by merging best candidate into current
        new_params = dict(current)
        param_keys = [
            "min_buy_ratio", "min_price_chg_1h", "min_volume_1h", "min_buys_1h",
            "recency_gate_min", "trail_activate_pct", "trail_lock_pct",
            "tp_pct", "sl_pct", "retrace_shield_s",
        ]
        for k in param_keys:
            if k in best:
                new_params[k] = best[k]

        new_params["fitness_score"]  = best_fitness
        new_params["win_rate"]       = best.get("win_rate", 0)
        new_params["profit_factor"]  = best.get("profit_factor", 0)
        new_params["trades_sim"]     = best.get("trades_sim", 0)
        new_params["generation"]     = current.get("generation", 0) + 1
        new_params["last_updated"]   = datetime.now(timezone.utc).isoformat()
        new_params["source"]         = "optimizer_swarm"
        new_params["param_hash"]     = best.get("param_hash", "")

        STRATEGY.write_text(json.dumps(new_params, indent=2), encoding="utf-8")
        promoted = True
        print(f"[MemoryAgent] ✅ PROMOTED {best.get('param_hash','?')} | "
              f"fitness {current_fitness:.3f} → {best_fitness:.3f} "
              f"(+{(best_fitness/max(current_fitness,0.001)-1)*100:.1f}%)")
    else:
        reason = (f"fitness {best_fitness:.3f} not >{PROMOTE_THRESHOLD}x current {current_fitness:.3f}"
                  if current_fitness > 0 else "current fitness = 0, no baseline")
        print(f"[MemoryAgent] No promotion — {reason}")

    # Log all experiments to experiment_log.jsonl
    now = datetime.now(timezone.utc).isoformat()
    with EXP_LOG.open("a", encoding="utf-8") as f:
        for r in results:
            entry = {
                "ts":            now,
                "param_hash":    r.get("param_hash", ""),
                "fitness":       r.get("fitness", 0),
                "win_rate":      r.get("win_rate", 0),
                "profit_factor": r.get("profit_factor", 0),
                "trades_sim":    r.get("trades_sim", 0),
                "promoted":      promoted and r is best,
            }
            f.write(json.dumps(entry) + "\n")

    # Count experiments
    exp_count = 0
    if EXP_LOG.exists():
        exp_count = sum(1 for _ in EXP_LOG.read_text(encoding="utf-8").splitlines() if _.strip())

    # Update summary markdown
    lines = [
        f"# PCP Optimizer Swarm — Summary",
        f"",
        f"**Last run:** {now}",
        f"**Experiments logged:** {exp_count}",
        f"**Current fitness:** {current_fitness:.4f}  ",
        f"**Best this cycle:** {best_fitness:.4f}  ",
        f"**Promoted this cycle:** {'YES ✅' if promoted else 'No'}",
        f"",
        f"## Current Strategy Params (live)",
        f"```json",
        json.dumps({k: current.get(k) for k in [
            "min_buy_ratio","min_price_chg_1h","min_volume_1h","min_buys_1h",
            "recency_gate_min","trail_activate_pct","trail_lock_pct","tp_pct","sl_pct"
        ]}, indent=2),
        f"```",
        f"",
        f"## Top 5 Candidates This Cycle",
        f"| Rank | Hash | Fitness | Win% | PF | Trades |",
        f"|---|---|---|---|---|---|",
    ]
    for i, r in enumerate(results[:5]):
        lines.append(f"| {i+1} | `{r.get('param_hash','?')}` | {r.get('fitness',0):.4f} | "
                     f"{r.get('win_rate',0)}% | {r.get('profit_factor',0)} | {r.get('trades_sim',0)} |")

    SUMMARY.write_text("\n".join(lines) + "\n", encoding="utf-8")

    # Append to cross-session fitness history (survives memory.json resets)
    history_entry = {
        "ts":             now,
        "session":        "live",
        "cycle_best_fitness": best_fitness,
        "champion_fitness":   current_fitness,
        "promoted":       promoted,
        "win_rate":       best.get("win_rate", 0),
        "profit_factor":  best.get("profit_factor", 0),
        "trades_sim":     best.get("trades_sim", 0),
        "param_hash":     best.get("param_hash", ""),
    }
    with HISTORY_LOG.open("a", encoding="utf-8") as f:
        f.write(json.dumps(history_entry) + "\n")

    return {"promoted": promoted, "best_fitness": best_fitness, "experiments_total": exp_count}

if __name__ == "__main__":
    run()
