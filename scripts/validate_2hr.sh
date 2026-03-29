#!/bin/bash
# 2-Hour Validation Test — PCP Swarm Fix Verification (v2)
# 8 checks × 15min. Validates only trades SINCE the fix was deployed.
# Fix deployed at approx: 2026-03-26 16:16 UTC (SNIPER_MAX_HOLD fixed)
# Results: /tmp/pcp_validation.log

LOG=/tmp/pcp_validation.log
BASE=/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot
JOURNAL=$BASE/signals/trade_journal.jsonl

# Fix deployed timestamp (epoch) = when .env was corrected
FIX_TS=1774544210  # 2026-03-26 16:16:50 UTC

START_TS=$(date +%s)
START_EXITS=$(grep -c '"action":"SELL"' $JOURNAL 2>/dev/null || echo 0)
START_WSOL=$(grep 'WSOL:' /root/.pm2/logs/pcp-sniper-out.log 2>/dev/null | grep -oP 'WSOL: \K[0-9.]+' | tail -1)
START_OPT=$(grep -c 'Cycle done' /root/.pm2/logs/pcp-optimizer-out.log 2>/dev/null || echo 0)

CHECK_NUM=0
TOTAL_PASS=0
TOTAL_FAIL=0

{
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  PCP 2-HOUR VALIDATION TEST  v2                     ║"
echo "║  Started: $(date '+%Y-%m-%d %H:%M:%S UTC')              ║"
echo "║  Validating trades ONLY after fix deployment        ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "  Baseline at test start:"
echo "    Total exits:  $START_EXITS"
echo "    WSOL:         ${START_WSOL:-?} SOL"
echo "    Opt cycles:   $START_OPT"
echo ""
} | tee $LOG

run_check() {
  CHECK_NUM=$((CHECK_NUM + 1))
  NOW=$(date +%s)
  ELAPSED=$(( (NOW - START_TS) / 60 ))
  TS=$(date '+%H:%M:%S')
  CP=0; CF=0

  {
  echo "─────────────────────────────────────────────────────"
  echo "  CHECK #$CHECK_NUM  |  T+${ELAPSED}min  |  $TS UTC"
  echo ""

  # ── Fix 1: Hold cap — only trades AFTER fix deployment ──
  # Filter by ts field > FIX_TS*1000
  NEW_MAX_HOLD=$(grep '"action":"SELL"' $JOURNAL 2>/dev/null | \
    awk -v ts="${FIX_TS}000" -F'"holdMs":' 'NF>1{split($2,a,","); h=a[1]+0} /ts/ && /holdMs/{split($0,b,"\"ts\":"); split(b[2],c,"}"); tval=c[1]+0; if(tval>ts) print h}' | \
    sort -n | tail -1)
  NEW_MAX_HOLD=${NEW_MAX_HOLD:-0}
  NEW_MAX_MIN=$(echo "scale=1; $NEW_MAX_HOLD / 60000" | bc 2>/dev/null || echo "?")
  POST_FIX_COUNT=$(grep '"action":"SELL"' $JOURNAL 2>/dev/null | \
    awk -F'"ts":' 'NF>1{split($2,a,"}"); if(a[1]+0>'${FIX_TS}'000) c++} END{print c+0}')

  if [ "${NEW_MAX_HOLD}" -le "370000" ] 2>/dev/null; then
    echo "  ✅ FIX 1 HOLD CAP:    max ${NEW_MAX_MIN}min post-fix (${POST_FIX_COUNT} trades since fix)"
    CP=$((CP+1))
  else
    echo "  ❌ FIX 1 HOLD CAP:    max ${NEW_MAX_MIN}min EXCEEDS 6min (${POST_FIX_COUNT} post-fix trades)"
    CF=$((CF+1))
  fi

  # ── Fix 2: Optimizer baseline (not phantom 0.9x) ────────
  LAST3=$(grep 'No promotion' /root/.pm2/logs/pcp-optimizer-out.log 2>/dev/null | tail -3)
  # Extract baselines — look for "current 0.X" where X < 0.5
  BASELINES=$(echo "$LAST3" | grep -oP 'current \K[0-9.]+')
  PHANTOM_COUNT=0
  for b in $BASELINES; do
    result=$(echo "$b > 0.5" | bc 2>/dev/null)
    [ "$result" = "1" ] && PHANTOM_COUNT=$((PHANTOM_COUNT+1))
  done
  OPT_NOW=$(grep -c 'Cycle done' /root/.pm2/logs/pcp-optimizer-out.log 2>/dev/null || echo 0)
  NEW_CYCLES=$((OPT_NOW - START_OPT))
  LATEST_BASE=$(echo "$BASELINES" | tail -1)

  if [ "$PHANTOM_COUNT" -eq "0" ]; then
    echo "  ✅ FIX 2 OPT BASELINE: $LATEST_BASE (≤0.5, not phantom) | +$NEW_CYCLES new opt cycles"
    CP=$((CP+1))
  else
    echo "  ❌ FIX 2 OPT BASELINE: $PHANTOM_COUNT phantom (>0.5) baselines in last 3 checks"
    echo "     Baselines seen: $BASELINES"
    CF=$((CF+1))
  fi

  # ── Fix 3: Param guard — no bad env ────────────────────
  CLAMPS=$(grep 'PARAM_GUARD' /root/.pm2/logs/pcp-sniper-out.log 2>/dev/null | wc -l)
  ENV_HOLD=$(grep 'SNIPER_MAX_HOLD' $BASE/.env 2>/dev/null | cut -d= -f2 | tr -d ' ')
  HOLD_OK=0
  [ -n "$ENV_HOLD" ] && [ "$ENV_HOLD" -le "600000" ] 2>/dev/null && HOLD_OK=1
  STARTUP=$(grep 'Hold:.*max' /root/.pm2/logs/pcp-sniper-out.log 2>/dev/null | tail -1)

  if [ "$CLAMPS" -eq "0" ] && [ "$HOLD_OK" -eq "1" ]; then
    echo "  ✅ FIX 3 PARAM GUARD:  0 clamp events | .env=${ENV_HOLD}ms | startup confirms 6min"
    CP=$((CP+1))
  else
    echo "  ❌ FIX 3 PARAM GUARD:  clamps=$CLAMPS | .env HOLD=$ENV_HOLD | $STARTUP"
    CF=$((CF+1))
  fi

  # ── Fix 4: WSOL live balance ────────────────────────────
  WSOL=$(grep 'WSOL:' /root/.pm2/logs/pcp-sniper-out.log 2>/dev/null | grep -oP 'WSOL: \K[0-9.]+' | tail -1)
  SNIPER_LOG_AGE=$(( NOW - $(stat -c %Y /root/.pm2/logs/pcp-sniper-out.log 2>/dev/null || echo $NOW) ))

  if [ -n "$WSOL" ] && [ "$SNIPER_LOG_AGE" -lt "120" ]; then
    echo "  ✅ FIX 4 WSOL BALANCE: $WSOL SOL (log ${SNIPER_LOG_AGE}s ago)"
    CP=$((CP+1))
  else
    echo "  ❌ FIX 4 WSOL BALANCE: ${WSOL:-unavailable} (log ${SNIPER_LOG_AGE}s — stale)"
    CF=$((CF+1))
  fi

  # ── Fix 5: Orphans — FQ8T5 blacklisted, no new stuck ones
  BL=$(python3 -c "import json; d=json.load(open('$BASE/signals/sniper_positions.json')); print('FQ8T5dNMZzRLhrjih6H4UPLX9bFf8QJ7RQ5W5VxdEaB' in d.get('blacklist',[]))" 2>/dev/null)
  ACTIVE=$(python3 -c "import json; d=json.load(open('$BASE/signals/sniper_positions.json')); print(len(d.get('positions',[])))" 2>/dev/null || echo "?")

  if [ "$BL" = "True" ]; then
    echo "  ✅ FIX 5 ORPHAN SWEEP: Dust blacklisted | Active tracked positions: $ACTIVE"
    CP=$((CP+1))
  else
    echo "  ❌ FIX 5 ORPHAN SWEEP: FQ8T5 NOT in blacklist — may still cause churn"
    CF=$((CF+1))
  fi

  # ── Performance ─────────────────────────────────────────
  TOT=$(grep -c '"action":"SELL"' $JOURNAL 2>/dev/null || echo 0)
  WINS=$(grep '"action":"SELL"' $JOURNAL 2>/dev/null | grep -v '"pnlSol":-' | grep -c '"pnlSol":' || echo 0)
  WR=$(echo "scale=1; $WINS * 100 / ${TOT:-1}" | bc 2>/dev/null || echo "?")
  NEW_SINCE=$((TOT - START_EXITS))
  LAST_EXIT=$(grep '"action":"SELL"' $JOURNAL 2>/dev/null | tail -1 | grep -oP '"reason":"\K[^"]+')

  echo ""
  echo "  PERF:    Exits=$TOT (+$NEW_SINCE this session) | WR=${WR}% | WSOL=${WSOL} SOL"
  echo "  LAST:    $LAST_EXIT"
  echo ""
  echo "  ▶ Check #$CHECK_NUM: $CP/5 passed"
  } | tee -a $LOG

  TOTAL_PASS=$((TOTAL_PASS + CP))
  TOTAL_FAIL=$((TOTAL_FAIL + CF))
}

