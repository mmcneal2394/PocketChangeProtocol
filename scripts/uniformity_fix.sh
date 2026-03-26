#!/bin/bash
# PCP Swarm — Directory & Language Uniformity Fix
# Fixes log prefixes, verifies all signal paths, wraps optimizer

BASE=/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot
SCRIPTS=$BASE/scripts/maintain
SIGNALS=$BASE/signals

echo "=== PCP UNIFORMITY FIX $(date '+%H:%M:%S') ==="

# ── 1. Fix log prefixes to match PM2 names ───────────────────────────────────
echo ""
echo "-- Fixing log prefixes --"

# [STRAT] → [STRATEGIST]
COUNT=$(grep -c '\[STRAT\]' $SCRIPTS/chart_strategist.ts 2>/dev/null || echo 0)
if [ "$COUNT" -gt "0" ]; then
  sed -i 's/\[STRAT\]/[STRATEGIST]/g' $SCRIPTS/chart_strategist.ts
  echo "  ✅ chart_strategist.ts: [STRAT] → [STRATEGIST] ($COUNT replacements)"
else
  echo "  ✓  chart_strategist.ts: already uniform"
fi

# [PF] → [PUMPFUN]
COUNT=$(grep -c '\[PF\]' $SCRIPTS/pumpfun_sniper.ts 2>/dev/null || echo 0)
if [ "$COUNT" -gt "0" ]; then
  sed -i 's/\[PF\]/[PUMPFUN]/g' $SCRIPTS/pumpfun_sniper.ts
  echo "  ✅ pumpfun_sniper.ts:   [PF] → [PUMPFUN] ($COUNT replacements)"
else
  echo "  ✓  pumpfun_sniper.ts: already uniform"
fi

# [HEALTH @ ...] → [HEALTH]  (timestamp in prefix is noisy)
COUNT=$(grep -c 'HEALTH @' $SCRIPTS/health_monitor.ts 2>/dev/null || echo 0)
if [ "$COUNT" -gt "0" ]; then
  sed -i 's/\[HEALTH @ .*\]/[HEALTH]/g' $SCRIPTS/health_monitor.ts
  # Also fix the dynamic timestamp interpolation pattern
  sed -i 's/`\[HEALTH @ \${.*}\]`/`[HEALTH]`/g' $SCRIPTS/health_monitor.ts
  echo "  ✅ health_monitor.ts:   [HEALTH @ ts] → [HEALTH] ($COUNT replacements)"
else
  echo "  ✓  health_monitor.ts: already uniform"
fi

# pcp-metrics prefix fix (if used in any metrics file)
for f in $SCRIPTS/telemetry_report.ts $SCRIPTS/strategy_tune.ts; do
  if [ -f "$f" ]; then
    fname=$(basename $f)
    echo "  ✓  $fname: [TELEMETRY]/[TUNE] — acceptable"
  fi
done

# ── 2. Verify all signal file paths ──────────────────────────────────────────
echo ""
echo "-- Signal directory audit --"

EXPECTED_FILES=(
  "trending.json:pcp-trending:pcp-sniper"
  "velocity.json:pcp-velocity:pcp-sniper"
  "wallet_signals.json:pcp-wallet-tracker:pcp-sniper"
  "alpha_wallets.json:analyzer.py:pcp-wallet-tracker"
  "trade_journal.jsonl:pcp-sniper:pcp-optimizer"
  "allocation.json:pcp-optimizer:pcp-sniper"
  "sniper_positions.json:pcp-sniper:pcp-health"
  "chart_strategy.json:pcp-strategist:pcp-sniper"
  "swarm/cycle_log.jsonl:pcp-optimizer:log"
  "swarm/fitness_history.jsonl:pcp-optimizer:log"
)

for entry in "${EXPECTED_FILES[@]}"; do
  IFS=':' read -r fname writer reader <<< "$entry"
  fpath="$SIGNALS/$fname"
  if [ -f "$fpath" ]; then
    age=$(( $(date +%s) - $(stat -c %Y "$fpath") ))
    size=$(stat -c %s "$fpath")
    if [ $age -lt 300 ]; then
      printf "  LIVE   %-28s %4ds %6dB  (%s→%s)\n" "$fname" "$age" "$size" "$writer" "$reader"
    else
      printf "  STALE  %-28s %4ds %6dB  (%s→%s)\n" "$fname" "$age" "$size" "$writer" "$reader"
    fi
  else
    printf "  MISS   %-28s                 (%s→%s)\n" "$fname" "$writer" "$reader"
  fi
done

# ── 3. Orphan signal files (written but nothing reads them) ──────────────────
echo ""
echo "-- Orphan signal files --"
ORPHANS=("epoch_boost.json" "fresh_launches.json" "volatility.json" "strategy_params.json")
for fname in "${ORPHANS[@]}"; do
  fpath="$SIGNALS/$fname"
  if [ -f "$fpath" ]; then
    # Check if any maintain script reads it
    READERS=$(grep -rl "$fname" $SCRIPTS/ 2>/dev/null | xargs basename -a 2>/dev/null | tr '\n' ' ')
    if [ -z "$READERS" ]; then
      echo "  ORPHAN $fname — no agent reads it"
    else
      echo "  USED   $fname ← $READERS"
    fi
  fi
done

# ── 4. Optimizer wrapper — keep it cycling without pm2 stopped state ─────────
echo ""
echo "-- Optimizer wrapper --"
WRAPPER=$SCRIPTS/optimizer_wrapper.sh
if [ ! -f "$WRAPPER" ]; then
  cat > $WRAPPER << 'WEOF'
#!/bin/bash
# Runs the optimizer in a tight loop so PM2 sees it as always-online
# Sleep between cycles matches the 10min schedule
while true; do
  cd /mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot
  python3 scripts/maintain/trading_optimizer.py 2>&1
  sleep 600  # 10 min between optimizer cycles
done
WEOF
  chmod +x $WRAPPER
  echo "  ✅ Created optimizer_wrapper.sh (keeps pcp-optimizer online)"
else
  echo "  ✓  optimizer_wrapper.sh already exists"
fi

# Restart optimizer with wrapper
pm2 stop pcp-optimizer 2>/dev/null
pm2 start $WRAPPER --name pcp-optimizer --interpreter bash 2>&1 | grep -E 'optimizer|✓|error' | tail -2
echo "  ✅ pcp-optimizer restarted with wrapper (no more stopped state)"

# ── 5. Restart patched agents ─────────────────────────────────────────────────
echo ""
echo "-- Restarting patched agents --"
pm2 restart pcp-strategist 2>&1 | grep -E 'strategist|✓' | tail -1
pm2 restart pcp-pumpfun    2>&1 | grep -E 'pumpfun|✓'    | tail -1
pm2 restart pcp-health     2>&1 | grep -E 'health|✓'     | tail -1

echo ""
echo "=== DONE ==="
