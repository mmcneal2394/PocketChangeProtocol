#!/bin/bash
JOURNAL=/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/trade_journal.jsonl

echo "=== LONGEST HELD POSITIONS ==="
echo ""
echo "Top 15 by hold time:"
grep '"action":"SELL"' $JOURNAL | while read line; do
  holdMs=$(echo "$line" | grep -oP '"holdMs":\K[0-9]+')
  [ -z "$holdMs" ] && continue
  symbol=$(echo "$line"  | grep -oP '"symbol":"\K[^"]+')
  reason=$(echo "$line"  | grep -oP '"reason":"\K[^"]+')
  pnl=$(echo "$line"     | grep -oP '"pnlSol":\K[-0-9.]+')
  ts=$(echo "$line"      | grep -oP '"ts":\K[0-9]+')
  holdMin=$(echo "scale=2; $holdMs / 60000" | bc)
  echo "$holdMs $holdMin $symbol $reason $pnl $ts"
done | sort -rn | head -15 | while read ms min sym reason pnl ts; do
  dt=$(date -d "@$(( ts / 1000 ))" '+%H:%M:%S' 2>/dev/null || echo "?")
  icon="L"; [ $(echo "$pnl > 0" | bc 2>/dev/null) = "1" ] && icon="W"
  printf "  [%s] %6.1fmin  %-14s  %-35s  %s SOL  @%s\n" "$icon" "$min" "$sym" "$reason" "$pnl" "$dt"
done

echo ""
echo "=== HOLD DISTRIBUTION ==="
echo ""
JOURNAL_DATA=$(grep '"action":"SELL"' $JOURNAL | grep -oP '"holdMs":\K[0-9]+')
echo "  Under 2min:   $(echo "$JOURNAL_DATA" | awk '$1 < 120000' | wc -l)"
echo "  2-6min:       $(echo "$JOURNAL_DATA" | awk '$1 >= 120000 && $1 < 360000' | wc -l)"
echo "  6-20min:      $(echo "$JOURNAL_DATA" | awk '$1 >= 360000 && $1 < 1200000' | wc -l)"
echo "  20-60min:     $(echo "$JOURNAL_DATA" | awk '$1 >= 1200000 && $1 < 3600000' | wc -l)"
echo "  Over 60min:   $(echo "$JOURNAL_DATA" | awk '$1 >= 3600000' | wc -l)"
echo "  Over 2hr:     $(echo "$JOURNAL_DATA" | awk '$1 >= 7200000' | wc -l)"

echo ""
echo "=== WHEN WAS ENV LAST CHANGED ==="
stat -c '%y %n' /mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/.env

echo ""
echo "=== CRON OPTIMIZER: competing with PM2 optimizer? ==="
crontab -l 2>/dev/null | grep optimizer

echo ""
echo "=== CURRENT LIVE MAX_HOLD FROM .ENV ==="
grep 'SNIPER_MAX_HOLD' /mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/.env

echo ""
echo "=== CONFIRMED FROM RUNNING PROCESS ==="
grep 'Hold:.*max' /root/.pm2/logs/pcp-sniper-out.log | tail -3
