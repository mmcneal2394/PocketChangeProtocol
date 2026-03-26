#!/usr/bin/env python3
"""
trading_optimizer.py — PCP Autonomous Harmonic Trading Optimizer
────────────────────────────────────────────────────────────────
Runs 9 agents every CYCLE_MINUTES (default: 10):

  ── Sniper Pipeline ──
  DataAgent → AnalyzerAgent → CriticAgent → OptimizerAgent → BacktesterAgent

  ── Arb Pipeline ─────
  ArbDataAgent → ArbCriticAgent

  ── Harmony Layer ────
  HarmonyAgent → allocation.json  (cross-strategy capital weights)
  MemoryAgent  → strategy_params.json (promotes best candidates)
"""
import sys, os, time, json, traceback
from pathlib import Path
from datetime import datetime, timezone

# ── Load .env from bot root ───────────────────────────────────────────────────
try:
    from dotenv import load_dotenv as _ld
    _ld(Path(__file__).parents[2] / '.env', override=True)
except Exception:
    pass

ROOT      = Path(__file__).parents[2]
SWARM_DIR = Path(__file__).parent / "swarm"
sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(SWARM_DIR))

import data_agent, analyzer_agent, critic_agent
import optimizer_agent, backtester_agent, memory_agent
import arb_data_agent, arb_critic_agent, harmony_agent
import auto_apply_agent

CYCLE_MINUTES = int(os.getenv("OPTIMIZER_CYCLE_MIN", "10"))
DRY_RUN       = "--dry-run" in sys.argv
RUN_ONCE      = "--once"    in sys.argv or DRY_RUN

SIGNALS = ROOT / "signals"
SWARM   = SIGNALS / "swarm"


def banner():
    print("╔══════════════════════════════════════════════════════╗")
    print("║  PCP HARMONIC TRADING OPTIMIZER                      ║")
    print("║  9 Agents: Sniper · Arb · Harmony pipelines in sync  ║")
    print(f"║  Cycle: every {CYCLE_MINUTES}min | Dry-run: {DRY_RUN:<5}                ║")
    print("╚══════════════════════════════════════════════════════╝")


def _step(results: dict, name: str, fn):
    try:
        t0 = time.time()
        results[name] = fn()
        print(f"  ✅ {name} — {(time.time()-t0):.1f}s")
    except Exception as e:
        print(f"  ❌ {name} FAILED: {e}")
        traceback.print_exc()
        results[name] = None


def run_cycle(cycle_num: int):
    start = time.time()
    now   = datetime.now(timezone.utc).isoformat()
    print(f"\n{'─'*60}")
    print(f"[Optimizer] 🔄 Cycle #{cycle_num} — {now}")
    print(f"{'─'*60}")

    results = {}

    # ── Sniper pipeline ───────────────────────────────────────────────────────
    print("  ── Sniper Pipeline ──────────────────────────────────")
    for name, fn in [
        ("DataAgent",       data_agent.run),
        ("AnalyzerAgent",   analyzer_agent.run),
        ("CriticAgent",     critic_agent.run),
        ("OptimizerAgent",  optimizer_agent.run),
        ("BacktesterAgent", backtester_agent.run),
    ]:
        _step(results, name, fn)

    # ── Arb pipeline ──────────────────────────────────────────────────────────
    print("  ── Arb Pipeline ─────────────────────────────────────")
    for name, fn in [
        ("ArbDataAgent",   arb_data_agent.run),
        ("ArbCriticAgent", arb_critic_agent.run),
    ]:
        _step(results, name, fn)

    # ── Harmony layer ─────────────────────────────────────────────────────────
    print("  ── Harmony Layer ────────────────────────────────────")
    try:
        t0    = time.time()
        alloc = harmony_agent.run()
        results["HarmonyAgent"] = alloc
        sw, pw, aw = alloc.get("sniper_weight",0), alloc.get("pumpfun_weight",0), alloc.get("arb_weight",0)
        print(f"  ✅ HarmonyAgent — {(time.time()-t0):.1f}s  Sniper:{sw:.0%}  PF:{pw:.0%}  Arb:{aw:.0%}")
    except Exception as e:
        print(f"  ❌ HarmonyAgent FAILED: {e}")
        traceback.print_exc()

    # ── Memory / promotion ────────────────────────────────────────────────────
    if DRY_RUN:
        print("  ⏭  MemoryAgent — skipped (dry-run)")
    else:
        try:
            t0  = time.time()
            mem = memory_agent.run()
            results["MemoryAgent"] = mem
            promo = mem.get("promoted", False)
            print(f"  ✅ MemoryAgent — {(time.time()-t0):.1f}s"
                  f"{'  | ✨ PROMOTED new params!' if promo else ''}")
        except Exception as e:
            print(f"  ❌ MemoryAgent FAILED: {e}")
            traceback.print_exc()

    # ── Auto-apply promoted params ────────────────────────────────────────────
    if DRY_RUN:
        print("  ⏭  AutoApplyAgent — skipped (dry-run)")
    else:
        try:
            t0  = time.time()
            apl = auto_apply_agent.run()
            results["AutoApplyAgent"] = apl
            n_applied  = len(apl.get("applied", []))
            n_rejected = len(apl.get("rejected", []))
            skipped    = apl.get("skipped_reason", "")
            if skipped:
                print(f"  ⏭  AutoApplyAgent — {skipped}")
            else:
                print(f"  ✅ AutoApplyAgent — {(time.time()-t0):.1f}s"
                      f"  applied:{n_applied}  rejected:{n_rejected}")
        except Exception as e:
            print(f"  ❌ AutoApplyAgent FAILED: {e}")
            traceback.print_exc()

    total_s = time.time() - start
    print(f"\n[Optimizer] ⏱  Cycle done in {total_s:.1f}s")

    # Write cycle log
    try:
        SWARM.mkdir(parents=True, exist_ok=True)
        entry = {"ts": now, "cycle": cycle_num,
                 "duration_s": round(total_s, 2), "dry_run": DRY_RUN}
        with (SWARM / "cycle_log.jsonl").open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        pass


def main():
    banner()
    SWARM.mkdir(parents=True, exist_ok=True)
    if RUN_ONCE:
        run_cycle(1)
        return
    cycle = 1
    while True:
        try:
            run_cycle(cycle)
        except KeyboardInterrupt:
            print("\n[Optimizer] Stopped by user")
            break
        except Exception as e:
            print(f"[Optimizer] Cycle error: {e}")
            traceback.print_exc()
        cycle += 1
        print(f"[Optimizer] 💤 Next cycle in {CYCLE_MINUTES}min...")
        try:
            time.sleep(CYCLE_MINUTES * 60)
        except KeyboardInterrupt:
            print("\n[Optimizer] Stopped by user")
            break


if __name__ == "__main__":
    main()
