path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    code = f.read()

fixes = []

# 1. Add GLOBAL_OVERBOUGHT_CEILING variable that config:update can set
old_globals = "let GLOBAL_SL_PCT    = guardParam('STOP_LOSS');"
new_globals = """let GLOBAL_SL_PCT    = guardParam('STOP_LOSS');
let GLOBAL_OB_CEILING = 150; // Overbought ceiling % — Gemma4 can tighten this"""

if 'GLOBAL_OB_CEILING' not in code:
    code = code.replace(old_globals, new_globals)
    fixes.append('Added GLOBAL_OB_CEILING variable')

# 2. Wire config:update to update the ceiling
# Find where config:update sets GLOBAL_TP_PCT and add ceiling update
old_update = "GLOBAL_TP_PCT = cfg.maxTPpct * 100;"
new_update = """GLOBAL_TP_PCT = cfg.maxTPpct * 100;
          if (cfg.overboughtCeiling) GLOBAL_OB_CEILING = cfg.overboughtCeiling;"""

if 'overboughtCeiling' not in code:
    code = code.replace(old_update, new_update)
    fixes.append('Wired config:update to set GLOBAL_OB_CEILING')

# 3. Replace hardcoded 150 in the overbought check with GLOBAL_OB_CEILING
old_check = "livePair.priceChange5m > 150)"
new_check = "livePair.priceChange5m > GLOBAL_OB_CEILING)"
code = code.replace(old_check, new_check)
fixes.append('Replaced hardcoded 150 with GLOBAL_OB_CEILING')

old_log = "ceiling: 150%"
new_log = "ceiling: ' + GLOBAL_OB_CEILING + '%"
if 'ceiling: 150%' in code:
    code = code.replace(old_log, new_log)
    fixes.append('Updated ceiling log to show dynamic value')

# 4. Also update the Gemma4 refiner to push overbought_ceiling in config:update
refiner_path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/gemma4_auto_refiner.py'
with open(refiner_path) as f:
    rcode = f.read()

# Add overbought_ceiling to the Redis push
old_push = '"maxHoldMinutes": recs.get("max_hold_minutes", 5)'
new_push = '"maxHoldMinutes": recs.get("max_hold_minutes", 5),\n            "overboughtCeiling": recs.get("overbought_ceiling", 150)'

if 'overboughtCeiling' not in rcode:
    rcode = rcode.replace(old_push, new_push)
    fixes.append('Gemma4 now pushes overboughtCeiling in config:update')

# 5. Also add signals/trade_journal write back
old_write = "    // Also write to root journal for long-term tracking"
new_write = """    // Write to signals journal
    fs.appendFileSync(path.join(__dirname, '../../signals/trade_journal.jsonl'), line, 'utf-8');
    // Also write to root journal for long-term tracking"""
if code.count("signals/trade_journal.jsonl") == 0:
    code = code.replace(old_write, new_write)
    fixes.append('Restored signals/trade_journal.jsonl write')

with open(path, 'w') as f:
    f.write(code)
with open(refiner_path, 'w') as f:
    f.write(rcode)

print('FIXES APPLIED:')
for fix in fixes:
    print(f'  ✅ {fix}')
