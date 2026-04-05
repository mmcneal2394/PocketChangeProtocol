import re

path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    code = f.read()

fixes = []

# 1. checkExits: 3s → 15s (saves 80% of exit-check RPC calls)
old = "  }, 3000);"
# Only replace the one after checkExits
code = code.replace(
    """     if (store.positions.length > 0) {
         checkExits().catch(e => console.error('[SNIPER/TELEMETRY] Panic dump telemetry exception:', e));
     }
  }, 3000);""",
    """     if (store.positions.length > 0) {
         checkExits().catch(e => console.error('[SNIPER/TELEMETRY] Panic dump telemetry exception:', e));
     }
  }, 15000); // Reduced from 3s to 15s to conserve Chainstack RPC quota"""
)
fixes.append('checkExits interval: 3s → 15s (80% RPC reduction)')

# 2. Add holder result cache to avoid repeated RPC calls for same mint
holder_cache = """
// ── HOLDER CACHE: avoid repeated Chainstack RPC calls for same mint ──────────
const holderCache = new Map<string, {safe: boolean, top10Pct: number, holderCount: number, ts: number}>();
const HOLDER_CACHE_TTL = 600_000; // 10 minutes
"""
if 'holderCache' not in code:
    # Insert before checkHolderConcentration function
    code = code.replace(
        'async function checkHolderConcentration(mint: string)',
        holder_cache + 'async function checkHolderConcentration(mint: string)'
    )
    
    # Add cache check at the start of the function
    code = code.replace(
        """async function checkHolderConcentration(mint: string): Promise<{safe: boolean, top10Pct: number, holderCount: number}> {
  try {""",
        """async function checkHolderConcentration(mint: string): Promise<{safe: boolean, top10Pct: number, holderCount: number}> {
  // Check cache first to avoid RPC calls
  const cached = holderCache.get(mint);
  if (cached && (Date.now() - cached.ts < HOLDER_CACHE_TTL)) {
    return { safe: cached.safe, top10Pct: cached.top10Pct, holderCount: cached.holderCount };
  }
  try {"""
    )
    
    # Cache the result before returning
    # Find the return statement in checkHolderConcentration
    code = code.replace(
        "    return { safe: top10Pct <= 80 && nonZeroHolders >= 3, top10Pct, holderCount: nonZeroHolders };",
        "    const result = { safe: top10Pct <= 80 && nonZeroHolders >= 3, top10Pct, holderCount: nonZeroHolders };\n    holderCache.set(mint, { ...result, ts: Date.now() });\n    return result;"
    )
    fixes.append('Added holder concentration cache (10min TTL, avoids repeat RPC)')

# 3. POLL_MS: keep at 60s (already reasonable)
# Just verify
if 'POLL_MS          = 60_000' in code:
    fixes.append('Poll interval already at 60s (good)')

# 4. Heartbeat: 30s → 120s
code = code.replace(
    "  }, 30000);",
    "  }, 120000); // Reduced heartbeat from 30s to 120s to save RPC"
)
fixes.append('Heartbeat interval: 30s → 120s')

with open(path, 'w') as f:
    f.write(code)

for f in fixes:
    print('  OK ' + f)
print(f'Applied {len(fixes)} fixes')
