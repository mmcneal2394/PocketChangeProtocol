#!/usr/bin/env python3
"""
auto_apply_agent.py — PCP Autonomous Parameter Application
────────────────────────────────────────────────────────────
When MemoryAgent marks promoted=True AND fitness improves >10%,
this agent:
  1. Reads HIGH-priority proposals from proposals.json
  2. Validates each against strict safety bounds
  3. Writes accepted values to .env
  4. Restarts pcp-sniper with --update-env via PM2
  5. Logs everything to signals/swarm/auto_apply_log.jsonl

Safety bounds prevent the AI from proposing values that would
break the engine or blow the wallet.
"""
import os, re, json, subprocess, traceback
from pathlib import Path
from datetime import datetime, timezone

ROOT    = Path(__file__).parents[3]   # parents[3] = bot root from scripts/maintain/swarm/
SIGNALS = ROOT / "signals"
SWARM   = SIGNALS / "swarm"
ENV_PATH= ROOT / ".env"
LOG_FILE= SWARM / "auto_apply_log.jsonl"

# ── Safety bounds — AI cannot write outside these ranges ─────────────────────
SAFE_BOUNDS: dict[str, tuple] = {
    # (env_key, min_val, max_val, type)
    "SNIPER_MIN_CHG":  (5.0,   50.0,  float),  # 1h change threshold 5%-50%
    "SNIPER_MIN_VOL":  (500,   20000, float),   # min volume $500-$20k
    "SNIPER_MIN_BR":   (1.2,   5.0,   float),   # buy ratio 1.2x-5x
    "SNIPER_MIN_BUYS": (5,     100,   int),      # min buys 5-100
    "SNIPER_MAX_AGE":  (5,     120,   float),   # token age 5-120 min
    "SNIPER_MIN_5M":   (-10.0, 10.0,  float),   # 5m momentum gate
    "SNIPER_MAX_HOLD": (300000, 3600000, int),  # hold 5min-60min (ms)
    "SNIPER_BUY_PCT":  (0.02,  0.25,  float),  # buy size 2%-25% of balance
    "SNIPER_MIN_BUY":  (0.001, 0.05,  float),  # min buy 0.001-0.05 SOL
    "SNIPER_MAX_BUY":  (0.005, 0.10,  float),  # max buy 0.005-0.10 SOL
}

# Map Gemini proposal parameter names → .env key names
PARAM_MAP: dict[str, str] = {
    "MIN_PRICE_CHG_1H":  "SNIPER_MIN_CHG",
    "MIN_VOLUME_1H":     "SNIPER_MIN_VOL",
    "MIN_BUY_RATIO":     "SNIPER_MIN_BR",
    "MIN_BUYS_1H":       "SNIPER_MIN_BUYS",
    "MAX_TOKEN_AGE_MIN": "SNIPER_MAX_AGE",
    "MIN_MOMENTUM_5M":   "SNIPER_MIN_5M",
    "MAX_HOLD_MS":       "SNIPER_MAX_HOLD",
    "BASE_BUY_PCT":      "SNIPER_BUY_PCT",
    "MIN_BUY_SOL":       "SNIPER_MIN_BUY",
    "MAX_BUY_SOL":       "SNIPER_MAX_BUY",
    # Also accept env names directly
    "SNIPER_MIN_CHG":    "SNIPER_MIN_CHG",
    "SNIPER_MIN_VOL":    "SNIPER_MIN_VOL",
    "SNIPER_MIN_BR":     "SNIPER_MIN_BR",
    "SNIPER_MIN_BUYS":   "SNIPER_MIN_BUYS",
    "SNIPER_MAX_AGE":    "SNIPER_MAX_AGE",
    "SNIPER_MIN_5M":     "SNIPER_MIN_5M",
    "SNIPER_MAX_HOLD":   "SNIPER_MAX_HOLD",
}


def _log(entry: dict):
    SWARM.mkdir(parents=True, exist_ok=True)
    entry["ts"] = datetime.now(timezone.utc).isoformat()
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


def _read_json(path: Path, fallback=None):
    try:
        return json.loads(path.read_text()) if path.exists() else (fallback or {})
    except Exception:
        return fallback or {}


def _write_env(key: str, value: str):
    """Update or append a key=value in .env."""
    content = ENV_PATH.read_text(encoding="utf-8") if ENV_PATH.exists() else ""
    pattern = r"^" + re.escape(key) + r"=.*"
    new_line = f"{key}={value}"
    if re.search(pattern, content, re.MULTILINE):
        content = re.sub(pattern, new_line, content, flags=re.MULTILINE)
    else:
        content = content.rstrip("\n") + "\n" + new_line + "\n"
    ENV_PATH.write_text(content, encoding="utf-8")


