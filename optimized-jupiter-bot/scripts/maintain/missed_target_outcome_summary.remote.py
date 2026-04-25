#!/usr/bin/env python3
"""
Replay recent missed targets against GMGN 1m candles.

This helps answer:
- which reject reasons were protecting us from junk
- which reject reasons may deserve a narrow exception path

Usage:
  python3 scripts/maintain/missed_target_outcome_summary.remote.py
  python3 scripts/maintain/missed_target_outcome_summary.remote.py --lookback-min 180 --min-age-min 5 --horizon-min 5 --limit 40
"""

import argparse
import json
import os
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path


DEFAULT_REASONS = [
    "normal_momentum_below_threshold",
    "negative_trend_without_reversal",
    "live_liquidity_below_threshold",
    "low_volume_skip",
    "no_dex_data_skip",
    "live_dump_skip",
    "overbought_skip",
    "late_entry_skip",
]


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--signals-dir", default=os.path.join(os.getcwd(), "signals"))
    parser.add_argument("--lookback-min", type=int, default=180)
    parser.add_argument("--min-age-min", type=int, default=5)
    parser.add_argument("--horizon-min", type=int, default=5)
    parser.add_argument("--limit", type=int, default=40)
    parser.add_argument("--reason", action="append", dest="reasons")
    parser.add_argument("--json", action="store_true", dest="json_output")
    parser.add_argument("--gmgn-cli", default=os.environ.get("GMGN_CLI_BIN", "/usr/bin/gmgn-cli"))
    return parser.parse_args()


def load_jsonl(file_path: Path):
    rows = []
    for line in file_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        ts = int(obj.get("ts") or obj.get("fallbackTimestamp") or 0)
        if not ts:
            continue
        obj["_ts"] = ts
        rows.append(obj)
    return rows


def fetch_kline(cli_bin: str, mint: str, start_s: int, end_s: int):
    cmd = [
        cli_bin,
        "market",
        "kline",
        "--chain",
        "sol",
        "--address",
        mint,
        "--resolution",
        "1m",
        "--from",
        str(start_s),
        "--to",
        str(end_s),
        "--raw",
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except Exception:
        return None
    if res.returncode != 0:
        return None
    try:
        payload = json.loads(res.stdout.strip())
    except Exception:
        return None
    return payload.get("list") or payload.get("data", {}).get("list") or payload.get("data") or []


def build_results(rows, cli_bin: str, horizon_min: int):
    results = []
    now_s = int(time.time())
    for obj in rows:
        ts = int(obj["_ts"])
        mint = str(obj.get("mint") or "").strip()
        if not mint:
            continue
        start_s = max(0, ts // 1000 - 60)
        end_s = min(now_s, ts // 1000 + horizon_min * 60)
        candles = fetch_kline(cli_bin, mint, start_s, end_s)
        if not candles:
            continue
        candles = [c for c in candles if int(c.get("time", 0)) * 1000 >= ts - 60_000]
        if len(candles) < 2:
            continue
        entry = float(candles[0].get("open") or candles[0].get("close") or 0)
        if entry <= 0:
            continue
        max_high = max(float(c.get("high") or 0) for c in candles)
        min_low = min(float(c.get("low") or 0) for c in candles)
        close_last = float(candles[-1].get("close") or 0)
        if close_last <= 0:
            continue
        max_run = (max_high / entry) - 1
        max_dd = (min_low / entry) - 1
        close_ret = (close_last / entry) - 1
        results.append(
            {
                "symbol": obj.get("symbol"),
                "mint": mint,
                "reason": obj.get("reason"),
                "stage": obj.get("stage"),
                "ts": ts,
                "max_run_pct": round(max_run * 100, 2),
                "max_dd_pct": round(max_dd * 100, 2),
                f"close_{horizon_min}m_pct": round(close_ret * 100, 2),
                "volume1hUsd": obj.get("volume1hUsd"),
                "liquidityUsd": obj.get("liquidityUsd"),
                "momentum5m": obj.get("momentum5m"),
                "momentum1m": obj.get("momentum1m"),
            }
        )
    return results


def summarize(results, horizon_min: int):
    agg = defaultdict(
        lambda: {
            "n": 0,
            "run3": 0,
            "run5": 0,
            "run10": 0,
            "close_pos": 0,
            "dd10": 0,
            "avg_run": 0.0,
            "avg_close": 0.0,
        }
    )
    close_key = f"close_{horizon_min}m_pct"
    for row in results:
        bucket = agg[row["reason"]]
        bucket["n"] += 1
        bucket["run3"] += row["max_run_pct"] >= 3
        bucket["run5"] += row["max_run_pct"] >= 5
        bucket["run10"] += row["max_run_pct"] >= 10
        bucket["close_pos"] += row[close_key] > 0
        bucket["dd10"] += row["max_dd_pct"] <= -10
        bucket["avg_run"] += row["max_run_pct"]
        bucket["avg_close"] += row[close_key]
    summary = []
    for reason, bucket in agg.items():
        summary.append(
            {
                "reason": reason,
                "n": bucket["n"],
                "run3": bucket["run3"],
                "run5": bucket["run5"],
                "run10": bucket["run10"],
                "close_pos": bucket["close_pos"],
                "dd10": bucket["dd10"],
                "avg_run": round(bucket["avg_run"] / bucket["n"], 2),
                f"avg_close_{horizon_min}m": round(bucket["avg_close"] / bucket["n"], 2),
            }
        )
    return sorted(summary, key=lambda item: (-item["n"], item["reason"]))


def main():
    args = parse_args()
    signals_dir = Path(args.signals_dir)
    missed_file = signals_dir / ("missed_targets_paper.jsonl" if os.environ.get("PAPER_MODE") == "true" else "missed_targets.jsonl")
    if not missed_file.exists():
        print(f"Missing {missed_file}", file=sys.stderr)
        return 1

    reasons = set(args.reasons or DEFAULT_REASONS)
    now_ms = int(time.time() * 1000)
    all_rows = load_jsonl(missed_file)
    filtered = []
    for row in all_rows:
        age_min = (now_ms - int(row["_ts"])) / 60_000
        if age_min < args.min_age_min or age_min > args.lookback_min:
            continue
        if row.get("reason") not in reasons:
            continue
        filtered.append(row)

    latest = {}
    for row in filtered:
        latest[(row.get("mint"), row.get("reason"))] = row
    selected = sorted(latest.values(), key=lambda item: item["_ts"], reverse=True)[: args.limit]
    results = build_results(selected, args.gmgn_cli, args.horizon_min)
    summary = summarize(results, args.horizon_min)
    top = sorted(results, key=lambda item: (-item["max_run_pct"], item["max_dd_pct"]))[:15]

    if args.json_output:
        print(
            json.dumps(
                {
                    "selected": len(selected),
                    "results": len(results),
                    "summary": summary,
                    "top": top,
                },
                indent=2,
            )
        )
        return 0

    print(f"Missed target replay | selected={len(selected)} | replayed={len(results)} | horizon={args.horizon_min}m")
    for bucket in summary:
        print(json.dumps(bucket))
    print("TOP")
    for row in top:
        print(json.dumps(row))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
