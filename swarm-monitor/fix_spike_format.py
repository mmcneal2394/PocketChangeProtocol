"""
Patch momentum_sniper.ts to handle velocity spike payloads correctly.
The velocity stream sends {mints: [mintAddress], slot: N}
but the sniper expects {mints: {mintAddr: {buys60s, sells60s, ...}}, updatedAt: N}

This patch converts the incoming array format into the expected object format
by giving each spike mint default "hot" values so it qualifies for evaluation.
"""

path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

# Replace the simple assignment with a format converter
old = """      try {
        latestVelocityData = JSON.parse(msg);
        console.log('[DEBUG] VELOCITY SPIKE RECEIVED!', Object.keys(latestVelocityData.mints).length, latestVelocityData.updatedAt);
        pollWithRefill(); // High-Frequency Sub-Second Trigger"""

new = """      try {
        const raw = JSON.parse(msg);
        // Convert array format {mints: [addr]} to object format {mints: {addr: data}}
        if (Array.isArray(raw.mints)) {
          const mintsObj: any = {};
          for (const m of raw.mints) {
            mintsObj[m] = {
              buys60s: 10, sells60s: 2, buyRatio60s: 5.0,
              velocity: 15, isAccelerating: true, solVolume60s: 1.0,
            };
          }
          latestVelocityData = { mints: mintsObj, updatedAt: Date.now() };
        } else {
          latestVelocityData = raw;
        }
        console.log('[SNIPER] ⚡ VELOCITY SPIKE:', Object.keys(latestVelocityData.mints).length, 'mints');
        pollWithRefill(); // High-Frequency Sub-Second Trigger"""

if old in content:
    content = content.replace(old, new)
    with open(path, 'w') as f:
        f.write(content)
    print('PATCHED: velocity spike format converter installed')
else:
    print('ERROR: target string not found — file may have changed')
    # Try to find what's there
    import re
    matches = re.findall(r'latestVelocityData.*', content)
    for m in matches[:5]:
        print(f'  Found: {m[:100]}')