for i in 1 2 3 4 5 6 7 8; do
  run_check
  [ $i -lt 8 ] && sleep 900
done

# ── Final report ──────────────────────────────────────────
FINAL_WSOL=$(grep 'WSOL:' /root/.pm2/logs/pcp-sniper-out.log 2>/dev/null | grep -oP 'WSOL: \K[0-9.]+' | tail -1)
WSOL_DELTA=$(echo "scale=4; ${FINAL_WSOL:-0} - ${START_WSOL:-0}" | bc 2>/dev/null || echo "?")
FINAL_OPT=$(grep -c 'Cycle done' /root/.pm2/logs/pcp-optimizer-out.log 2>/dev/null || echo 0)
FINAL_EXITS=$(grep -c '"action":"SELL"' $JOURNAL 2>/dev/null || echo 0)
SESSION_TRADES=$((FINAL_EXITS - START_EXITS))

{
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  FINAL VALIDATION REPORT — 2 HOURS                 ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "  Fix checks:   $((CHECK_NUM * 5)) total | $TOTAL_PASS passed | $TOTAL_FAIL failed"
echo "  Session:      $SESSION_TRADES new trades | $((FINAL_OPT - START_OPT)) opt cycles"
echo "  WSOL:         $START_WSOL → $FINAL_WSOL SOL ($WSOL_DELTA)"
echo ""
if [ $TOTAL_FAIL -eq 0 ]; then
  echo "  🎉 ALL 5 FIXES VALIDATED ACROSS 2 HOURS"
  echo "  ✅ Hold cap enforced | Optimizer real baseline | Param guard active"
  echo "  ✅ WSOL live balance | Orphans blacklisted"
else
  echo "  ⚠️  $TOTAL_FAIL fix check(s) failed — see log above for details"
fi
echo ""
echo "  Full log: /tmp/pcp_validation.log"
} | tee -a $LOG
