#!/bin/bash
# PCP 24-Hour Stability Monitor
# Runs every 10 minutes via cron, logs to /tmp/pcp_monitor.log
# Reports: agent health, signal freshness, win rate, balance, optimizer cycles

BASE=/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot
SIGNALS=$BASE/signals
LOG=/tmp/pcp_monitor.log
MAX_LINES=2000  # rotate log after 2000 lines

rotate_log() {
  local lines=$(wc -l < $LOG 2>/dev/null || echo 0)
  if [ "$lines" -gt "$MAX_LINES" ]; then
    tail -1000 $LOG > /tmp/pcp_monitor.tmp && mv /tmp/pcp_monitor.tmp $LOG
  fi
}

NOW=$(date +%s)
TS=$(date '+%Y-%m-%d %H:%M:%S')

rotate_log

echo "" >> $LOG
echo "══════════════════════════════════════════════════" >> $LOG
echo "  PCP MONITOR  $TS" >> $LOG
echo "══════════════════════════════════════════════════" >> $LOG

# ── 1. Agent health ───────────────────────────────────────────────────────────
echo "" >> $LOG
echo "[ AGENTS ]" >> $LOG

AGENTS=(pcp-sniper pcp-pumpfun pcp-optimizer pcp-velocity pcp-trending pcp-strategist pcp-health pcp-wallet-tracker pcp-metrics pcp-heartbeat pcp-social)
PM2_STATUS=$(pm2 status --no-color 2>/dev/null)
ALL_UP=true

for agent in "${AGENTS[@]}"; do
  # Check if the agent line contains 'stopped' or 'error' or is missing entirely
  agent_line=$(echo "$PM2_STATUS" | grep "│.*$agent ")
  if [ -z "$agent_line" ]; then
    echo "  MISS $agent — not in PM2 list" >> $LOG
    ALL_UP=false
  elif echo "$agent_line" | grep -q 'stopped\|error\|errored'; then
    restarts=$(echo "$agent_line" | grep -oP '│\s*\K[0-9]+(?=\s*│\s*online|│\s*stopped)' | tail -1 || echo '?')
    echo "  DOWN $agent — STOPPED (auto-recovering)" >> $LOG
    ALL_UP=false
    pm2 restart "$agent" 2>/dev/null && echo "       → AUTO-RESTARTED" >> $LOG
  else
    restarts=$(echo "$agent_line" | awk -F'│' '{gsub(/ /,"",$9); print $9}')
    echo "  UP   $agent (↺$restarts)" >> $LOG
  fi
done

if $ALL_UP; then
  echo "  ✅ All agents online" >> $LOG
fi

# ── 2. Signal freshness ───────────────────────────────────────────────────────
echo "" >> $LOG
echo "[ SIGNALS ]" >> $LOG

check_sig() {
  local f=$1 label=$2 threshold=$3
  if [ ! -f "$SIGNALS/$f" ]; then
    echo "  MISS  $label" >> $LOG; return
  fi
  local age=$(( NOW - $(stat -c %Y "$SIGNALS/$f") ))
  if [ $age -lt $threshold ]; then
    echo "  LIVE  $label (${age}s)" >> $LOG
  else
    echo "  STALE $label (${age}s > ${threshold}s threshold)" >> $LOG
  fi
}

check_sig "trending.json"             "trending→sniper"       120
check_sig "velocity.json"             "velocity→sniper"        10
check_sig "wallet_signals.json"       "wallet-tracker→sniper" 120
check_sig "alpha_wallets.json"        "analyzer→tracker"    15000
check_sig "allocation.json"           "optimizer→sniper"      120
check_sig "trade_journal.jsonl"       "sniper→optimizer"      600
check_sig "chart_strategy.json"       "strategist→sniper"     120
check_sig "swarm/cycle_log.jsonl"     "optimizer cycles"      120

# ── 3. Optimizer status ───────────────────────────────────────────────────────
echo "" >> $LOG
echo "[ OPTIMIZER ]" >> $LOG