def _validate(env_key: str, raw_value) -> tuple[bool, str, any]:
    """Returns (ok, reason, clamped_value)."""
    if env_key not in SAFE_BOUNDS:
        return False, f"no safety bounds defined for {env_key}", None
    lo, hi, cast = SAFE_BOUNDS[env_key]
    try:
        v = cast(raw_value)
    except (ValueError, TypeError):
        return False, f"cannot cast {raw_value!r} to {cast}", None
    if v < lo or v > hi:
        return False, f"{v} outside safe range [{lo}, {hi}]", None
    return True, "ok", v


def run() -> dict:
    """
    Called after MemoryAgent. Applies promoted proposals if gates pass.
    Returns dict with applied/rejected counts.
    """
    result = {"applied": [], "rejected": [], "skipped_reason": None}

    # Gate 1: memory.json must show promoted=True
    mem = _read_json(SWARM / "memory.json")
    if not mem.get("promoted", False):
        result["skipped_reason"] = "MemoryAgent did not promote (fitness threshold not met)"
        print(f"  [AutoApply] ⏭  {result['skipped_reason']}")
        return result

    # Gate 2: fitness must have improved by >10% vs longitudinal history
    # Reads fitness_history.jsonl (cross-session) rather than in-session history[]
    # so session resets don't break the comparison baseline.
    current_fitness = mem.get("current_fitness", -999)
    HISTORY_LOG = SWARM / "fitness_history.jsonl"
    MIN_IMPROVEMENT = 0.10

    prev_fitness = -1.0  # fallback if no history yet
    if HISTORY_LOG.exists():
        hist_lines = [l for l in HISTORY_LOG.read_text().split("\n") if l.strip()]
        if len(hist_lines) >= 2:
            # Use the rolling champion from the last recorded cycle as baseline
            recent = [json.loads(l) for l in hist_lines[-10:]]  # look back 10 cycles
            champion_vals = [e.get("champion_fitness", -1.0) for e in recent if e.get("champion_fitness") is not None]
            prev_fitness = max(champion_vals) if champion_vals else -1.0

    improvement = current_fitness - prev_fitness
    if improvement < MIN_IMPROVEMENT:
        result["skipped_reason"] = f"Fitness improvement {improvement:.3f} < {MIN_IMPROVEMENT} (cross-session champion: {prev_fitness:.3f})"
        print(f"  [AutoApply] ⏭  {result['skipped_reason']}")
        _log({"event": "skipped", **result})
        return result

    print(f"  [AutoApply] 🎯 Fitness improved {improvement:+.3f} — evaluating proposals...")

    # Read proposals
    props_data = _read_json(SWARM / "proposals.json")
    proposals  = props_data.get("proposals", [])

    if not proposals:
        result["skipped_reason"] = "No proposals found"
        print(f"  [AutoApply] ⏭  No proposals to apply")
        return result

    changes_made = []

    for prop in proposals:
        # Only apply HIGH priority proposals automatically
        priority  = (prop.get("priority") or prop.get("severity") or "").upper()
        param_raw = prop.get("parameter") or prop.get("param") or ""
        value_raw = prop.get("suggested_value") or prop.get("value")
        rationale = prop.get("rationale", "")[:120]

        if priority not in ("HIGH",):
            result["rejected"].append({"param": param_raw, "reason": f"priority={priority} (only HIGH auto-applied)"})
            continue

        # Map to env key
        env_key = PARAM_MAP.get(param_raw.strip().upper(), PARAM_MAP.get(param_raw.strip(), ""))
        if not env_key:
            result["rejected"].append({"param": param_raw, "reason": "unmapped parameter name"})
            continue

        # Safety validation
        ok, reason, safe_value = _validate(env_key, value_raw)
        if not ok:
            result["rejected"].append({"param": param_raw, "env_key": env_key, "value": value_raw, "reason": reason})
            print(f"  [AutoApply] ❌ REJECT {env_key}={value_raw} — {reason}")
            continue

        # Apply to .env
        try:
            _write_env(env_key, str(safe_value))
            changes_made.append(env_key)
            result["applied"].append({"param": param_raw, "env_key": env_key, "value": safe_value, "rationale": rationale})
            print(f"  [AutoApply] ✅ APPLY  {env_key}={safe_value}  ({rationale[:60]})")
        except Exception as e:
            result["rejected"].append({"param": param_raw, "env_key": env_key, "reason": str(e)})

    # If any changes were made — restart pcp-sniper to pick them up
    if changes_made:
        print(f"  [AutoApply] 🔄 Restarting pcp-sniper with {len(changes_made)} new param(s): {changes_made}")
        try:
            subprocess.run(
                ["pm2", "restart", "pcp-sniper", "--update-env"],
                capture_output=True, timeout=15
            )
            result["restarted"] = True
            print(f"  [AutoApply] ✅ pcp-sniper restarted with promoted params")
        except Exception as e:
            result["restart_error"] = str(e)
            print(f"  [AutoApply] ⚠️  Restart failed: {e}")
    else:
        print(f"  [AutoApply] ⏭  No valid HIGH proposals — no restart needed")

    _log({"event": "cycle", "fitness_delta": improvement, **result})
    return result
