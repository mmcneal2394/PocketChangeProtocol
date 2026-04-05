import json, re, os

BASE = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot'
SNIPER = os.path.join(BASE, 'scripts', 'maintain', 'momentum_sniper.ts')
REFINER = os.path.join(BASE, 'scripts', 'maintain', 'gemma4_auto_refiner.py')
ENV = os.path.join(BASE, '.env')
RECS = os.path.join(BASE, 'signals', 'gemma4_recommendations.json')

# ═══════════════════════════════════════════════════════════════════════
# STEP 1: Fix sniper to load Gemma 4 recommendations file on boot
# ═══════════════════════════════════════════════════════════════════════
print('=== STEP 1: Add Gemma4 boot loader to sniper ===')
with open(SNIPER) as f:
    code = f.read()

# Fix the dangerous fallback defaults
code = code.replace(
    "parseFloat(process.env.STOP_LOSS_PERCENT || '50')",
    "parseFloat(process.env.STOP_LOSS_PERCENT || '4')"
)
code = code.replace(
    "parseFloat(process.env.MAX_HOLD_MINUTES || '10')",
    "parseFloat(process.env.MAX_HOLD_MINUTES || '5')"
)
print('  Fixed dangerous fallback defaults (SL: 50->4, Hold: 10->5)')

# Add boot-time Gemma4 loading right after the GLOBAL declarations
boot_loader = """
// ── GEMMA4 BOOT LOADER: Apply last known recommendations on startup ──────────
try {
  const g4path = path.join(__dirname, '../../signals/gemma4_recommendations.json');
  if (fs.existsSync(g4path)) {
    const g4 = JSON.parse(fs.readFileSync(g4path, 'utf-8'));
    const rf = g4.recommended_filters || {};
    if (rf.tp1_pct) GLOBAL_TP_PCT = rf.tp1_pct / 100;
    if (rf.stop_loss_pct) GLOBAL_SL_PCT = rf.stop_loss_pct / 100;
    if (rf.max_hold_minutes) GLOBAL_HOLD_MIN = rf.max_hold_minutes;
    console.log(`[SNIPER] ⚙️ GEMMA4 BOOT: TP=${(GLOBAL_TP_PCT*100).toFixed(1)}% SL=${(GLOBAL_SL_PCT*100).toFixed(1)}% HOLD=${GLOBAL_HOLD_MIN}min (confidence: ${g4.confidence || 0}%)`);
  }
} catch (e: any) { console.log('[SNIPER] Gemma4 boot loader: no recs file or parse error'); }
"""

# Insert after the GLOBAL_HOLD_MIN declaration
marker = "let GLOBAL_HOLD_MIN  = parseFloat(process.env.MAX_HOLD_MINUTES || '5');"
if marker in code and '// ── GEMMA4 BOOT LOADER' not in code:
    code = code.replace(marker, marker + boot_loader)
    print('  Added Gemma4 boot loader')
else:
    print('  Gemma4 boot loader already present or marker not found')

with open(SNIPER, 'w') as f:
    f.write(code)

# ═══════════════════════════════════════════════════════════════════════
# STEP 2: Make Gemma4 refiner also update .env on each cycle
# ═══════════════════════════════════════════════════════════════════════
print('\n=== STEP 2: Make Gemma4 update .env on apply ===')
with open(REFINER) as f:
    rcode = f.read()

env_updater = '''
def update_env(filters):
    """Persist Gemma4 recommendations to .env so they survive restart."""
    env_path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/.env'
    try:
        with open(env_path) as f:
            env = f.read()
        
        mappings = {
            'MAX_TP_PERCENT': str(filters.get('tp1_pct', 6)),
            'STOP_LOSS_PERCENT': str(filters.get('stop_loss_pct', 4)),
            'MAX_HOLD_MINUTES': str(filters.get('max_hold_minutes', 5)),
        }
        
        for key, val in mappings.items():
            import re
            pattern = f'^{key}=.*$'
            replacement = f'{key}={val}'
            env = re.sub(pattern, replacement, env, flags=re.MULTILINE)
        
        with open(env_path, 'w') as f:
            f.write(env)
        print(f'  .env updated: {mappings}')
    except Exception as e:
        print(f'  .env update error: {e}')
'''

# Insert the update_env function and call it from apply_recommendations
if 'def update_env' not in rcode:
    # Add function before apply_recommendations
    rcode = rcode.replace(
        'def apply_recommendations(recs):',
        env_updater + '\ndef apply_recommendations(recs):'
    )
    
    # Call it when applying
    rcode = rcode.replace(
        "        print(f'  Redis PUBLISH config:update",
        "        update_env(filters)\n        print(f'  Redis PUBLISH config:update"
    )
    print('  Added .env persistence to Gemma4 refiner')
else:
    print('  .env persistence already present')

with open(REFINER, 'w') as f:
    f.write(rcode)

# ═══════════════════════════════════════════════════════════════════════
# STEP 3: Sync .env NOW with current Gemma4 recommendations
# ═══════════════════════════════════════════════════════════════════════
print('\n=== STEP 3: Sync .env with current Gemma4 recs ===')
recs = json.load(open(RECS))
rf = recs.get('recommended_filters', {})

with open(ENV) as f:
    env = f.read()

updates = {
    'MAX_TP_PERCENT': str(rf.get('tp1_pct', 6)),
    'STOP_LOSS_PERCENT': str(rf.get('stop_loss_pct', 4)),
    'MAX_HOLD_MINUTES': str(rf.get('max_hold_minutes', 5)),
}

for key, val in updates.items():
    env = re.sub(f'^{key}=.*$', f'{key}={val}', env, flags=re.MULTILINE)

with open(ENV, 'w') as f:
    f.write(env)

print(f'  .env synced: {updates}')

# Verify
print('\n=== VERIFICATION ===')
with open(ENV) as f:
    for line in f:
        if any(k in line for k in ['MAX_TP', 'STOP_LOSS', 'MAX_HOLD_MIN']):
            print(f'  {line.strip()}')
