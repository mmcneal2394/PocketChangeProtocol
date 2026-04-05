path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

fixes = []

# ═══════════════════════════════════════════════════════════
# 1. ADD HOLDER CONCENTRATION CHECK FUNCTION (uses existing RPC gateway)
# ═══════════════════════════════════════════════════════════

holder_fn = '''
// ── Holder Concentration Check (RPC - no API key needed) ──────────────────
async function checkHolderConcentration(mint: string): Promise<{safe: boolean, top10Pct: number, holderCount: number}> {
  try {
    const largestAccounts = await callRpcGateway('getTokenLargestAccounts', [new PublicKey(mint)]);
    if (!largestAccounts?.value || largestAccounts.value.length === 0) {
      return { safe: false, top10Pct: 100, holderCount: 0 };
    }

    const supply = await callRpcGateway('getTokenSupply', [new PublicKey(mint)]);
    const totalSupply = Number(supply?.value?.amount || 0);
    if (totalSupply === 0) return { safe: false, top10Pct: 100, holderCount: 0 };

    // Top 10 holder concentration
    let top10Total = 0;
    const accounts = largestAccounts.value.slice(0, 10);
    for (const acct of accounts) {
      top10Total += Number(acct.amount || 0);
    }
    const top10Pct = (top10Total / totalSupply) * 100;

    // Holder count estimate: if all 20 returned accounts have tokens, likely 20+ holders
    const nonZeroHolders = largestAccounts.value.filter((a: any) => Number(a.amount) > 0).length;

    return {
      safe: top10Pct <= 50 && nonZeroHolders >= 5,
      top10Pct,
      holderCount: nonZeroHolders,
    };
  } catch (e) {
    return { safe: true, top10Pct: 0, holderCount: 0 }; // fail-open
  }
}
'''

# Insert after checkRugSafety function
marker = 'async function fetchDexScreenerPair'
if marker in content:
    idx = content.index(marker)
    line_start = content.rfind('\n', 0, idx)
    content = content[:line_start] + holder_fn + content[line_start:]
    fixes.append('Added checkHolderConcentration() function (RPC, no API key)')

# ═══════════════════════════════════════════════════════════
# 2. ADD HOLDER CHECK + MARKET CAP CHECK BEFORE BUY
# ═══════════════════════════════════════════════════════════

# Insert holder check right after RugCheck and before mayhem check
old_mayhem = "  // MAYHEM MODE FILTER: Token-2022 tokens cannot be sold on pump.fun bonding curve"
new_holder_check = """  // HOLDER CONCENTRATION CHECK: reject insider-controlled tokens
  const holderResult = await checkHolderConcentration(mint);
  if (!holderResult.safe) {
    console.log('[SNIPER] \\u{1f6ab} HOLDER REJECT: ' + symbol + ' — top10: ' + holderResult.top10Pct.toFixed(0) + '%, holders: ' + holderResult.holderCount);
    logMissedTarget({ mint, symbol, reason: 'Holder concentration ' + holderResult.top10Pct.toFixed(0) + '%', poolLiq });
    store.blacklist.push(mint);
    await pub.setex(REDIS_KEYS.cooldown(mint), 1800, '1'); // 30min blacklist
    return;
  }
  console.log('[SNIPER] \\u2705 HOLDER OK: ' + symbol + ' — top10: ' + holderResult.top10Pct.toFixed(0) + '%, holders: ' + holderResult.holderCount);

  // MARKET CAP CHECK: reject micro-cap dust tokens
  const liveMcap = await fetchDexScreenerPair(mint);
  if (liveMcap && liveMcap.liquidity < 10000) {
    console.log('[SNIPER] \\u{1f6ab} MCAP REJECT: ' + symbol + ' — liq $' + liveMcap.liquidity.toFixed(0) + ' < $10K');
    await pub.setex(REDIS_KEYS.cooldown(mint), 600, '1');
    return;
  }

  // MAYHEM MODE FILTER: Token-2022 tokens cannot be sold on pump.fun bonding curve"""

if old_mayhem in content:
    content = content.replace(old_mayhem, new_holder_check)
    fixes.append('Added holder concentration + market cap checks before buy')

with open(path, 'w') as f:
    f.write(content)

for f in fixes:
    print('  OK ' + f)
print('Applied ' + str(len(fixes)) + ' fixes')
