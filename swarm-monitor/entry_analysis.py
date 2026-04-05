import json, os

JOURNAL = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/trade_journal_combined.jsonl'

trades = []
with open(JOURNAL) as f:
    for line in f:
        line = line.strip()
        if line:
            try: trades.append(json.loads(line))
            except: pass

buys = [t for t in trades if t.get('action') == 'BUY']
sells = [t for t in trades if t.get('action') == 'SELL']

print(f'Total: {len(trades)} | Buys: {len(buys)} | Sells: {len(sells)}')
print()

# Show what data we have on buys
print('=== BUY ENTRY DATA (sample) ===')
for b in buys[-5:]:
    print(f'  mint: {b.get("mint","")[:12]}  mom5m: {b.get("momentum5m","?")}  mom1m: {b.get("momentum1m","?")}  sol: {b.get("amountSol",0):.4f}')

# Pair buys with sells and check entry momentum vs outcome
print()
print('=== ENTRY MOMENTUM VS OUTCOME ===')
pairs = []
for sell in sells:
    buy_id = sell.get('parentBuyId', '')
    buy = next((b for b in buys if b.get('tradeId') == buy_id), None)
    if buy:
        sell_out = sell.get('amountOut', 0) or 0
        pnl_pct = ((sell_out - buy.get('amountIn', 0)) / buy['amountIn'] * 100) if buy.get('amountIn') else 0
        pairs.append({
            'mom5m': buy.get('momentum5m'),
            'mom1m': buy.get('momentum1m'),
            'pnl_pct': pnl_pct,
            'win': pnl_pct > 0,
            'exit': sell.get('reason', ''),
            'success': sell.get('success', False),
        })

for p in pairs[-10:]:
    icon = 'W' if p['win'] else 'L'
    mom = f"5m:{p['mom5m']}" if p['mom5m'] is not None else "5m:?"
    print(f"  {icon} | {mom:>10} | PnL: {p['pnl_pct']:+.1f}% | exit: {p['exit']} | sellOK: {p['success']}")

# Bucket by entry momentum
print()
print('=== WIN RATE BY ENTRY MOMENTUM ===')
buckets = {'0-5%': [], '5-10%': [], '10-20%': [], '20-30%': [], '30%+': [], 'unknown': []}
for p in pairs:
    m = p['mom5m']
    if m is None:
        buckets['unknown'].append(p)
    elif m < 5:
        buckets['0-5%'].append(p)
    elif m < 10:
        buckets['5-10%'].append(p)
    elif m < 20:
        buckets['10-20%'].append(p)
    elif m < 30:
        buckets['20-30%'].append(p)
    else:
        buckets['30%+'].append(p)

for label, trades in buckets.items():
    if not trades:
        continue
    wins = sum(1 for t in trades if t['win'])
    avg_pnl = sum(t['pnl_pct'] for t in trades) / len(trades)
    print(f'  {label:>10}: {len(trades):>3} trades | {wins} wins ({wins/len(trades)*100:.0f}%) | avg PnL: {avg_pnl:+.1f}%')
