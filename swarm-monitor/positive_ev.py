path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

fixes = []

# ═══════════════════════════════════════════════════════════
# 1. TIGHTER ENTRY FILTERS
# ═══════════════════════════════════════════════════════════

# 1a. Require 5m price change >= +2% (was > 0%)
old_5m = "mom5m < 0 && pc1h < 5"
new_5m = "mom5m < 2"
if old_5m in content:
    content = content.replace(old_5m, new_5m)
    # Also fix the log message
    content = content.replace(
        'NO MOMENTUM SKIP',
        'WEAK MOMENTUM SKIP'
    )
    fixes.append('Entry: require 5m >= +2% (was positive only)')

# 1b. Live DexScreener check: require positive 5m (already set to < 0, bump to < 2)
old_live5m = "livePair.priceChange5m < 0"
new_live5m = "livePair.priceChange5m < 2"
if old_live5m in content:
    content = content.replace(old_live5m, new_live5m)
    fixes.append('Live DexScreener: require 5m >= +2%')

# 1c. Liquidity floor from $3K to $10K
old_liq = "livePair.liquidity > 0 && livePair.liquidity < 3000"
new_liq = "livePair.liquidity > 0 && livePair.liquidity < 10000"
if old_liq in content:
    content = content.replace(old_liq, new_liq)
    content = content.replace("liq < $3K", "liq < $10K")
    fixes.append('Liquidity floor: $10K (was $3K)')

# ═══════════════════════════════════════════════════════════
# 2. PARTIAL TAKE-PROFIT + TRAILING STOP
# ═══════════════════════════════════════════════════════════

# Add partialSold field to position interface
old_interface = "  engineForceEvict?: boolean;"
new_interface = """  engineForceEvict?: boolean;
  partialSold?: boolean;
  trailingStopPct?: number;"""
if old_interface in content:
    content = content.replace(old_interface, new_interface, 1)
    fixes.append('Added partialSold and trailingStopPct to position interface')

# Replace the rigid 100% exit with partial TP logic
old_sell = "      const sellFraction = 1.0; // Rigid 100% exit"
new_sell = """      // Partial TP: sell 50% at +6%, trail rest to +12%
      let sellFraction = 1.0;
      if (tpHit && !pos.partialSold) {
        // First TP hit: sell 50%, set trailing stop
        sellFraction = 0.5;
        pos.partialSold = true;
        pos.trailingStopPct = 4; // trail 4% from peak for remaining
        console.log('[SNIPER] 🎯 PARTIAL TP: selling 50% of ' + pos.symbol + ' at +' + pnlPct.toFixed(1) + '%');
      } else if (pos.partialSold && pnlPct < (peak - (pos.trailingStopPct || 4))) {
        // Trailing stop hit on remaining position
        sellFraction = 1.0;
        console.log('[SNIPER] 📉 TRAIL STOP: selling remaining ' + pos.symbol + ' (peak: +' + peak.toFixed(1) + '%, now: +' + pnlPct.toFixed(1) + '%)');
      } else if (pos.partialSold && !tpHit && !slHit && !timeHit && !forceExit) {
        // Still has remaining position, not hitting any exit — skip
        continue;
      }"""
if old_sell in content:
    content = content.replace(old_sell, new_sell)
    fixes.append('Implemented partial TP: 50% at first TP, trail rest with 4% trailing stop')

# Lower TP1 to 6% for faster partial exits
# Change GLOBAL_TP from 12% to 6% for first partial
old_tp_env = "let GLOBAL_TP_PCT    = parseFloat(process.env.MAX_TP_PERCENT || '20') / 100;"
new_tp_env = "let GLOBAL_TP_PCT    = parseFloat(process.env.MAX_TP_PERCENT || '6') / 100; // TP1: +6% partial, trail rest"
if old_tp_env in content:
    content = content.replace(old_tp_env, new_tp_env)
    fixes.append('TP1 default: 6% (partial sell), trail rest from peak')

# ═══════════════════════════════════════════════════════════
# 3. CONSECUTIVE LOSS COOLDOWN
# ═══════════════════════════════════════════════════════════

# Add consecutive loss counter to store
old_store_stats = "totalPnlSol: 0, wins: 0, losses: 0"
new_store_stats = "totalPnlSol: 0, wins: 0, losses: 0, consecutiveLosses: 0, pausedUntil: 0"
if old_store_stats in content:
    content = content.replace(old_store_stats, new_store_stats)
    fixes.append('Added consecutiveLosses and pausedUntil to store')

# Add pause check at the start of trySnipe
old_trysnipe_start = "async function trySnipe(mint: string, symbol: string, volume1h: number, priceChg1h: number,"
pause_check = """// ── Loss Streak Cooldown ──────────────────────────────────────────────
function isLossStreakPaused(): boolean {
  if (store.stats.pausedUntil && Date.now() < store.stats.pausedUntil) {
    return true;
  }
  return false;
}

async function trySnipe(mint: string, symbol: string, volume1h: number, priceChg1h: number,"""
if old_trysnipe_start in content:
    content = content.replace(old_trysnipe_start, pause_check, 1)
    fixes.append('Added loss streak pause check function')

# Add pause check inside trySnipe (at the very start after the function signature)
old_circuit = '  if (buySol === 0) {'
new_circuit = """  // Loss streak check
  if (isLossStreakPaused()) {
    const remaining = Math.ceil((store.stats.pausedUntil - Date.now()) / 60000);
    console.log('[SNIPER] ⏸️ LOSS STREAK PAUSE: ' + remaining + 'min remaining after ' + store.stats.consecutiveLosses + ' consecutive losses');
    return;
  }

  if (buySol === 0) {"""
if old_circuit in content:
    content = content.replace(old_circuit, new_circuit, 1)
    fixes.append('Added loss streak pause at start of trySnipe')

# Track consecutive losses after sell
old_loss_track = "if (pnlSol < 0) {"
# Find the one in the sell block (after realizedSol)
idx = content.find("store.stats.totalPnlSol += pnlSol;")
if idx > -1:
    # Find the next occurrence of our target after that point
    loss_idx = content.find(old_loss_track, idx)
    if loss_idx > -1 and loss_idx < idx + 500:
        old_block = content[loss_idx:loss_idx + len(old_loss_track)]
        new_block = """if (pnlSol < 0) {
              store.stats.consecutiveLosses = (store.stats.consecutiveLosses || 0) + 1;
              if (store.stats.consecutiveLosses >= 3) {
                store.stats.pausedUntil = Date.now() + 15 * 60 * 1000; // 15 min pause
                console.log('[SNIPER] ⛔ 3 CONSECUTIVE LOSSES — pausing for 15 minutes');
              }"""
        content = content[:loss_idx] + new_block + content[loss_idx + len(old_loss_track):]
        fixes.append('Track consecutive losses: 3 in a row = 15min pause')

# Reset streak on win
old_win = 'console.log(`[SNIPER]'
# Find the WIN log
win_idx = content.find("WIN on ${pos.symbol}")
if win_idx > -1:
    # Add streak reset before it
    win_line_start = content.rfind('\n', 0, win_idx) + 1
    indent = '              '
    content = content[:win_line_start] + indent + 'store.stats.consecutiveLosses = 0;\n' + content[win_line_start:]
    fixes.append('Reset consecutive losses on win')

with open(path, 'w') as f:
    f.write(content)

for f in fixes:
    print('  OK ' + f)
print('Applied ' + str(len(fixes)) + ' fixes')
