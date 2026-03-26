"""
optimizer_agent.py — OptimizerAgent
Evolutionary parameter optimizer. Maintains a population of 20 candidate param sets,
applies tournament selection + crossover + mutation, injects CriticAgent proposals.
Outputs top-5 candidates to candidate_params.json.
"""
from __future__ import annotations
import json
import hashlib
import random
import math
from pathlib import Path
from datetime import datetime, timezone
from typing import Any

SIGNALS   = Path(__file__).parents[2] / "signals"
SWARM     = SIGNALS / "swarm"
STRATEGY  = SIGNALS / "strategy_params.json"
PROPOSALS = SWARM / "proposals.json"
EXP_LOG   = SWARM / "experiment_log.jsonl"
CANDIDATES= SWARM / "candidate_params.json"

# ── Parameter search space ────────────────────────────────────────────────────
PARAM_SPACE = {
    "min_buy_ratio":      (1.5, 4.0),
    "min_price_chg_1h":   (10.0, 40.0),
    "min_volume_1h":      (2000, 15000),
    "min_buys_1h":        (10, 40),
    "recency_gate_min":   (10, 60),
    "trail_activate_pct": (2.0, 10.0),
    "trail_lock_pct":     (0.4, 0.75),
    "tp_pct":             (8.0, 35.0),
    "sl_pct":             (5.0, 20.0),
    "retrace_shield_s":   (60, 180),
}

POPULATION_SIZE = 20

def load_current_params() -> dict:
    if STRATEGY.exists():
        try:
            return json.loads(STRATEGY.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {
        "min_buy_ratio": 2.5, "min_price_chg_1h": 20.0, "min_volume_1h": 5000,
        "min_buys_1h": 20, "recency_gate_min": 30, "trail_activate_pct": 5.0,
        "trail_lock_pct": 0.55, "tp_pct": 20.0, "sl_pct": 15.0, "retrace_shield_s": 90,
    }

def param_hash(p: dict) -> str:
    core = {k: round(float(p.get(k, 0)), 3) for k in PARAM_SPACE}
    return hashlib.md5(json.dumps(core, sort_keys=True).encode()).hexdigest()[:10]

def load_tried_hashes() -> set[str]:
    tried = set()
    if EXP_LOG.exists():
        for line in EXP_LOG.read_text(encoding="utf-8").splitlines():
            try:
                entry = json.loads(line)
                if "param_hash" in entry:
                    tried.add(entry["param_hash"])
            except Exception:
                pass
    return tried

def clamp(val: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, val))

def random_params() -> dict:
    return {k: random.uniform(lo, hi) for k, (lo, hi) in PARAM_SPACE.items()}

def mutate(params: dict, scale: float = 0.15) -> dict:
    mutated = dict(params)
    # Mutate 2-4 random params
    keys = random.sample(list(PARAM_SPACE.keys()), k=random.randint(2, 4))
    for k in keys:
        lo, hi = PARAM_SPACE[k]
        delta = (hi - lo) * scale * random.gauss(0, 1)
        mutated[k] = clamp(float(params.get(k, (lo + hi) / 2)) + delta, lo, hi)
    return mutated

def crossover(a: dict, b: dict) -> dict:
    child = {}
    for k in PARAM_SPACE:
        child[k] = a[k] if random.random() < 0.5 else b[k]
    return child

def seed_population(current: dict, proposals: list[dict], tried: set[str]) -> list[dict]:
    pop = []
    # Start with current params
    pop.append({k: current.get(k, random.uniform(*PARAM_SPACE[k])) for k in PARAM_SPACE})
    # Inject proposals from CriticAgent
    for p in proposals:
        candidate = dict(pop[0])  # base on current
        for change in p.get("param_changes", []):
            k = change.get("param")
            v = change.get("value")
            if k in PARAM_SPACE and v is not None:
                lo, hi = PARAM_SPACE[k]
                candidate[k] = clamp(float(v), lo, hi)
        pop.append(candidate)
    # Fill rest with mutations + randoms
    while len(pop) < POPULATION_SIZE:
        if random.random() < 0.7 and pop:
            base = random.choice(pop[:max(1, len(pop))])
            child = mutate(base, scale=0.2)
        else:
            child = random_params()
        h = param_hash(child)
        if h not in tried:
            pop.append(child)
    return pop[:POPULATION_SIZE]

def run() -> list[dict]:
    SWARM.mkdir(parents=True, exist_ok=True)

    current   = load_current_params()
    tried     = load_tried_hashes()
    proposals = []

    if PROPOSALS.exists():
        try:
            proposals = json.loads(PROPOSALS.read_text(encoding="utf-8")).get("proposals", [])
        except Exception:
            pass

    pop = seed_population(current, proposals, tried)

    # Ensure all params are properly typed
    candidates_out = []
    for i, p in enumerate(pop):
        typed = {}
        for k, (lo, hi) in PARAM_SPACE.items():
            v = float(p.get(k, (lo + hi) / 2))
            # Integer params
            if k in ("min_buys_1h", "retrace_shield_s"):
                typed[k] = int(round(v))
            elif k == "min_volume_1h":
                typed[k] = int(round(v / 100) * 100)  # round to $100
            else:
                typed[k] = round(v, 3)
        typed["candidate_id"]  = i
        typed["param_hash"]    = param_hash(typed)
        typed["source"]        = "optimizer"
        candidates_out.append(typed)

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "population_size": len(candidates_out),
        "candidates": candidates_out,
    }
    CANDIDATES.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(f"[OptimizerAgent] Generated {len(candidates_out)} candidates | "
          f"{len(proposals)} proposals injected | {len(tried)} experiments skipped")
    return candidates_out

if __name__ == "__main__":
    run()