OPT_LOG=/root/.pm2/logs/pcp-optimizer-out.log
if [ -f "$OPT_LOG" ]; then
  last_cycle=$(grep -c 'Cycle done' $OPT_LOG 2>/dev/null || echo 0)
  last_fitness=$(grep 'fitness' $OPT_LOG 2>/dev/null | tail -1)
  last_promote=$(grep 'promote\|AutoApply\|promoted' $OPT_LOG 2>/dev/null | tail -1)
  cycle_age=$(( NOW - $(stat -c %Y "$SIGNALS/swarm/cycle_log.jsonl" 2>/dev/null || echo $NOW) ))
  echo "  Total cycles: $last_cycle" >> $LOG
  echo "  Last cycle:   ${cycle_age}s ago" >> $LOG
  [ -n "$last_fitness" ] && echo "  Fitness:      $(echo $last_fitness | head -c 120)" >> $LOG
  [ -n "$last_promote" ] && echo "  Promotion:    $(echo $last_promote | head -c 120)" >> $LOG
else
  echo "  WARNING: Optimizer log not found" >> $LOG
fi

# ── 3b. Param Guard — catch bad env overrides ──────────────────────────────────
echo "" >> $LOG
echo "[ PARAM GUARD ]" >> $LOG

# Check for clamped values in sniper log (indicates .env had out-of-bounds value)
CLAMPS=$(grep 'PARAM_GUARD' /root/.pm2/logs/pcp-sniper-out.log 2>/dev/null | tail -10)
if [ -n "$CLAMPS" ]; then
  echo "  ALERT: Bad .env values clamped at startup:" >> $LOG
  echo "$CLAMPS" | sed 's/^/    /' >> $LOG
else
  echo "  OK  No param clamps in last startup" >> $LOG
fi

# Check live Hold time from startup banner — must be 6min (360000ms)
LIVE_HOLD=$(grep 'Hold:.*max' /root/.pm2/logs/pcp-sniper-out.log 2>/dev/null | tail -1)
if echo "$LIVE_HOLD" | grep -q '6min'; then
  echo "  OK  Hold cap: 6min confirmed in startup log" >> $LOG
elif [ -n "$LIVE_HOLD" ]; then
  echo "  ALERT: Unexpected hold cap: $LIVE_HOLD" >> $LOG
else
  echo "  WARN: No startup banner found in sniper log" >> $LOG
fi

# Check .env directly for out-of-range SNIPER_MAX_HOLD
ENV_HOLD=$(grep 'SNIPER_MAX_HOLD' $BASE/.env 2>/dev/null | cut -d= -f2)
if [ -n "$ENV_HOLD" ] && [ "$ENV_HOLD" -gt "600000" ] 2>/dev/null; then
  echo "  ALERT: .env SNIPER_MAX_HOLD=$ENV_HOLD exceeds 10min max — clamping now" >> $LOG
  sed -i "s/SNIPER_MAX_HOLD=$ENV_HOLD/SNIPER_MAX_HOLD=360000/" $BASE/.env
  pm2 restart pcp-sniper 2>/dev/null && echo "         AUTO-FIXED and sniper restarted" >> $LOG
else
  echo "  OK  .env SNIPER_MAX_HOLD=${ENV_HOLD:-default} within bounds" >> $LOG
fi

# ── 4. Win rate & PnL ─────────────────────────────────────────────────────────
echo "" >> $LOG
echo "[ PERFORMANCE ]" >> $LOG

