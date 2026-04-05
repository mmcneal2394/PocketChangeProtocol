path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

# Add config:update handler after the VELOCITY_SPIKE handler
old_removed = "    // ENGINE_FORCE_SELL handler: REMOVED"
new_handler = """    // ENGINE_FORCE_SELL handler: REMOVED
    else if (ch === CHANNELS.CONFIG_UPDATE) {
      try {
        const params = JSON.parse(msg);
        if (params.maxTPpct) {
          GLOBAL_TP_PCT = parseFloat(params.maxTPpct);
          console.log('[SNIPER] ⚙️ GEMMA4 UPDATE: TP=' + (GLOBAL_TP_PCT*100).toFixed(1) + '%');
        }
        if (params.stopLossPct) {
          GLOBAL_SL_PCT = parseFloat(params.stopLossPct);
          console.log('[SNIPER] ⚙️ GEMMA4 UPDATE: SL=' + (GLOBAL_SL_PCT*100).toFixed(1) + '%');
        }
        if (params.maxHoldMinutes) {
          GLOBAL_HOLD_MIN = parseFloat(params.maxHoldMinutes);
          console.log('[SNIPER] ⚙️ GEMMA4 UPDATE: HOLD=' + GLOBAL_HOLD_MIN + 'min');
        }
        if (params.dynamicMinMom1m) {
          console.log('[SNIPER] ⚙️ GEMMA4 UPDATE: MIN_MOM=' + params.dynamicMinMom1m + '%');
        }
      } catch (e) {
        console.error('[SNIPER] config:update parse error:', e);
      }
    }"""

if old_removed in content:
    content = content.replace(old_removed, new_handler, 1)
    print('OK Added config:update handler for Gemma4 live parameter updates')

with open(path, 'w') as f:
    f.write(content)
