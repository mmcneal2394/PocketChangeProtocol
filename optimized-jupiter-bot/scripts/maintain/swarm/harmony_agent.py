"""
harmony_agent.py — HarmonyAgent
Cross-strategy capital allocation. Reads sniper analysis + arb report,
computes risk-adjusted return for each strategy, emits allocation.json
that all live agents read to scale their position sizes dynamically.
"""
from __future__ import annotations
import json
from pathlib import Path
from datetime import datetime, timezone

BOT_ROOT    = Path(__file__).parents[3]
SIGNALS     = BOT_ROOT / "signals"
SWARM       = SIGNALS / "swarm"
ARB_REPORT  = SWARM / "arb_report.json"
SNIPER_RPT  = SWARM / "analysis_report.json"
ALLOCATION  = SIGNALS / "allocation.json"

# Minimum weights to avoid starving any strategy
MIN_WEIGHT  = 0.10
MAX_WEIGHT  = 0.85

def load_json(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}

def compute_sharpe(avg_pnl: float, trades: int, win_rate: float) -> float:
    """Simplified Sharpe proxy: expected value / uncertainty."""
    if trades < 3:
        return 0.0
    expected = avg_pnl * (win_rate / 100)
    uncertainty = abs(avg_pnl) * (1 - win_rate / 100) + 1e-9
    return expected / uncertainty

def run() -> dict:
    SWARM.mkdir(parents=True, exist_ok=True)
    SIGNALS.mkdir(parents=True, exist_ok=True)

    sniper = load_json(SNIPER_RPT)
    arb    = load_json(ARB_REPORT)

    sniper_ready = sniper.get("total_trades", 0) >= 5
    arb_ready    = arb.get("ready", False) and arb.get("total_attempts", 0) >= 5

    # Default balanced allocation
    alloc = {
        "sniper_weight": 0.60,
        "pumpfun_weight": 0.25,
        "arb_weight": 0.15,
        "reason": "default — insufficient data",
    }

    if sniper_ready or arb_ready:
        # Compute a score for each strategy
        scores = {}

        if sniper_ready:
            s24 = sniper.get("last_24h", {})
            wr  = s24.get("win_rate", 0)
            pf  = s24.get("profit_factor", 0)
            n   = s24.get("total", 0)
            avg = s24.get("avg_pnl_sol", 0)
            scores["sniper"] = max(0.0, pf * (wr / 100) * min(1.0, n / 20))

        if arb_ready:
            wr  = arb.get("success_rate_pct", 0)
            net = arb.get("avg_net_sol", 0)
            n   = arb.get("total_attempts", 0)
            fee_drag = arb.get("fee_drag_pct", 100)
            arb_score = (net / 0.001) * (wr / 100) * max(0, 1 - fee_drag / 100) * min(1.0, n / 30)
            scores["arb"] = max(0.0, arb_score)

        total_score = sum(scores.values()) or 1.0

        if scores:
            sniper_w = scores.get("sniper", 0.0) / total_score
            arb_w    = scores.get("arb", 0.0) / total_score
            pf_w     = max(0.0, 1.0 - sniper_w - arb_w)

            # Clamp
            sniper_w = min(MAX_WEIGHT, max(MIN_WEIGHT, sniper_w))
            arb_w    = min(MAX_WEIGHT, max(MIN_WEIGHT, arb_w))
            pf_w     = min(MAX_WEIGHT, max(MIN_WEIGHT, pf_w))

            # Normalize to 1.0
            total_w  = sniper_w + arb_w + pf_w
            sniper_w = round(sniper_w / total_w, 3)
            arb_w    = round(arb_w    / total_w, 3)
            pf_w     = round(1.0 - sniper_w - arb_w, 3)

            reasons = []
            if sniper_w > 0.5: reasons.append(f"sniper outperforming (score:{scores.get('sniper',0):.3f})")
            if arb_w > 0.35:   reasons.append(f"arb profitable (score:{scores.get('arb',0):.3f})")
            if arb_w < 0.15:   reasons.append(f"arb underperforming — capital shifted to sniper")

            alloc = {
                "sniper_weight":  sniper_w,
                "pumpfun_weight": pf_w,
                "arb_weight":     arb_w,
                "scores":         {k: round(v, 4) for k, v in scores.items()},
                "reason":         "; ".join(reasons) or "balanced",
            }

    alloc["generated_at"] = datetime.now(timezone.utc).isoformat()
    ALLOCATION.write_text(json.dumps(alloc, indent=2), encoding="utf-8")

    print(f"[HarmonyAgent] Sniper:{alloc['sniper_weight']:.0%} PF:{alloc['pumpfun_weight']:.0%} Arb:{alloc['arb_weight']:.0%} — {alloc['reason'][:60]}")
    return alloc

if __name__ == "__main__":
    run()
