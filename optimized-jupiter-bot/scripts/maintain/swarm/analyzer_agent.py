"""
analyzer_agent.py — AnalyzerAgent
Reads analysis_report.json + raw journal, detects patterns, emits structured findings.
New: TIME exit freshness analysis using tokenAgeSec and momentum5m from enriched journal.
"""
from __future__ import annotations
import json
from pathlib import Path
from datetime import datetime, timezone

SIGNALS  = Path(__file__).parents[3] / "signals"
SWARM    = SIGNALS / "swarm"
REPORT   = SWARM / "analysis_report.json"
FINDINGS = SWARM / "findings.json"
JOURNAL  = SIGNALS / "trade_journal.jsonl"

SEVERITY = {"HIGH": 3, "MEDIUM": 2, "LOW": 1}

def finding(severity: str, category: str, message: str, suggestion: str, data: dict = {}) -> dict:
    return {"severity": severity, "category": category, "message": message,
            "suggestion": suggestion, "data": data}

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

def run() -> list[dict]:
    SWARM.mkdir(parents=True, exist_ok=True)

    if not REPORT.exists():
        print("[AnalyzerAgent] No report found — run DataAgent first")
        return []

    report = json.loads(REPORT.read_text(encoding="utf-8"))
    findings_list = []

    for window_key in ("last_24h", "all_time"):
        w = report.get(window_key, {})
        if w.get("trades", 0) >= 5:
            break
    else:
        print("[AnalyzerAgent] Not enough trades to analyze")
        return []

    total    = w.get("trades", 0)
    win_rate = w.get("win_rate_pct", 0)
    exit_pct = w.get("exit_pct", {})
    momentum = w.get("momentum_perf", {})
    pf       = w.get("profit_factor", 0)

    # ── Exit cause analysis ───────────────────────────────────────────────────
    time_pct  = exit_pct.get("TIME", 0)
    sl_pct    = exit_pct.get("SL", 0)

    if time_pct > 35:
        findings_list.append(finding(
            "HIGH", "exit_timing",
            f"TIME exits {time_pct}% — bot buying end of momentum",
            "Reduce MAX_TOKEN_AGE_MIN to <10min; require MIN_MOMENTUM_5M > 3%",
            {"time_exit_pct": time_pct}
        ))
    elif time_pct > 20:
        findings_list.append(finding(
            "MEDIUM", "exit_timing",
            f"TIME exits at {time_pct}% — trailing stop activating too late",
            "Lower trail_activate_pct from 5% to 3%",
            {"time_exit_pct": time_pct}
        ))

    if sl_pct > 50:
        findings_list.append(finding(
            "HIGH", "entry_quality",
            f"SL exits at {sl_pct}% — tokens reversing immediately after entry",
            "Raise MIN_BUY_RATIO to 4.0x, require positive 5m momentum at entry",
            {"sl_pct": sl_pct}
        ))
    elif sl_pct > 35:
        findings_list.append(finding(
            "MEDIUM", "entry_quality",
            f"SL exits at {sl_pct}% — moderate reversal risk on entry",
            "Increase RETRACE_SHIELD_MS to 120s",
            {"sl_pct": sl_pct}
        ))

    if win_rate < 30:
        findings_list.append(finding(
            "HIGH", "win_rate",
            f"Win rate at {win_rate}% — Kelly fraction near 0, expect capital erosion",
            "Reduce position size to MIN_BUY_SOL until win_rate > 40%",
            {"win_rate": win_rate, "kelly_implied": max(0, round(win_rate/100 - (1 - win_rate/100), 3))}
        ))
    elif win_rate < 45:
        findings_list.append(finding(
            "MEDIUM", "win_rate",
            f"Win rate at {win_rate}% — below break-even for current TP/SL ratio",
            "Increase TP threshold or add momentum confirmation at entry",
            {"win_rate": win_rate}
        ))
    elif win_rate > 55:
        findings_list.append(finding(
            "LOW", "win_rate",
            f"Win rate at {win_rate}% — consider sizing up via Kelly",
            "Raise BASE_BUY_PCT to 0.25",
            {"win_rate": win_rate}
        ))

    # ── Momentum bucket analysis ──────────────────────────────────────────────
    for bucket, stats in momentum.items():
        bwr = stats.get("win_rate", 0)
        bt  = stats.get("trades", 0)
        if bt >= 3:
            if bucket == ">100%" and bwr < 25:
                findings_list.append(finding(
                    "HIGH", "entry_momentum",
                    f"Entries on >100% 1h movers: {bwr}% WR ({bt} trades) — too late",
                    "Cap entry at <=80% 1h change",
                    {"bucket": bucket, "win_rate": bwr, "trades": bt}
                ))
            elif bucket == "<20%" and bwr > 50:
                findings_list.append(finding(
                    "LOW", "entry_momentum",
                    f"Lower momentum entries <20%/1h showing {bwr}% WR",
                    "Test MIN_PRICE_CHG_1H=15% in next cycle",
                    {"bucket": bucket, "win_rate": bwr}
                ))

    # ── Profit factor ─────────────────────────────────────────────────────────
    if pf < 0.8:
        findings_list.append(finding(
            "HIGH", "risk_reward",
            f"Profit factor {pf} — losing more on losses than wins",
            "Tighten SL or widen TP asymmetrically",
            {"profit_factor": pf}
        ))

    # ── TIME exit freshness analysis (uses enriched journal) ─────────────────
    journal = load_journal()
    sells   = {t["mint"]: t for t in journal if t.get("action") == "SELL" and "TIME" in (t.get("reason") or "")}
    buys    = {t["mint"]: t for t in journal if t.get("action") == "BUY"}

    stale_entries = []
    for mint, sell in sells.items():
        buy = buys.get(mint)
        if not buy:
            continue
        age_min = (buy.get("tokenAgeSec") or 0) / 60
        mom5m   = buy.get("momentum5m")
        if age_min > 10 or (mom5m is not None and mom5m < 2):
            stale_entries.append({
                "symbol": sell.get("symbol"),
                "age_min": round(age_min, 1),
                "mom5m":   round(mom5m, 1) if mom5m is not None else None,
                "reason":  sell.get("reason"),
            })

    if len(stale_entries) >= 2:
        avg_age = sum(e["age_min"] for e in stale_entries) / len(stale_entries)
        findings_list.append(finding(
            "HIGH", "freshness",
            f"{len(stale_entries)} TIME exits had stale entries (avg age {avg_age:.1f}min or neg 5m momentum)",
            "Lower MAX_TOKEN_AGE_MIN to 10min, raise MIN_MOMENTUM_5M to 3%",
            {"stale_count": len(stale_entries), "avg_age_min": round(avg_age, 1),
             "examples": stale_entries[:3]}
        ))
    elif len(stale_entries) == 1:
        findings_list.append(finding(
            "MEDIUM", "freshness",
            f"TIME exit on {stale_entries[0]['symbol']} at age {stale_entries[0]['age_min']}min — possible stale entry",
            "Tighten MAX_TOKEN_AGE_MIN if pattern persists",
            {"stale_entries": stale_entries}
        ))

    # ── Negative 5m momentum at BUY entries (falling knife detection) ─────────
    neg_mom_buys = [t for t in journal if t.get("action") == "BUY"
                    and t.get("momentum5m") is not None and t["momentum5m"] < 0]
    if len(neg_mom_buys) >= 2:
        findings_list.append(finding(
            "HIGH", "freshness",
            f"{len(neg_mom_buys)} BUY entries had negative 5m momentum — catching falling knives",
            "Enforce MIN_MOMENTUM_5M >= 2% strictly; consider raising to 5%",
            {"neg_5m_count": len(neg_mom_buys),
             "symbols": [t.get("symbol") for t in neg_mom_buys[:3]]}
        ))

    # Sort HIGH → LOW
    findings_list.sort(key=lambda f: SEVERITY.get(f["severity"], 0), reverse=True)

    output = {
        "generated_at":    datetime.now(timezone.utc).isoformat(),
        "window_used":     window_key,
        "trades_analyzed": total,
        "finding_count":   len(findings_list),
        "findings":        findings_list,
    }
    FINDINGS.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(f"[AnalyzerAgent] {len(findings_list)} finding(s) | "
          f"HIGH:{sum(1 for f in findings_list if f['severity']=='HIGH')} "
          f"MEDIUM:{sum(1 for f in findings_list if f['severity']=='MEDIUM')} "
          f"LOW:{sum(1 for f in findings_list if f['severity']=='LOW')}")
    return findings_list

if __name__ == "__main__":
    run()
