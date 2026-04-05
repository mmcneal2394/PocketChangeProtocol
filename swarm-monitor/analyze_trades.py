import json, os

journal_path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/trade_journal.jsonl'

wins = losses = 0
total_pnl = 0
reasons = {}
trades = []

with open(journal_path) as f:
    for line in f:
        try:
            t = json.loads(line.strip())
            if t.get('action') == 'SELL':
                pnl = t.get('pnlSol', 0)
                total_pnl += pnl
                reason = t.get('reason', 'unknown')
                symbol = t.get('symbol', '?')
                hold_ms = t.get('holdMs', 0)
                amount = t.get('amountSol', 0)
                
                if pnl >= 0:
                    wins += 1
                else:
                    losses += 1
                
                reasons[reason] = reasons.get(reason, 0) + 1
                trades.append({'symbol': symbol, 'pnl': pnl, 'reason': reason, 'holdMin': hold_ms/60000 if hold_ms else 0, 'amount': amount})
        except:
            pass

total = wins + losses
wr = wins / total * 100 if total else 0

print(f'=== TRADE JOURNAL STATS ===')
print(f'Total sells: {total}')
print(f'Wins: {wins} | Losses: {losses}')
print(f'Win rate: {wr:.0f}%')
print(f'Total PnL: {total_pnl:.6f} SOL (${total_pnl * 80:.2f})')
print(f'Avg PnL/trade: {total_pnl/total:.6f} SOL' if total else 'No trades')
print()

print('=== EXIT REASONS ===')
for r, c in sorted(reasons.items(), key=lambda x: -x[1]):
    print(f'  {r}: {c}')
print()

print('=== LAST 10 TRADES ===')
for t in trades[-10:]:
    emoji = '✅' if t['pnl'] >= 0 else '❌'
    print(f"  {emoji} {t['symbol']:12s} | {t['pnl']:+.6f} SOL | {t['holdMin']:.1f}m | {t['reason']}")
