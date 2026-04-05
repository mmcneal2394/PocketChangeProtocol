path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    code = f.read()

# Fix: the sed failed, so find the current state and replace it
# The velocity spike handler should call poll() instead of pollWithRefill()
# poll() processes velocity data. pollWithRefill() also does a full wallet refill scan.
old = "        // pollWithRefill(); // DISABLED"
if old in code:
    # Just keep it as a call to poll() — which uses the cached velocity data
    code = code.replace(old, "        poll().catch(() => {}); // Uses cached velocity data, no extra RPC refill sweep")
    print('OK: velocity spike triggers poll() instead of pollWithRefill()')
elif "pollWithRefill(); // High-Frequency" in code:
    code = code.replace(
        "pollWithRefill(); // High-Frequency Sub-Second Trigger",
        "poll().catch(() => {}); // Uses cached velocity data, no extra RPC refill sweep"
    )
    print('OK: replaced pollWithRefill with poll()')
else:
    print('Already patched or marker not found')

# Also reduce POLL_MS from 60s to 30s since we removed the spike-trigger
# This is a compromise: less aggressive per-spike but slightly faster background
code = code.replace(
    "const POLL_MS          = 60_000;",
    "const POLL_MS          = 30_000; // 30s poll — velocity spikes no longer trigger extra polls"
)
print('OK: POLL_MS 60s -> 30s (compensates for no spike-trigger)')

with open(path, 'w') as f:
    f.write(code)
