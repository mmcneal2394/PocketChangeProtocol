#!/bin/bash
# Diagnose: what are actual hold times, optimizer learnings, live params

BASE=/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot
JOURNAL=$BASE/signals/trade_journal.jsonl

echo "=== HOLD TIME AUDIT ==="
echo ""
echo "-- Last 20 SELL hold times --"
grep '"action":"SELL"' $JOURNAL | tail -20 | while read line; do
  holdMs=$(echo $line | grep -oP '"holdMs":\K[0-9]+' || echo 0)
  symbol=$(echo $line  | grep -oP '"symbol":"\K[^"]+')
  reason=$(echo $line  | grep -oP '"reason":"\K[^"]+')
  pnl=$(echo $line     | grep -oP '"pnlSol":\K[-0-9.]+')
  if [ -n "$holdMs" ] && [ "$holdMs" != "0" ]; then
    holdMin=$(echo "scale=2; $holdMs / 60000" | bc)
    icon="L"
    [ $(echo "$pnl > 0" | bc 2>/dev/null) = "1" ] && icon="W"
    printf "  [%s] %-12s %5.1fmin  %s  (%.4f SOL)\n" "$icon" "$symbol" "$holdMin" "$reason" "$pnl"
  fi
done

echo ""
echo "-- Hold time stats --"
ALL_HOLDS=$(grep '"action":"SELL"' $JOURNAL | grep -oP '"holdMs":\K[0-9]+')
COUNT=$(echo "$ALL_HOLDS" | wc -l)
AVG=$(echo "$ALL_HOLDS" | awk '{sum+=$1; n++} END {printf "%.0f", sum/n}')
MAX=$(echo "$ALL_HOLDS" | sort -n | tail -1)
OVER_6MIN=$(echo "$ALL_HOLDS" | awk '$1 > 360000' | wc -l)
OVER_6MIN_PCT=$(echo "scale=1; $OVER_6MIN * 100 / $COUNT" | bc)
echo "  Trades analysed:  $COUNT"
echo "  Avg hold:         $(echo "scale=2; $AVG / 60000" | bc) min"
echo "  Max hold:         $(echo "scale=2; $MAX / 60000" | bc) min"
echo "  Over 6min:        $OVER_6MIN ($OVER_6MIN_PCT%)"

echo ""
echo "=== OPTIMIZER LEARNINGS ==="
echo ""
echo "-- Current strategy_params.json --"
cat $BASE/signals/strategy_params.json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); [print(f'  {k}: {v}') for k,v in d.items()]" 2>/dev/null || cat $BASE/signals/strategy_params.json

echo ""
echo "-- fitness_history last 5 entries --"
tail -5 $BASE/signals/swarm/fitness_history.jsonl 2>/dev/null

echo ""
echo "-- What optimizer has scored best --"
grep -i 'best\|fitness\|score\|WR\|win_rate' /root/.pm2/logs/pcp-optimizer-out.log | grep -v AutoApply | tail -10

echo ""
echo "=== LIVE SNIPER CONSTANTS ==="
grep -E 'MAX_HOLD_MS|MAX_BUY_SOL|MIN_BUY_SOL|BASE_BUY_PCT|MAX_POSITIONS|SNIPER_MAX_HOLD' \
  $BASE/scripts/maintain/momentum_sniper.ts | head -15

echo ""
echo "=== ENV OVERRIDES ==="
grep -E 'SNIPER_MAX_HOLD|SNIPER_SL|SNIPER_TP|SNIPER_BUY' $BASE/.env 2>/dev/null || echo "  No .env overrides for sniper params"
