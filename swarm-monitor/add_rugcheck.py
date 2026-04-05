path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

fixes = []

# Add RugCheck function next to the DexScreener one
rugcheck_fn = """
// ── RugCheck.xyz Security Pre-Flight (Free, No API Key) ───────────────────
async function checkRugSafety(mint: string): Promise<{safe: boolean, riskLevel: string, score: number}> {
  try {
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { safe: true, riskLevel: 'UNKNOWN', score: 0 }; // fail-open
    const data = await res.json() as any;
    const score = data.score || 0;
    const risks = data.risks || [];
    const riskLevel = data.tokenMeta?.riskLevel || (score > 500 ? 'Good' : score > 200 ? 'Warn' : 'Danger');
    // Block tokens with danger-level risks
    const hasDanger = risks.some((r: any) => r.level === 'danger' || r.level === 'critical');
    const isMintable = risks.some((r: any) => r.name?.includes('Mint Authority'));
    const isFreezable = risks.some((r: any) => r.name?.includes('Freeze Authority'));
    return { safe: !hasDanger && !isMintable, riskLevel, score };
  } catch { return { safe: true, riskLevel: 'UNKNOWN', score: 0 }; }
}
"""

marker = 'async function fetchDexScreenerPair'
if marker in content:
    idx = content.index(marker)
    line_start = content.rfind('\n', 0, idx)
    content = content[:line_start] + rugcheck_fn + content[line_start:]
    fixes.append('Added checkRugSafety() function (RugCheck.xyz free API)')

# Add RugCheck call right before the mayhem check (which is right before getQuote)
old_mayhem = "  // MAYHEM MODE FILTER: Token-2022 tokens cannot be sold on pump.fun bonding curve"
new_mayhem = """  // RUGCHECK SECURITY PRE-FLIGHT
  const rugResult = await checkRugSafety(mint);
  if (!rugResult.safe) {
    console.log(`[SNIPER] 🚨 RUGCHECK REJECT: ${symbol} — ${rugResult.riskLevel} (score: ${rugResult.score}) — honeypot/mintable risk`);
    logMissedTarget({ mint, symbol, reason: 'RugCheck: ' + rugResult.riskLevel, poolLiq });
    store.blacklist.push(mint);
    await pub.setex(REDIS_KEYS.cooldown(mint), 3600, '1'); // 1hr blacklist
    return;
  }

  // MAYHEM MODE FILTER: Token-2022 tokens cannot be sold on pump.fun bonding curve"""

if old_mayhem in content:
    # Only replace the first occurrence (there should only be 1 now)
    content = content.replace(old_mayhem, new_mayhem, 1)
    fixes.append('Added RugCheck pre-flight before buy execution')

with open(path, 'w') as f:
    f.write(content)

for f in fixes:
    print(f'  OK {f}')
print(f'Applied {len(fixes)} fixes')
