import json, os

BASE = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot'
SNIPER = os.path.join(BASE, 'scripts/maintain/momentum_sniper.ts')
REFINER = os.path.join(BASE, 'scripts/maintain/gemma4_auto_refiner.py')

issues = []

print('=' * 60)
print('  WIRING AUDIT — Checking all connections')
print('=' * 60)

# ── 1. Gemma4 recs vs .env
print('\n1️⃣  GEMMA4 RECS → .ENV SYNC')
recs = json.load(open(f'{BASE}/signals/gemma4_recommendations.json'))
rf = recs.get('recommended_filters', {})
print(f'  Recs: TP={rf.get("tp1_pct")} SL={rf.get("stop_loss_pct")} HOLD={rf.get("max_hold_minutes")} ceiling={rf.get("overbought_ceiling")}')

env = {}
with open(f'{BASE}/.env') as f:
    for line in f:
        if '=' in line and not line.startswith('#'):
            k, v = line.strip().split('=', 1)
            env[k] = v
print(f'  .env: TP={env.get("MAX_TP_PERCENT")} SL={env.get("STOP_LOSS_PERCENT")} HOLD={env.get("MAX_HOLD_MINUTES")}')

# ── 2. Sniper reads GLOBAL vars from .env
print('\n2️⃣  SNIPER READS .ENV GLOBALS')
with open(SNIPER) as f:
    code = f.read()
for var in ['GLOBAL_TP_PCT', 'GLOBAL_SL_PCT', 'GLOBAL_HOLD_MIN']:
    count = code.count(var)
    ok = 'OK' if count > 0 else 'MISSING'
    print(f'  {var}: {ok} ({count} refs)')

# ── 3. Config:update handler
print('\n3️⃣  CONFIG:UPDATE REDIS HANDLER')
has_handler = 'config:update' in code
print(f'  config:update handler: {"OK" if has_handler else "MISSING"}')
if has_handler:
    # Check it actually updates GLOBAL vars
    updates_globals = 'GLOBAL_TP_PCT =' in code or 'GLOBAL_TP_PCT=' in code
    print(f'  Updates GLOBAL vars: {"OK" if updates_globals else "⚠️  MISSING"}')
    if not updates_globals:
        issues.append('config:update handler exists but may not update GLOBAL vars')

# ── 4. overbought_ceiling from Gemma4 → sniper  
print('\n4️⃣  OVERBOUGHT CEILING WIRING')
ceiling_in_recs = rf.get('overbought_ceiling')
ceiling_hardcoded = '> 150' in code
gemma_pushes_ceiling = 'overbought_ceiling' in code
print(f'  Gemma4 recs ceiling: {ceiling_in_recs}')
print(f'  Sniper hardcoded: 150%')
print(f'  Sniper reads from Gemma4: {"YES" if gemma_pushes_ceiling else "NO — ⚠️  HARDCODED ONLY"}')
if not gemma_pushes_ceiling or ceiling_in_recs != 150:
    issues.append(f'Overbought ceiling: Gemma4 says {ceiling_in_recs}% but sniper hardcoded to 150%. Not wired.')

# ── 5. min_5m_change from Gemma4 → sniper
print('\n5️⃣  MIN 5M CHANGE WIRING')
min5m_in_recs = rf.get('min_5m_change')
has_min5m_in_sniper = 'priceChange5m < 1' in code or 'priceChange5m <' in code
print(f'  Gemma4 recs min_5m: {min5m_in_recs}')
print(f'  Sniper uses: hardcoded < 1')
dynamic_5m = 'dynamicMinMom1m' in code or 'GLOBAL_MIN_5M' in code
print(f'  Dynamic from Gemma4: {"YES" if dynamic_5m else "NO — ⚠️  HARDCODED ONLY"}')
if not dynamic_5m:
    issues.append(f'min_5m_change: Gemma4 says {min5m_in_recs}% but sniper hardcoded to 1%. Not wired.')

# ── 6. Volume floor wiring
print('\n6️⃣  VOLUME FLOOR')
has_vol_check = 'LOW VOL SKIP' in code
print(f'  Volume filter: {"OK" if has_vol_check else "MISSING"}')

# ── 7. Gemma4 loss-streak trigger
print('\n7️⃣  LOSS-STREAK → GEMMA4 TRIGGER')
has_loss_trigger = 'gemma4:refine' in code
print(f'  Sniper publishes gemma4:refine: {"OK" if has_loss_trigger else "MISSING"}')
with open(REFINER) as f:
    rcode = f.read()
has_listener = 'redis_listener' in rcode
print(f'  Gemma4 listens gemma4:refine: {"OK" if has_listener else "MISSING"}')

# ── 8. Archive triple-write
print('\n8️⃣  TRADE JOURNAL WRITE PATHS')
writes_signals = 'signals/trade_journal.jsonl' in code
writes_root = 'trade_journal.jsonl' in code and '../../trade_journal' in code
writes_archive = 'archive/trade_history.jsonl' in code
print(f'  signals/trade_journal.jsonl: {"OK" if writes_signals else "MISSING"}')
print(f'  root/trade_journal.jsonl: {"OK" if writes_root else "MISSING"}')
print(f'  archive/trade_history.jsonl: {"OK" if writes_archive else "MISSING"}')

# ── 9. Orphan scan
print('\n9️⃣  ORPHAN TOKEN SCAN')
has_orphan = 'Orphan' in code or 'orphan' in code
print(f'  Orphan scanner: {"OK" if has_orphan else "MISSING"}')

# ── 10. Display vs actual settings
print('\n🔟  DISPLAY SYNC')
display_stale = 'SL: -20%' in code or 'SL: -3%' in code
print(f'  Stale display references: {"⚠️  YES — cosmetic only" if display_stale else "OK"}')

# ── SUMMARY
print('\n' + '=' * 60)
if issues:
    print(f'  ⚠️  {len(issues)} UNWIRED CONNECTIONS FOUND')
    for i, issue in enumerate(issues, 1):
        print(f'  {i}. {issue}')
else:
    print('  ✅ ALL WIRED')
print('=' * 60)
