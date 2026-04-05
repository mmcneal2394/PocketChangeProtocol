path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
with open(path) as f:
    code = f.read()

fixes = []

# 1. Add entryMom5m to position creation (line ~809 area)
# The position is created when a buy executes
old_pos = "peakPnlPct: 0, entryBuyRatio: buyRatio,"
new_pos = "peakPnlPct: 0, entryMom5m: mom5m, entryBuyRatio: buyRatio,"
if 'entryMom5m' not in code:
    code = code.replace(old_pos, new_pos)
    fixes.append('Added entryMom5m to position creation')

# 2. Add peakPnlPct and entryMom5m to SELL journal entries
# The main sell appendTrade (line ~935)
old_sell = "appendTrade({ agent: 'pcp-sniper', action: 'SELL', mint: pos.mint, symbol: pos.symbol, amountSol: realizedSol, pnlSol, sig: sellSig, reason, holdMs: heldMs, parentBuyId: pos.tradeId, tradeId });"
new_sell = "appendTrade({ agent: 'pcp-sniper', action: 'SELL', mint: pos.mint, symbol: pos.symbol, amountSol: realizedSol, pnlSol, sig: sellSig, reason, holdMs: heldMs, parentBuyId: pos.tradeId, tradeId, momentum5m: pos.entryMom5m, rsi: pos.peakPnlPct } as any);"
if 'momentum5m: pos.entryMom5m' not in code:
    code = code.replace(old_sell, new_sell)
    fixes.append('Added entryMom5m + peakPnlPct to SELL journal (uses rsi field for peak)')

# 3. Add entryMom5m to the position interface  
old_iface = "  peakPnlPct:     number;"
new_iface = "  peakPnlPct:     number;\n  entryMom5m?:    number;"
if 'entryMom5m?' not in code:
    code = code.replace(old_iface, new_iface)
    fixes.append('Added entryMom5m to position interface')

with open(path, 'w') as f:
    f.write(code)

for f in fixes:
    print('  OK ' + f)
print(f'Applied {len(fixes)} fixes')
