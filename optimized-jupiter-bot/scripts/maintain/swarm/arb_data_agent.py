"""
arb_data_agent.py — ArbDataAgent
Reads arb_journal.jsonl and computes arb-specific metrics:
  - Net profit per attempt, success rate, fee drag, best/worst routes
  - EMA trends, time-of-day patterns
Writes signals/swarm/arb_report.json
"""
from __future__ import annotations
import json
import math
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict
from typing import Optional

BOT_ROOT   = Path(__file__).parents[3]
SIGNALS    = BOT_ROOT / "signals"
ARB_JOURNAL= SIGNALS / "arb_journal.jsonl"
SWARM      = SIGNALS / "swarm"
ARB_REPORT = SWARM / "arb_report.json"

def load_arb_journal() -> list[dict]:
    if not ARB_JOURNAL.exists():
        return []
    trades = []
    for line in ARB_JOURNAL.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            trades.append(json.loads(line))
        except Exception:
            pass
    return trades

def run() -> dict:
    SWARM.mkdir(parents=True, exist_ok=True)
    trades = load_arb_journal()

    if len(trades) < 3:
        print(f"[ArbDataAgent] Only {len(trades)} arb entries — need ≥3 to analyze")
        report = {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "total_attempts": len(trades),
            "ready": False,
        }
        ARB_REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
        return report

    now_ms   = datetime.now(timezone.utc).timestamp() * 1000
    ms_24h   = 24 * 3600 * 1000
    recent   = [t for t in trades if now_ms - t.get("ts", 0) < ms_24h]
    attempts = recent if recent else trades

    total     = len(attempts)
    successes = [t for t in attempts if t.get("success", False)]
    failures  = [t for t in attempts if not t.get("success", True)]

    success_rate = len(successes) / total * 100 if total else 0

    net_profits    = [t.get("netSol", 0) for t in attempts]
    gross_profits  = [t.get("grossSol", 0) for t in attempts]
    fees           = [t.get("feeSol", 0) for t in attempts]
    latencies      = [t.get("latency_ms", 0) for t in attempts if t.get("latency_ms")]

    avg_net    = sum(net_profits) / total if total else 0
    avg_gross  = sum(gross_profits) / total if total else 0
    avg_fee    = sum(fees) / total if total else 0
    total_net  = sum(net_profits)
    fee_drag_pct= (avg_fee / avg_gross * 100) if avg_gross > 0 else 0

    # Route breakdown
    route_stats: dict[str, dict] = defaultdict(lambda: {"attempts":0,"net_total":0.0,"wins":0})
    for t in attempts:
        route = t.get("route", "unknown")
        route_stats[route]["attempts"] += 1
        route_stats[route]["net_total"] += t.get("netSol", 0)
        if t.get("success"):
            route_stats[route]["wins"] += 1

    best_routes = sorted(
        [{"route": k, **v, "avg_net": v["net_total"]/v["attempts"]}
         for k, v in route_stats.items()],
        key=lambda x: x["avg_net"], reverse=True
    )[:5]

    # Spread distribution
    spreads = [t.get("spread_bps", 0) for t in attempts if t.get("spread_bps")]
    avg_spread = sum(spreads) / len(spreads) if spreads else 0

    # Profitable threshold
    profitable = [t for t in attempts if t.get("netSol", 0) > 0]
    profitable_thresh_bps = (
        min(t.get("spread_bps", 0) for t in profitable)
        if profitable else None
    )

    report = {
        "generated_at":        datetime.now(timezone.utc).isoformat(),
        "ready":               True,
        "window_hours":        24,
        "total_attempts":      total,
        "success_count":       len(successes),
        "success_rate_pct":    round(success_rate, 2),
        "total_net_sol":       round(total_net, 6),
        "avg_net_sol":         round(avg_net, 8),
        "avg_gross_sol":       round(avg_gross, 8),
        "avg_fee_sol":         round(avg_fee, 8),
        "fee_drag_pct":        round(fee_drag_pct, 2),
        "avg_spread_bps":      round(avg_spread, 2),
        "profitable_threshold_bps": profitable_thresh_bps,
        "avg_latency_ms":      round(sum(latencies)/len(latencies), 1) if latencies else None,
        "best_routes":         best_routes[:3],
    }

    ARB_REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    sign = "+" if total_net >= 0 else ""
    print(f"[ArbDataAgent] {total} arb attempts | SR:{success_rate:.1f}% | Net:{sign}{total_net:.6f} SOL | FeeD:{fee_drag_pct:.1f}%")
    return report

if __name__ == "__main__":
    run()
