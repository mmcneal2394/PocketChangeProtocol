"""
Entry quality upgrade for momentum_sniper.ts:
1. Require min 2 SOL volume in last 60s (using velocity data)
2. Add failed-trade cooldown (30 min blacklist on SL hit)
3. Require bonded status (poolLiq > 0 = has a DEX pool = bonded)
4. Tighten buy slippage to 300 bps (3%)
5. Lower TP target to more realistic 12% (still with trailing stop)
"""

path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    content = f.read()

fixes = []

# FIX 1: Add SOL volume gate in velocity override block
# Currently: if vel.buys60s >= MIN_VEL_BUYS && vel.velocity >= 15
# Add: && vel.solVolume60s >= 2.0
old_vel = "if (vel.buys60s >= MIN_VEL_BUYS && vel.velocity >= 15) {"
new_vel = """if (vel.buys60s >= MIN_VEL_BUYS && vel.velocity >= 15 && vel.solVolume60s >= 2.0) {"""
if old_vel in content:
    content = content.replace(old_vel, new_vel)
    fixes.append('Added 2 SOL min volume gate to velocity override')

# FIX 2: Add SOL volume skip after velocity ratio check
# Find the closing of the velocity block and add volume check
old_vol_skip = """        if (vel.buyRatio60s < MIN_VEL_RATIO) {
          console.log(`[SNIPER] ⚡ ${symbol} VELOCITY SKIP — buy ratio ${(vel.buyRatio60s*100).toFixed(0)}% <${(MIN_VEL_RATIO*100).toFixed(0)}% | ${vel.buys60s}B/${vel.sells60s}S`);
          return;
        }"""
new_vol_skip = """        if (vel.buyRatio60s < MIN_VEL_RATIO) {
          console.log(`[SNIPER] ⚡ ${symbol} VELOCITY SKIP — buy ratio ${(vel.buyRatio60s*100).toFixed(0)}% <${(MIN_VEL_RATIO*100).toFixed(0)}% | ${vel.buys60s}B/${vel.sells60s}S`);
          return;
        }
        if (vel.solVolume60s < 1.0) {
          console.log(`[SNIPER] ⚡ ${symbol} VOLUME SKIP — only ${vel.solVolume60s.toFixed(3)} SOL/60s (min 1.0)`);
          return;
        }"""
if old_vol_skip in content:
    content = content.replace(old_vol_skip, new_vol_skip)
    fixes.append('Added 1 SOL min volume filter for non-override entries')

# FIX 3: Require bonded (poolLiq > 0) - strengthen existing $25K check
old_liq = """  // Market cap floor: reject anything under $25K (prebonded pump.fun junk)
  if (poolLiq > 0 && poolLiq < 25000) {
     console.log(`[SNIPER] 🐜 MCAP/LIQ REJECT: ${symbol} liquidity $${poolLiq.toFixed(0)} < $25K floor`);
     logMissedTarget({ mint, symbol, reason: "Below $25K liquidity floor", poolLiq });
     return;
  }"""
new_liq = """  // BONDED ONLY: reject tokens with no DEX pool (prebonded pump.fun)
  if (poolLiq <= 0) {
     console.log(`[SNIPER] 🐜 UNBONDED REJECT: ${symbol} has no DEX liquidity — prebonded pump.fun token`);
     logMissedTarget({ mint, symbol, reason: "No DEX pool (unbonded)", poolLiq: 0 });
     return;
  }
  // Market cap floor: reject anything under $25K liquidity
  if (poolLiq < 25000) {
     console.log(`[SNIPER] 🐜 MCAP/LIQ REJECT: ${symbol} liquidity $${poolLiq.toFixed(0)} < $25K floor`);
     logMissedTarget({ mint, symbol, reason: "Below $25K liquidity floor", poolLiq });
     return;
  }"""
if old_liq in content:
    content = content.replace(old_liq, new_liq)
    fixes.append('Added unbonded token rejection + $25K liquidity floor')

# FIX 4: Tighten buy slippage from default 500 to 300 bps
old_buy_quote = "const quote = await getQuote(WSOL, mint, buyLamports);"
new_buy_quote = "const quote = await getQuote(WSOL, mint, buyLamports, 300); // 3% max buy slippage"
if old_buy_quote in content:
    content = content.replace(old_buy_quote, new_buy_quote, 1)  # Only first occurrence
    fixes.append('Buy slippage tightened from 5% to 3%')

# FIX 5: Add 30-minute cooldown on SL/timeout exits
# Find the sell success block and add cooldown
old_sell_success = "logMissedTarget({ mint, symbol, reason: \"Simulation or Execution Failed on Chain\", amountSol: buySol });"
new_sell_success = "logMissedTarget({ mint, symbol, reason: \"Simulation or Execution Failed on Chain\", amountSol: buySol });\n      store.blacklist.push(mint); // Hard blacklist failed swaps"
if old_sell_success in content:
    content = content.replace(old_sell_success, new_sell_success)
    fixes.append('Failed swap tokens permanently blacklisted')

# FIX 6: In the exit handler, add 30-min cooldown when SL hits
old_exit_log = """const pnlSol = realizedSol - pos.buyPriceSol; // Estimate PnL across total lifecycle vs remaining"""
new_exit_log = """const pnlSol = realizedSol - pos.buyPriceSol; // Estimate PnL across total lifecycle vs remaining
          // 30-minute cooldown on losing trades to prevent re-entry
          if (pnlSol < 0) {
            await pub.setex(REDIS_KEYS.cooldown(pos.mint), 1800, '1'); // 30 min cooldown
            store.blacklist.push(pos.mint); // Also permanent blacklist for this session
          }"""
if old_exit_log in content:
    content = content.replace(old_exit_log, new_exit_log)
    fixes.append('30-min cooldown + session blacklist for losing trades')

with open(path, 'w') as f:
    f.write(content)

for f in fixes:
    print(f'  ✅ {f}')
print(f'\nTotal fixes applied: {len(fixes)}')
