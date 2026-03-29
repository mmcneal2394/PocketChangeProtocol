"""
critic_agent.py — CriticAgent
LLM-powered structural proposal generator. Calls Gemini API with findings from
AnalyzerAgent + current strategy_params. Falls back to rule-based proposals if API unavailable.
Outputs structured proposals to proposals.json.
"""
from __future__ import annotations
import json
import os
import re
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

SIGNALS   = Path(__file__).parents[3] / "signals"
SWARM     = SIGNALS / "swarm"
FINDINGS  = SWARM / "findings.json"
STRATEGY  = SIGNALS / "strategy_params.json"
PROPOSALS = SWARM / "proposals.json"

# ── Load bot root .env so GEMINI_API_KEY is available ──────────────────────
try:
    from dotenv import load_dotenv as _load_dotenv
    _load_dotenv(Path(__file__).parents[3] / '.env', override=True)
except Exception: pass


# LLM config — uses GEMINI_API_KEY if available
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL   = "gemini-2.5-flash"
GEMINI_URL     = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

SYSTEM_PROMPT = """You are a quantitative trading bot optimization expert specializing in Solana memecoin momentum strategies.

You will receive:
1. Performance findings from the bot's live trade journal (structured JSON)
2. Current bot strategy parameters

Your job: Propose exactly 3 concrete, actionable parameter changes to improve win rate above 50% and profit factor above 1.2.

Rules:
- Each proposal must include specific parameter names and numeric values
- Cite the finding that motivates each proposal
- Be conservative — avoid changes >50% from current values
- Consider second-order effects (e.g., tighter filters = fewer trades = less diversification)

Output ONLY valid JSON in this exact format:
{
  "proposals": [
    {
      "rank": 1,
      "title": "Short title of change",
      "rationale": "1-2 sentence explanation citing specific finding",
      "param_changes": [
        {"param": "min_buy_ratio", "value": 3.0},
        {"param": "recency_gate_min", "value": 20}
      ],
      "expected_impact": "Estimated win rate improvement"
    }
  ]
}"""

def call_gemini(prompt: str, retries: int = 3) -> Optional[str]:
    if not GEMINI_API_KEY:
        return None
    import time
    for attempt in range(retries):
        try:
            import urllib.request
            import urllib.error
            body = json.dumps({
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.3, "maxOutputTokens": 1024},
            }).encode("utf-8")
            req = urllib.request.Request(
                f"{GEMINI_URL}?key={GEMINI_API_KEY}",
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=20) as resp:
                data = json.loads(resp.read())
                return data["candidates"][0]["content"]["parts"][0]["text"]
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait_time = (attempt + 1) * 3
                print(f"[CriticAgent] HTTP 429 Too Many Requests. Retrying in {wait_time}s...")
                time.sleep(wait_time)
            else:
                print(f"[CriticAgent] Gemini HTTPErr: {e}")
                return None
        except Exception as e:
            print(f"[CriticAgent] Gemini call failed: {e}")
            return None
    return None

def rule_based_proposals(findings: list[dict], params: dict) -> list[dict]:
    """Fallback: convert HIGH-severity findings directly into proposals."""
    proposals = []
    rank = 1
    for f in findings[:3]:
        sev = f.get("severity", "MEDIUM")
        cat = f.get("category", "")
        sug = f.get("suggestion", "")
        data = f.get("data", {})

        changes = []
        if cat == "exit_timing" and data.get("time_exit_pct", 0) > 30:
            changes = [{"param": "recency_gate_min", "value": 15}]
        elif cat == "entry_quality" and data.get("sl_pct", 0) > 40:
            changes = [
                {"param": "min_buy_ratio", "value": round(min(params.get("min_buy_ratio", 2.5) * 1.2, 4.0), 2)},
                {"param": "retrace_shield_s", "value": 120},
            ]
        elif cat == "win_rate" and data.get("win_rate", 0) < 40:
            changes = [
                {"param": "tp_pct", "value": round(min(params.get("tp_pct", 20) * 0.85, 20), 1)},
                {"param": "sl_pct", "value": round(max(params.get("sl_pct", 15) * 0.9, 7), 1)},
            ]
        elif cat == "entry_momentum":
            changes = [{"param": "min_price_chg_1h", "value": round(params.get("min_price_chg_1h", 20) + 5, 1)}]
        elif cat == "risk_reward":
            changes = [
                {"param": "tp_pct", "value": round(params.get("tp_pct", 20) * 1.15, 1)},
                {"param": "sl_pct", "value": round(params.get("sl_pct", 15) * 0.85, 1)},
            ]

        if changes:
            proposals.append({
                "rank":            rank,
                "title":           f.get("message", sug)[:60],
                "rationale":       f"{sev}: {sug}",
                "param_changes":   changes,
                "expected_impact": "rule-based heuristic",
            })
            rank += 1

    return proposals

def parse_llm_proposals(text: str) -> list[dict]:
    """Extract JSON from LLM response text."""
    try:
        m = re.search(r'\{[\s\S]*"proposals"[\s\S]*\}', text)
        if m:
            return json.loads(m.group(0)).get("proposals", [])
    except Exception:
        pass
    return []

def run() -> list[dict]:
    SWARM.mkdir(parents=True, exist_ok=True)

    findings_data = {}
    findings = []
    if FINDINGS.exists():
        findings_data = json.loads(FINDINGS.read_text(encoding="utf-8"))
        findings = findings_data.get("findings", [])

    params = {}
    if STRATEGY.exists():
        try:
            params = json.loads(STRATEGY.read_text(encoding="utf-8"))
        except Exception:
            pass

    proposals = []

    # Try LLM first
    if GEMINI_API_KEY and findings:
        user_prompt = (
            f"Findings:\n{json.dumps(findings, indent=2)}\n\n"
            f"Current params:\n{json.dumps(params, indent=2)}\n\n"
            "Propose 3 ranked improvements."
        )
        llm_resp = call_gemini(SYSTEM_PROMPT + "\n\n" + user_prompt)
        if llm_resp:
            proposals = parse_llm_proposals(llm_resp)
            print(f"[CriticAgent] LLM generated {len(proposals)} proposal(s)")

    # Fallback to rule-based
    if not proposals and findings:
        proposals = rule_based_proposals(findings, params)
        print(f"[CriticAgent] Rule-based fallback: {len(proposals)} proposal(s)")

    if not proposals:
        print("[CriticAgent] No findings to act on — no proposals generated")

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "llm_used": bool(GEMINI_API_KEY and proposals and len(proposals) > 0),
        "finding_count": len(findings),
        "proposals": proposals,
    }
    PROPOSALS.write_text(json.dumps(output, indent=2), encoding="utf-8")
    return proposals

if __name__ == "__main__":
    run()
