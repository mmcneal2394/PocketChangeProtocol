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

BOT_ROOT     = Path(__file__).resolve().parents[2]
SIGNALS      = BOT_ROOT / "signals"
SWARM        = SIGNALS / "swarm"
STRATEGY     = BOT_ROOT / "strategy_params.json"
STRATEGY_MIRROR = SIGNALS / "strategy_params.json"
BT_RESULTS   = SWARM / "backtest_results.json"
EXP_LOG      = SWARM / "experiment_log.jsonl"
HISTORY_LOG  = SWARM / "fitness_history.jsonl"  # cross-session longitudinal memory
SUMMARY      = SWARM / "swarm_summary.md"

PROMOTE_THRESHOLD = 1.10  # must be 10% better to promote
THIN_BASELINE_TRADES = 30
SAFETY_PROMOTION_MIN_TRADES = 30
SAFETY_PROMOTION_MIN_PROFIT_FACTOR = 1.75
SAFETY_PROMOTION_MIN_WIN_RATE = 50.0
SAFETY_PROMOTION_MIN_TOTAL_PNL_SOL = 0.05
SAFETY_PROMOTION_STALE_HOURS = 6

def try_float(value, default=0.0) -> float:
    try:
        return float(value)
    except Exception:
        return float(default)

def try_int(value, default=0) -> int:
    try:
        return int(value)
    except Exception:
        return int(default)

def read_filter_value(payload: dict, key: str, fallback=0.0) -> float:
    recommended_filters = payload.get("recommended_filters")
    if isinstance(recommended_filters, dict) and key in recommended_filters:
        return try_float(recommended_filters.get(key), fallback)
    return try_float(payload.get(key), fallback)

def is_stale_strategy(current: dict) -> bool:
    last_updated = current.get("last_updated")
    if not last_updated:
        return True
    try:
        ts = datetime.fromisoformat(str(last_updated).replace("Z", "+00:00"))
    except Exception:
        return True
    age_hours = (datetime.now(timezone.utc) - ts).total_seconds() / 3600
    return age_hours >= SAFETY_PROMOTION_STALE_HOURS

def should_safety_promote(current: dict, best: dict) -> tuple[bool, str]:
    current_trades = try_int(current.get("trades_sim", 0), 0)
    best_trades = try_int(best.get("trades_sim", 0), 0)
    if current_trades >= THIN_BASELINE_TRADES:
        return False, "baseline sample is already broad enough"
    if best_trades < max(SAFETY_PROMOTION_MIN_TRADES, current_trades + 5):
        return False, f"candidate sample {best_trades} is still too small"
    if try_float(best.get("total_pnl_sol", 0), 0) < SAFETY_PROMOTION_MIN_TOTAL_PNL_SOL:
        return False, "candidate PnL is not strong enough"
    if try_float(best.get("profit_factor", 0), 0) < SAFETY_PROMOTION_MIN_PROFIT_FACTOR:
        return False, "candidate profit factor is too weak"
    if try_float(best.get("win_rate", 0), 0) < SAFETY_PROMOTION_MIN_WIN_RATE:
        return False, "candidate win rate is too weak"

    current_min_5m = read_filter_value(current, "min_5m_change", 0)
    best_min_5m = read_filter_value(best, "min_5m_change", 0)
    current_min_liq = read_filter_value(current, "min_liquidity_usd", 0)
    best_min_liq = read_filter_value(best, "min_liquidity_usd", 0)
    if best_min_5m < current_min_5m or best_min_liq < current_min_liq:
        return False, "candidate is looser than the current baseline"
    if not is_stale_strategy(current):
        return False, "current baseline is too fresh for a safety override"
    return True, (
        f"thin stale baseline ({current_trades} trades) replaced by broader positive candidate "
        f"({best_trades} trades, PF {try_float(best.get('profit_factor', 0), 0):.2f}, "
        f"PnL {try_float(best.get('total_pnl_sol', 0), 0):+.4f} SOL)"
    )

