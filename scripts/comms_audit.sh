#!/bin/bash
BASE=/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals
NOW=$(date +%s)

check() {
  local label=$1 file=$2 writer=$3 reader=$4
  if [ ! -f "$file" ]; then
    printf "  %-6s %-24s        %8s  (%s -> %s)\n" "MISSING" "$label" "—" "$writer" "$reader"
    return
  fi
  local mod=$(stat -c %Y "$file" 2>/dev/null)
  local age=$(( NOW - mod ))
  local size=$(stat -c %s "$file")
  local icon="LIVE  "
  [ $age -gt 60  ] && icon="STALE "
  [ $age -gt 300 ] && icon="DEAD  "
  printf "  %s %-24s %5ds  %7dB  (%s -> %s)\n" "$icon" "$label" "$age" "$size" "$writer" "$reader"
}

echo "=== SWARM COMMS AUDIT $(date '+%H:%M:%S') ==="
echo ""
echo "-- Entry Signal Chain --"
check "trending.json"        "$BASE/trending.json"                   "trending"       "sniper"
check "velocity.json"        "$BASE/velocity.json"                   "velocity"       "sniper"
check "wallet_signals.json"  "$BASE/wallet_signals.json"             "wallet-tracker" "sniper"
check "alpha_wallets.json"   "$BASE/alpha_wallets.json"              "analyzer.py"    "wallet-tracker"

echo ""
echo "-- Optimizer Feedback Loop --"
check "trade_journal.jsonl"      "$BASE/trade_journal.jsonl"              "sniper"    "optimizer"
check "allocation.json"          "$BASE/allocation.json"                  "optimizer" "sniper"
check "strategy_tune_log"        "/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/strategy_tune_log.jsonl" "optimizer" "log"
check "swarm/cycle_log"          "$BASE/swarm/cycle_log.jsonl"            "optimizer" "log"
check "swarm/fitness_history"    "$BASE/swarm/fitness_history.jsonl"      "optimizer" "log"

echo ""
echo "-- Sniper State --"
check "sniper_positions.json"    "$BASE/sniper_positions.json"            "sniper"     "health"
check "chart_strategy.json"      "$BASE/chart_strategy.json"              "strategist" "sniper"

echo ""
echo "-- PM2 Agent Status --"
pm2 status --no-color 2>/dev/null | awk '
  /online/  { printf "  UP    %-24s restarts:%-4s  uptime:%s\n", $2, $10, $8 }
  /stopped/ { printf "  DOWN  %-24s restarts:%-4s\n", $2, $10 }
  /error/   { printf "  ERR   %-24s restarts:%-4s\n", $2, $10 }
'

echo ""
echo "-- Last 5 Lines of Sniper Log --"
tail -5 /root/.pm2/logs/pcp-sniper-out.log 2>/dev/null
