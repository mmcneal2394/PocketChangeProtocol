import os

BASE = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot'
SNIPER = os.path.join(BASE, 'scripts', 'maintain', 'momentum_sniper.ts')
REFINER = os.path.join(BASE, 'scripts', 'maintain', 'gemma4_auto_refiner.py')

# ═══════════════════════════════════════════════════════════════
# STEP 1: Sniper publishes "gemma4:refine" on loss streak
# ═══════════════════════════════════════════════════════════════
print('=== STEP 1: Add loss-streak trigger to sniper ===')
with open(SNIPER) as f:
    code = f.read()

old_pause = "                store.stats.pausedUntil = Date.now() + 15 * 60 * 1000; // 15 min pause"
new_pause = """                store.stats.pausedUntil = Date.now() + 15 * 60 * 1000; // 15 min pause
                // Trigger Gemma4 to refine immediately during the pause
                try {
                  const pub = RedisBus.getPublisher();
                  pub.publish('gemma4:refine', JSON.stringify({
                    trigger: 'LOSS_STREAK',
                    consecutiveLosses: store.stats.consecutiveLosses,
                    totalPnlSol: store.stats.totalPnlSol,
                    ts: Date.now(),
                  }));
                  console.log('[SNIPER] 🧠 Triggered Gemma4 refinement (loss streak: ' + store.stats.consecutiveLosses + ')');
                } catch {}"""

if 'gemma4:refine' not in code:
    code = code.replace(old_pause, new_pause)
    print('  Added gemma4:refine publish on loss streak')
else:
    print('  Already present')

with open(SNIPER, 'w') as f:
    f.write(code)

# ═══════════════════════════════════════════════════════════════
# STEP 2: Gemma4 listens for "gemma4:refine" via Redis
# ═══════════════════════════════════════════════════════════════
print('\n=== STEP 2: Add Redis listener to Gemma4 refiner ===')
with open(REFINER) as f:
    rcode = f.read()

# Add a Redis subscriber thread that triggers run_cycle() on demand
redis_listener = '''
# ── LOSS-STREAK TRIGGERED REFINEMENT ──────────────────────────────────────────
import threading, subprocess as _sp

def redis_listener():
    """Listen for gemma4:refine events from the sniper."""
    import time as _time
    while True:
        try:
            # Use redis-cli SUBSCRIBE in blocking mode
            proc = _sp.Popen(
                ['redis-cli', 'SUBSCRIBE', 'gemma4:refine'],
                stdout=_sp.PIPE, stderr=_sp.PIPE, text=True
            )
            for line in proc.stdout:
                line = line.strip()
                if line.startswith('{'):
                    print(f'\\n[GEMMA4] 🧠 LOSS STREAK TRIGGER received: {line[:80]}')
                    print('[GEMMA4] Running emergency refinement cycle...')
                    run_cycle()
        except Exception as e:
            print(f'[GEMMA4] Redis listener error: {e}')
            _time.sleep(5)

# Start listener thread
listener_thread = threading.Thread(target=redis_listener, daemon=True)
listener_thread.start()
print('[GEMMA4] 🧠 Loss-streak listener active on gemma4:refine channel')
'''

if 'redis_listener' not in rcode:
    # Insert before the main loop
    rcode = rcode.replace(
        "# ─── Main loop",
        redis_listener + "\n# ─── Main loop"
    )
    print('  Added Redis loss-streak listener thread')
else:
    print('  Already present')

with open(REFINER, 'w') as f:
    f.write(rcode)

print('\n=== DONE ===')
print('  Sniper → publishes gemma4:refine on 3+ loss streak')
print('  Gemma4 → listens, runs immediate refinement cycle')
print('  Result: tighter filters pushed DURING the 15min pause')