def load_current_params() -> dict:
    for path in (STRATEGY, STRATEGY_MIRROR):
        if path.exists():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
    return {}

def write_strategy_params(payload: dict) -> None:
    for path in (STRATEGY, STRATEGY_MIRROR):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

def extract_promotable_fields(best: dict) -> dict:
    promoted = {}
    param_keys = [
        "min_buy_ratio", "min_price_chg_1h", "min_volume_1h", "min_buys_1h",
        "recency_gate_min", "trail_activate_pct", "trail_lock_pct",
        "tp_pct", "sl_pct", "retrace_shield_s",
    ]
    for key in param_keys:
        if key in best:
            promoted[key] = best[key]

    recommended_filters = best.get("recommended_filters")
    if isinstance(recommended_filters, dict) and recommended_filters:
        promoted["recommended_filters"] = recommended_filters
        for key in (
            "min_5m_change",
            "min_liquidity_usd",
            "min_volume_5m",
            "max_top10_holder_pct",
            "tp1_pct",
            "stop_loss_pct",
            "max_hold_minutes",
            "overbought_ceiling",
            "hunterModeMultiplier",
        ):
            if key in recommended_filters:
                promoted[key] = recommended_filters[key]

    return promoted

def summarize_current_strategy(current: dict) -> dict:
    recommended_filters = current.get("recommended_filters")
    if isinstance(recommended_filters, dict) and recommended_filters:
        return recommended_filters
    return {k: current.get(k) for k in [
        "min_buy_ratio","min_price_chg_1h","min_volume_1h","min_buys_1h",
        "recency_gate_min","trail_activate_pct","trail_lock_pct","tp_pct","sl_pct"
    ]}

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
    promotion_reason = ""
    normal_promotion = best_fitness > current_fitness * PROMOTE_THRESHOLD and best_fitness > 0
    safety_promotion, safety_reason = should_safety_promote(current, best)
    if normal_promotion or safety_promotion:
        # Build new strategy_params by merging best candidate into current
        new_params = dict(current)
        new_params.update(extract_promotable_fields(best))

        new_params["fitness_score"]  = best_fitness
        new_params["win_rate"]       = best.get("win_rate", 0)
        new_params["profit_factor"]  = best.get("profit_factor", 0)
        new_params["trades_sim"]     = best.get("trades_sim", 0)
        new_params["generation"]     = current.get("generation", 0) + 1
        new_params["last_updated"]   = datetime.now(timezone.utc).isoformat()
        new_params["source"]         = "optimizer_swarm" if normal_promotion else "optimizer_swarm_safety"
        new_params["param_hash"]     = best.get("param_hash", "")
        new_params["promotion_reason"] = "fitness_upgrade" if normal_promotion else safety_reason

        write_strategy_params(new_params)
        promoted = True
        promotion_reason = "fitness upgrade" if normal_promotion else safety_reason
        if normal_promotion:
            print(f"[MemoryAgent] ✅ PROMOTED {best.get('param_hash','?')} | "
                  f"fitness {current_fitness:.3f} → {best_fitness:.3f} "
                  f"(+{(best_fitness/max(current_fitness,0.001)-1)*100:.1f}%)")
        else:
            print(f"[MemoryAgent] ✅ SAFETY PROMOTED {best.get('param_hash','?')} | {safety_reason}")
    else:
        reason = safety_reason if current.get("trades_sim") and not normal_promotion and not safety_promotion else (
            f"fitness {best_fitness:.3f} not >{PROMOTE_THRESHOLD}x current {current_fitness:.3f}"
            if current_fitness > 0 else "current fitness = 0, no baseline"
        )
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
                "total_pnl_sol": r.get("total_pnl_sol", 0),
                "profit_seeking_ratio": r.get("profit_seeking_ratio", 0),
                "promoted":      promoted and r is best,
                "promotion_reason": promotion_reason if promoted and r is best else "",
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
        json.dumps(summarize_current_strategy(current), indent=2),
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