if [ -f "$SIGNALS/trade_journal.jsonl" ]; then
  total=$(grep -c '"action":"SELL"'   "$SIGNALS/trade_journal.jsonl" 2>/dev/null || echo 0)
  wins=$(grep '"action":"SELL"'  "$SIGNALS/trade_journal.jsonl" 2>/dev/null | grep -c '"pnlSol":[0-9]' || echo 0)
  # Count wins properly (positive pnl)
  wins=$(grep '"action":"SELL"' "$SIGNALS/trade_journal.jsonl" 2>/dev/null | grep -v '"pnlSol":-' | grep -c '"pnlSol":' || echo 0)
  if [ "$total" -gt "0" ]; then
    wr=$(echo "scale=1; $wins * 100 / $total" | bc 2>/dev/null || echo "?")
    echo "  Exits:    $total  wins:$wins  WR:${wr}%" >> $LOG
  fi

  # Session PnL from positions file
  if [ -f "$SIGNALS/sniper_positions.json" ]; then
    pnl=$(grep '"totalPnlSol"' "$SIGNALS/sniper_positions.json" 2>/dev/null | grep -oP '[-0-9.]+' | head -1)
    [ -n "$pnl" ] && echo "  Total PnL: $pnl SOL" >> $LOG
  fi

  # Last 10 trades exit reasons
  echo "  Last 5 exits:" >> $LOG
  grep '"action":"SELL"' "$SIGNALS/trade_journal.jsonl" 2>/dev/null | tail -5 | \
    grep -oP '"symbol":"[^"]*"|"reason":"[^"]*"|"pnlSol":[^,}]+' | \
    paste - - - | sed 's/^/    /' >> $LOG
fi

# ── 5. WSOL trading balance (primary) + native SOL gas reserve ───────────────
echo "" >> $LOG
echo "[ BALANCE ]" >> $LOG

# WSOL ATA = actual trading capital (sniper reads this, not native SOL)
WSEOL_BAL=$(grep 'WSOL:' /root/.pm2/logs/pcp-sniper-out.log 2>/dev/null | grep -oP 'WSOL: \K[0-9.]+' | tail -1)
WSEOL_SIZE=$(grep 'WSOL:' /root/.pm2/logs/pcp-sniper-out.log 2>/dev/null | grep -oP 'size: \K[0-9.]+' | tail -1)
WSEOL_AGE=$(( NOW - $(stat -c %Y /root/.pm2/logs/pcp-sniper-out.log 2>/dev/null || echo $NOW) ))
if [ -n "$WSEOL_BAL" ]; then
  echo "  WSOL (trading): $WSEOL_BAL SOL | buy size: ${WSEOL_SIZE:-?} SOL  (log age: ${WSEOL_AGE}s)" >> $LOG
  # Alert if WSOL is critically low
  WSOL_INT=$(echo "$WSEOL_BAL * 1000" | bc 2>/dev/null | cut -d. -f1)
  if [ -n "$WSOL_INT" ] && [ "$WSOL_INT" -lt 50 ] 2>/dev/null; then
    echo "  ALERT: WSOL critically low — sniper may be unable to trade" >> $LOG
  fi
else
  echo "  WSOL (trading): (unavailable — check sniper log)" >> $LOG
fi

# Native SOL = gas/rent only, expected to be low when using WSOL ATA setup
WALLET=$(grep 'WALLET_PUBLIC_KEY\|PUBLIC_KEY' $BASE/.env 2>/dev/null | grep -v '#' | head -1 | cut -d= -f2 | tr -d '"' | tr -d ' ')
RPC=$(grep '^RPC_ENDPOINT=' $BASE/.env 2>/dev/null | head -1 | cut -d= -f2 | tr -d '"' | tr -d ' ')
SOL_BAL=$(curl -sf -m 5 -X POST "$RPC" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBalance\",\"params\":[\"$WALLET\"]}" \
  2>/dev/null | grep -oP '\"value\":\K[0-9]+' | head -1)
if [ -n "$SOL_BAL" ]; then
  SOL=$(echo "scale=4; $SOL_BAL / 1000000000" | bc)
  echo "  Native SOL (gas): $SOL SOL  — expected low with WSOL ATA setup" >> $LOG
fi

# ── 6. Recent sniper activity ─────────────────────────────────────────────────
echo "" >> $LOG
echo "[ SNIPER LAST 5 LOG LINES ]" >> $LOG
tail -5 /root/.pm2/logs/pcp-sniper-out.log 2>/dev/null | sed 's/^/  /' >> $LOG

echo "" >> $LOG
echo "[ PUMPFUN LAST 3 LOG LINES ]" >> $LOG
tail -3 /root/.pm2/logs/pcp-pumpfun-out.log 2>/dev/null | sed 's/^/  /' >> $LOG

echo "══════════════════════════════════════════════════" >> $LOG
