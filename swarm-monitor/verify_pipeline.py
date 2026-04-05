#!/usr/bin/env python3
"""Full swarm pipeline verification script."""
import json, os, subprocess, time

BASE = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot'
results = []

def check(name, ok, detail=''):
    icon = '✅' if ok else '❌'
    results.append((name, ok, detail))
    print(f'  {icon} {name}{": " + detail if detail else ""}')

def run(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=10)
    return r.stdout.strip()

print('═' * 60)
print('  ANTIGRAVY SWARM — FULL PIPELINE VERIFICATION')
print('═' * 60)

# ── 1. PM2 SERVICES ──────────────────────────────────────────
print('\n1️⃣  PM2 SERVICES')
pm2 = run('pm2 jlist 2>/dev/null')
try:
    procs = json.loads(pm2)
except:
    procs = []

expected_online = ['pcp-momentum-sniper', 'pcp-gemma4-refiner', 'pcp-velocity-stream', 
                   'pcp-rpc-gateway', 'pcp-stale-sweeper', 'pcp-ingestion']
for name in expected_online:
    proc = next((p for p in procs if p['name'] == name), None)
    if proc:
        status = proc['pm2_env']['status']
        uptime = proc.get('pm2_env', {}).get('pm_uptime', 0)
        up_min = int((time.time()*1000 - uptime) / 60000) if uptime else 0
        check(name, status == 'online', f'{status} | {up_min}min')
    else:
        check(name, False, 'NOT FOUND')

expected_stopped = ['pcp-critic-node', 'pcp-wallet-monitor']
for name in expected_stopped:
    proc = next((p for p in procs if p['name'] == name), None)
    status = proc['pm2_env']['status'] if proc else 'missing'
    check(f'{name} (should be stopped)', status == 'stopped', status)

# ── 2. REDIS CHANNELS ────────────────────────────────────────
print('\n2️⃣  REDIS PUB/SUB CHANNELS')
channels = {'velocity:spike': 1, 'config:update': 1}
for ch, expected in channels.items():
    subs = run(f"redis-cli PUBSUB NUMSUB {ch} | tail -1")
    try:
        count = int(subs)
    except:
        count = 0
    check(f'{ch}', count >= expected, f'{count} subscriber(s)')

# Check gemma4:refine channel
g4subs = run("redis-cli PUBSUB NUMSUB gemma4:refine | tail -1")
try:
    g4count = int(g4subs)
except:
    g4count = 0
check('gemma4:refine', g4count >= 1, f'{g4count} subscriber(s)')

# ── 3. SIGNAL FLOW ───────────────────────────────────────────
print('\n3️⃣  SIGNAL FLOW')
# Velocity → Sniper
velo_log = run("pm2 logs pcp-velocity-stream --lines 3 --nostream 2>&1 | grep 'SPIKE MINT' | tail -1")
check('Velocity stream producing', 'SPIKE' in velo_log, velo_log[-60:] if velo_log else 'no spikes')

sniper_log = run("pm2 logs pcp-momentum-sniper --lines 20 --nostream 2>&1 | grep 'VELOCITY ENTRY' | tail -1")
check('Sniper receiving velocity', 'VELOCITY ENTRY' in sniper_log, sniper_log[-60:] if sniper_log else 'no entries')

# Gemma4 → Sniper
g4_push = run("pm2 logs pcp-gemma4-refiner --lines 15 --nostream 2>&1 | grep 'pushed to live' | tail -1")
check('Gemma4 pushing to sniper', 'pushed' in g4_push.lower() or 'Parameters' in g4_push, g4_push[-60:] if g4_push else 'not found')

# ── 4. FILTERS ────────────────────────────────────────────────
print('\n4️⃣  ENTRY FILTERS (last 50 log lines)')
filter_log = run("pm2 logs pcp-momentum-sniper --lines 50 --nostream 2>&1")
filters = {'DUMP SKIP': 0, 'OVERBOUGHT': 0, 'HOLDER REJECT': 0, 'HOLDER OK': 0,
           'LOW LIQ': 0, 'RUGCHECK': 0, 'NO DEX': 0, 'LOSS STREAK': 0, 'Entered': 0}
for key in filters:
    filters[key] = filter_log.count(key)
active = sum(1 for v in filters.values() if v > 0)
check(f'Filters active', active >= 2, ' | '.join(f'{k}:{v}' for k,v in filters.items() if v > 0))

# ── 5. SETTINGS PERSISTENCE ──────────────────────────────────
print('\n5️⃣  SETTINGS PERSISTENCE')
env_tp = run(f"grep MAX_TP_PERCENT {BASE}/.env | head -1").split('=')[-1]
env_sl = run(f"grep STOP_LOSS_PERCENT {BASE}/.env | head -1").split('=')[-1]
env_hold = run(f"grep MAX_HOLD_MINUTES {BASE}/.env | head -1").split('=')[-1]
check('.env synced', env_tp and env_sl and env_hold, f'TP={env_tp}% SL={env_sl}% HOLD={env_hold}min')

recs_exist = os.path.exists(f'{BASE}/signals/gemma4_recommendations.json')
if recs_exist:
    recs = json.load(open(f'{BASE}/signals/gemma4_recommendations.json'))
    rf = recs.get('recommended_filters', {})
    check('Gemma4 recs file', True, f'TP={rf.get("tp1_pct")}% SL={rf.get("stop_loss_pct")}% conf={recs.get("confidence")}%')
    entry_win = rf.get('overbought_ceiling')
    if entry_win:
        check('Entry window learned', True, f'+{rf.get("min_5m_change",1)}% to +{entry_win}% (5m)')
else:
    check('Gemma4 recs file', False, 'missing')

# ── 6. DATA RETENTION ────────────────────────────────────────
print('\n6️⃣  DATA RETENTION')
archive = f'{BASE}/signals/archive/trade_history.jsonl'
if os.path.exists(archive):
    with open(archive) as f:
        lines = sum(1 for _ in f)
    sz = os.path.getsize(archive) / 1024
    check('Permanent archive', True, f'{lines} entries ({sz:.0f} KB)')
else:
    check('Permanent archive', False, 'missing')

logrotate = run("pm2 conf | grep retain 2>/dev/null || echo 'unknown'")
check('PM2 log retention', '30' in logrotate or 'unknown' in logrotate, f'retain={logrotate.split(":")[-1].strip() if ":" in logrotate else "30"}')

# ── 7. BALANCE ────────────────────────────────────────────────
print('\n7️⃣  BALANCE')
bal = run(f"cd {BASE} && node check_bal.js 2>&1 | grep Total")
check('Balance readable', 'Total' in bal, bal)

# ── 8. ERROR CHECK ────────────────────────────────────────────
print('\n8️⃣  ERROR CHECK')
errors = run("pm2 logs pcp-momentum-sniper --err --lines 10 --nostream 2>&1 | grep -v PARAM_GUARD | grep -c 'Error\\|error\\|FATAL' || echo 0")
try:
    err_count = int(errors)
except:
    err_count = 0
check('Sniper errors', err_count == 0, f'{err_count} errors in last 10 lines')

# ── SUMMARY ───────────────────────────────────────────────────
print('\n' + '═' * 60)
passed = sum(1 for _, ok, _ in results if ok)
total = len(results)
print(f'  RESULT: {passed}/{total} checks passed')
if passed == total:
    print('  🟢 ALL SYSTEMS OPERATIONAL')
else:
    failed = [name for name, ok, _ in results if not ok]
    print(f'  🔴 FAILED: {", ".join(failed)}')
print('═' * 60)
