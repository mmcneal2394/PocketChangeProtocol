"""
data_agent.py — DataAgent
Reads trade_journal.jsonl, computes performance metrics segmented by time window,
exit cause, entry momentum bucket. Writes analysis_report.json.
"""
from __future__ import annotations
import json
import os
import math
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict
from typing import Optional

SIGNALS = Path(__file__).parents[2] / "signals"
JOURNAL = SIGNALS / "trade_journal.jsonl"
SWARM   = SIGNALS / "swarm"
REPORT  = SWARM / "analysis_report.json"

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
        except json.JSONDecodeError:
            pass
    return trades

def bucket_momentum(chg: Optional[float]) -> str:
    if chg is None:
        return "unknown"
    if chg < 20:
        return "<20%"
    if chg < 50:
        return "20-50%"
    if chg < 100:
        return "50-100%"
    return ">100%"

def analyze(trades: list[dict], window_name: str, since_ms: Optional[int] = None) -> dict:
    sells = [t for t in trades if t.get("action") == "SELL"]
    if since_ms:
        sells = [t for t in sells if t.get("ts", 0) >= since_ms]

    if not sells:
        return {"window": window_name, "trades": 0}

    wins   = [t for t in sells if (t.get("pnlSol") or 0) > 0]
    losses = [t for t in sells if (t.get("pnlSol") or 0) <= 0]

    # Exit cause breakdown
    exit_causes: dict[str, int] = defaultdict(int)
    for t in sells:
        reason = t.get("reason", "")
        if reason.startswith("TP"):
            exit_causes["TP"] += 1
        elif reason.startswith("TRAIL"):
            exit_causes["TRAIL"] += 1
        elif reason.startswith("SL"):
            exit_causes["SL"] += 1
        elif reason.startswith("TIME"):
            exit_causes["TIME"] += 1
        else:
            exit_causes["OTHER"] += 1

    total = len(sells)
    exit_pct = {k: round(v / total * 100, 1) for k, v in exit_causes.items()}

    # Hold time
    hold_times = [t.get("holdMs", 0) or 0 for t in sells]
    avg_hold_ms = sum(hold_times) / len(hold_times) if hold_times else 0

    # PnL by entry momentum bucket (uses taSig field or reason heuristic)
    momentum_perf: dict[str, list[float]] = defaultdict(list)
    for t in sells:
        # Extract entry momentum from reason field if present
        reason = t.get("reason", "")
        chg = None
        if "+%" in reason or "/1h" in reason:
            try:
                import re
                m = re.search(r"\+(\d+(?:\.\d+)?)%/1h", reason)
                if m:
                    chg = float(m.group(1))
            except Exception:
                pass
        bucket = bucket_momentum(chg)
        momentum_perf[bucket].append(t.get("pnlSol") or 0)

    momentum_win_rates = {}
    for bucket, pnls in momentum_perf.items():
        if pnls:
            momentum_win_rates[bucket] = {
                "trades": len(pnls),
                "win_rate": round(sum(1 for p in pnls if p > 0) / len(pnls) * 100, 1),
                "avg_pnl": round(sum(pnls) / len(pnls), 6),
            }

    total_pnl = sum((t.get("pnlSol") or 0) for t in sells)
    win_pnl   = sum((t.get("pnlSol") or 0) for t in wins) if wins else 0
    loss_pnl  = abs(sum((t.get("pnlSol") or 0) for t in losses)) if losses else 0
    profit_factor = round(win_pnl / loss_pnl, 3) if loss_pnl > 0 else float("inf")

    return {
        "window":         window_name,
        "trades":         total,
        "wins":           len(wins),
        "losses":         len(losses),
        "win_rate_pct":   round(len(wins) / total * 100, 1),
        "total_pnl_sol":  round(total_pnl, 6),
        "profit_factor":  profit_factor,
        "avg_hold_min":   round(avg_hold_ms / 60000, 1),
        "exit_causes":    exit_causes,
        "exit_pct":       exit_pct,
        "momentum_perf":  momentum_win_rates,
    }

def run() -> dict:
    SWARM.mkdir(parents=True, exist_ok=True)
    trades = load_journal()

    now_ms  = int(datetime.now(timezone.utc).timestamp() * 1000)
    h1_ms   = now_ms - 3_600_000
    h24_ms  = now_ms - 86_400_000

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_journal_entries": len(trades),
        "all_time":  analyze(trades, "all_time"),
        "last_24h":  analyze(trades, "last_24h",  h24_ms),
        "last_1h":   analyze(trades, "last_1h",   h1_ms),
    }

    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"[DataAgent] Report written | journal={len(trades)} trades | "
          f"last_24h W:{report['last_24h'].get('wins',0)} L:{report['last_24h'].get('losses',0)} "
          f"WR:{report['last_24h'].get('win_rate_pct','n/a')}%")
    return report

if __name__ == "__main__":
    run()
