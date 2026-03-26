"""
backtester_agent.py — BacktesterAgent
Replays trade_journal.jsonl against each candidate param set.
Simulates: would this entry have passed candidate filters? Then re-applies exit rules.
Returns fitness = win_rate * profit_factor - drawdown_penalty.
"""
from __future__ import annotations
import json
import re
import math
from pathlib import Path
from datetime import datetime, timezone

SIGNALS   = Path(__file__).parents[2] / "signals"
SWARM     = SIGNALS / "swarm"
JOURNAL   = SIGNALS / "trade_journal.jsonl"
CANDIDATES= SWARM / "candidate_params.json"
BT_RESULTS= SWARM / "backtest_results.json"

def load_journal() -> list[dict]:
    if not JOURNAL.exists():
        return []
    trades = []
    for line in JOURNAL.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            trades.append(json.loads(line))
        except Exception:
            pass
    return trades

def extract_entry_meta(buy: dict) -> dict:
    """Extract entry metadata from BUY journal record."""
    reason = buy.get("reason", "")
    meta   = {}

    # e.g., "+16%/1h | 524B/291S (1.8x) | $32.9k vol"
    m = re.search(r"\+(\d+(?:\.\d+)?)%/1h", reason)
    if m:
        meta["price_chg_1h"] = float(m.group(1))

    m = re.search(r"(\d+)B/(\d+)S\s+\(([\d.]+)x\)", reason)
    if m:
        meta["buys_1h"]    = int(m.group(1))
        meta["sells_1h"]   = int(m.group(2))
        meta["buy_ratio"]  = float(m.group(3))

    m = re.search(r"\$([\d.]+)k?\s*vol", reason)
    if m:
        raw = float(m.group(1))
        meta["volume_1h"] = raw * 1000 if "k" in reason[m.start():m.end()+5] else raw

    return meta

def passes_entry_filter(meta: dict, params: dict) -> bool:
    """Check if entry metadata satisfies candidate params."""
    if not meta:
        return True  # can't filter, keep it
    if "price_chg_1h" in meta and meta["price_chg_1h"] < params.get("min_price_chg_1h", 0):
        return False
    if "buy_ratio" in meta and meta["buy_ratio"] < params.get("min_buy_ratio", 0):
        return False
    if "buys_1h" in meta and meta["buys_1h"] < params.get("min_buys_1h", 0):
        return False
    if "volume_1h" in meta and meta["volume_1h"] < params.get("min_volume_1h", 0):
        return False
    return True

def simulate_exit(sell: dict, params: dict) -> dict:
    """Re-simulate exit under candidate params; return simulated outcome."""
    pnl_sol  = sell.get("pnlSol") or 0
    buy_sol  = sell.get("amountSol", 0.008)
    pnl_pct  = (pnl_sol / buy_sol * 100) if buy_sol > 0 else 0
    hold_ms  = sell.get("holdMs", 300_000)

    tp_pct   = params.get("tp_pct",  20.0)
    sl_pct   = params.get("sl_pct",  15.0)
    trail_act= params.get("trail_activate_pct", 5.0)
    trail_lock= params.get("trail_lock_pct", 0.55)

    # We only have the final pnl — simulate deterministically:
    # If actual exit was TP or TRAIL and we raise/lower TP, adjust outcome:
    reason = sell.get("reason", "")
    sim_pnl_pct = pnl_pct  # default: same outcome

    if reason.startswith("TIME"):
        # Under candidate params, time exits would still happen at same pnl
        # unless trailing stop would have caught earlier
        if pnl_pct > trail_act:
            sim_pnl_pct = pnl_pct * trail_lock  # locked in trail
        # else hold until same exit
    elif reason.startswith("SL"):
        # Under tighter SL, might have exited with smaller loss
        sim_sl = -sl_pct
        sim_pnl_pct = max(pnl_pct, sim_sl)  # best of actual or candidate SL
    elif reason.startswith("TP"):
        sim_pnl_pct = min(pnl_pct, tp_pct)  # capped at candidate TP

    sim_pnl_sol = buy_sol * sim_pnl_pct / 100
    return {
        "sim_pnl_pct": sim_pnl_pct,
        "sim_pnl_sol": sim_pnl_sol,
        "original_reason": reason,
    }

def score_candidate(candidate: dict, trades: list[dict]) -> dict:
    """Run full simulation for one candidate param set."""
    # Pair buys with sells
    buy_map: dict[str, dict]  = {}
    results: list[dict] = []

    for t in trades:
        mint = t.get("mint", "")
        if t.get("action") == "BUY":
            meta = extract_entry_meta(t)
            buy_map[mint] = {**t, "_meta": meta}
        elif t.get("action") == "SELL":
            buy = buy_map.get(mint)
            meta = buy.get("_meta", {}) if buy else {}

            # Check if this entry would have been taken
            if not passes_entry_filter(meta, candidate):
                continue  # would have been filtered out

            sim = simulate_exit(t, candidate)
            results.append({**t, **sim})

    if not results:
        return {"fitness": 0.0, "trades_sim": 0, "win_rate": 0, "profit_factor": 0}

    wins   = [r for r in results if r["sim_pnl_sol"] > 0]
    losses = [r for r in results if r["sim_pnl_sol"] <= 0]

    win_pnl  = sum(r["sim_pnl_sol"] for r in wins)
    loss_pnl = abs(sum(r["sim_pnl_sol"] for r in losses)) if losses else 0
    pf       = win_pnl / loss_pnl if loss_pnl > 0 else (2.0 if wins else 0.0)
    wr       = len(wins) / len(results)
    total_pnl= sum(r["sim_pnl_sol"] for r in results)

    # Running drawdown
    equity = 0.0
    peak   = 0.0
    max_dd = 0.0
    for r in results:
        equity += r["sim_pnl_sol"]
        if equity > peak:
            peak = equity
        dd = (peak - equity) / max(abs(peak), 0.001)
        if dd > max_dd:
            max_dd = dd

    fitness = round(wr * pf - max_dd * 0.3, 4)

    return {
        "fitness":       fitness,
        "trades_sim":    len(results),
        "win_rate":      round(wr * 100, 1),
        "profit_factor": round(pf, 3),
        "total_pnl_sol": round(total_pnl, 6),
        "max_drawdown":  round(max_dd * 100, 1),
    }

def run() -> list[dict]:
    SWARM.mkdir(parents=True, exist_ok=True)

    if not CANDIDATES.exists():
        print("[BacktesterAgent] No candidates found")
        return []

    cand_data  = json.loads(CANDIDATES.read_text(encoding="utf-8"))
    candidates = cand_data.get("candidates", [])
    trades     = load_journal()

    if len(trades) < 10:
        print(f"[BacktesterAgent] Only {len(trades)} journal entries — need ≥10 to backtest")
        return []

    scored = []
    for c in candidates:
        score = score_candidate(c, trades)
        scored.append({**c, **score})

    scored.sort(key=lambda x: x.get("fitness", 0), reverse=True)

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "trades_used":  len(trades),
        "results":      scored,
    }
    BT_RESULTS.write_text(json.dumps(output, indent=2), encoding="utf-8")

    best = scored[0] if scored else {}
    print(f"[BacktesterAgent] Scored {len(scored)} candidates | "
          f"best fitness={best.get('fitness',0)} WR={best.get('win_rate',0)}% "
          f"PF={best.get('profit_factor',0)}")
    return scored

if __name__ == "__main__":
    run()
