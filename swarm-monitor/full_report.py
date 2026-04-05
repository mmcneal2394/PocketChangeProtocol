import json

# Session stats
try:
    d = json.load(open('/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/sniper_positions.json'))
    s = d.get('stats', {})
    print('=== SESSION STATS ===')
    print(json.dumps(s, indent=2))
    print(f'Open positions: {len(d.get("positions",[]))}')
except Exception as e:
    print(f'Stats error: {e}')

# Journal analysis
print('\n=== JOURNAL ANALYSIS ===')
JOURNAL = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/trade_journal.jsonl'
trades = []
with open(JOURNAL) as f:
    for line in f:
        line = line.strip()
        if line:
            try: trades.append(json.loads(line))
            except: pass

buys = [t for t in trades if t.get('side') == 'BUY']
sells = [t for t in trades if t.get('side') == 'SELL']
print(f'Total entries: {len(trades)}')
print(f'Buys: {len(buys)} | Sells: {len(sells)}')

# Pair and analyze
pairs = []
for sell in sells:
    buy_id = sell.get('parentBuyId', '')
    buy = next((b for b in buys if b.get('tradeId') == buy_id), None)
    if buy:
        sell_out = sell.get('amountOut', 0) or 0
        pnl = sell_out - buy.get('amountIn', 0)
        pairs.append({
            'pnl': pnl,
            'pnl_pct': (pnl / buy['amountIn'] * 100) if buy.get('amountIn') else 0,
            'success': sell.get('success', False),
            'ts': sell.get('timestamp', 0),
        })

wins = [p for p in pairs if p['pnl'] > 0]
losses = [p for p in pairs if p['pnl'] <= 0]
failed = [p for p in pairs if not p.get('success')]
total_pnl = sum(p['pnl'] for p in pairs)

print(f'\nPaired: {len(pairs)} | Wins: {len(wins)} | Losses: {len(losses)}')
print(f'Win rate: {len(wins)/max(len(pairs),1)*100:.0f}%')
print(f'Total PnL: {total_pnl:.6f} SOL')
print(f'Failed sells: {len(failed)} ({len(failed)/max(len(pairs),1)*100:.0f}%)')
if wins: print(f'Avg win: +{sum(p["pnl"] for p in wins)/len(wins):.6f} SOL')
if losses: print(f'Avg loss: {sum(p["pnl"] for p in losses)/len(losses):.6f} SOL')

# Last 5 paired trades
print('\n=== LAST 5 TRADES ===')
for p in pairs[-5:]:
    icon = 'W' if p['pnl'] > 0 else 'L'
    print(f'  {icon} | {p["pnl"]:+.6f} SOL ({p["pnl_pct"]:+.1f}%) | sell_ok={p["success"]}')
