"""
arb_critic_agent.py — ArbCriticAgent
Gemini 2.5 Flash powered arb parameter optimizer.
Reads arb_report.json, proposes changes to:
  MIN_PROFIT_BPS, MAX_SLIPPAGE_BPS, GAS_PRIORITY, route_pairs, attempt_interval_ms
Writes signals/swarm/arb_proposals.json
"""
from __future__ import annotations
import json, os, re, urllib.request
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

BOT_ROOT      = Path(__file__).parents[3]
ENV_FILE      = BOT_ROOT / ".env"
try:
    from dotenv import load_dotenv as _ld
    _ld(ENV_FILE, override=True)
except Exception:
    pass

SIGNALS       = BOT_ROOT / "signals"
SWARM         = SIGNALS / "swarm"
ARB_REPORT    = SWARM / "arb_report.json"
ARB_PROPOSALS = SWARM / "arb_proposals.json"

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL   = "gemini-2.5-flash"
GEMINI_URL     = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

ARB_SYSTEM_PROMPT = """You are an expert in Solana on-chain arbitrage optimization for Jupiter-based bots.

You will receive performance metrics from a live arb engine. Propose exactly 3 specific parameter changes.

Key arb tuning levers:
- MIN_PROFIT_BPS: minimum spread to attempt (higher = fewer attempts, higher quality)
- MAX_SLIPPAGE_BPS: max acceptable slippage per leg  
- GAS_PRIORITY: priority fee in microlamports (higher = faster, more cost)
- MIN_LIQUIDITY_USD: minimum pool liquidity to route through
- ATTEMPT_INTERVAL_MS: how often to scan for opportunities

Rules:
- If success rate < 30%: raise MIN_PROFIT_BPS, lower MAX_SLIPPAGE_BPS
- If fee drag > 60%: lower GAS_PRIORITY  
- If avg net < 0: raise threshold dramatically or pause the strategy
- Be specific with numeric values

Output ONLY valid JSON:
{
  "proposals": [
    {
      "rank": 1,
      "title": "Short title",
      "rationale": "1-2 sentences citing specific metric",
      "param_changes": [{"param": "MIN_PROFIT_BPS", "value": 15}],
      "expected_impact": "Brief expected improvement"
    }
  ]
}"""

def call_gemini(prompt: str) -> Optional[str]:
    if not GEMINI_API_KEY:
        return None
    try:
        body = json.dumps({
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": 1024},
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{GEMINI_URL}?key={GEMINI_API_KEY}", data=body,
            headers={"Content-Type": "application/json"}, method="POST",
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read())
            return data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as e:
        print(f"[ArbCriticAgent] Gemini call failed: {e}")
        return None

def rule_based_arb_proposals(report: dict) -> list[dict]:
    proposals = []
    sr    = report.get("success_rate_pct", 0)
    net   = report.get("avg_net_sol", 0)
    drag  = report.get("fee_drag_pct", 0)
    spread= report.get("avg_spread_bps", 0)

    if sr < 30:
        proposals.append({
            "rank": 1, "title": "Low success rate — raise minimum spread",
            "rationale": f"Success rate {sr:.1f}% < 30% — too many unprofitable attempts.",
            "param_changes": [
                {"param": "MIN_PROFIT_BPS", "value": max(10, int(spread * 1.5))},
                {"param": "MAX_SLIPPAGE_BPS", "value": 20},
            ],
            "expected_impact": "Reduce failed txns, improve net profitability",
        })
    if drag > 60:
        proposals.append({
            "rank": 2, "title": "High fee drag — reduce gas priority",
            "rationale": f"Fee drag {drag:.1f}% consuming most gross profit.",
            "param_changes": [{"param": "GAS_PRIORITY", "value": 5000}],
            "expected_impact": "Lower cost per attempt, improve net margin",
        })
    if net < 0 and len(proposals) < 3:
        proposals.append({
            "rank": len(proposals)+1, "title": "Negative avg net — pause or raise threshold",
            "rationale": f"Avg net {net:.6f} SOL is negative — arb is losing money.",
            "param_changes": [
                {"param": "MIN_PROFIT_BPS", "value": max(15, int(spread * 2))},
                {"param": "MIN_LIQUIDITY_USD", "value": 50000},
            ],
            "expected_impact": "Only attempt high-confidence routes",
        })
    return proposals

def run() -> list[dict]:
    SWARM.mkdir(parents=True, exist_ok=True)
    report = {}
    if ARB_REPORT.exists():
        try:
            report = json.loads(ARB_REPORT.read_text(encoding="utf-8"))
        except Exception:
            pass

    if not report.get("ready"):
        print("[ArbCriticAgent] No arb data ready — skipping")
        return []

    proposals = []
    if GEMINI_API_KEY:
        prompt = (f"Arb engine metrics:\n{json.dumps(report, indent=2)}\n\n"
                  "Propose 3 ranked improvements to maximize net profit.")
        resp = call_gemini(ARB_SYSTEM_PROMPT + "\n\n" + prompt)
        if resp:
            try:
                m = re.search(r'\{[\s\S]*"proposals"[\s\S]*\}', resp)
                if m:
                    proposals = json.loads(m.group(0)).get("proposals", [])
                    print(f"[ArbCriticAgent] LLM generated {len(proposals)} proposal(s)")
            except Exception:
                pass

    if not proposals:
        proposals = rule_based_arb_proposals(report)
        print(f"[ArbCriticAgent] Rule-based: {len(proposals)} proposal(s)")

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "llm_used": bool(GEMINI_API_KEY and proposals),
        "proposals": proposals,
    }
    ARB_PROPOSALS.write_text(json.dumps(output, indent=2), encoding="utf-8")
    return proposals

if __name__ == "__main__":
    run()
