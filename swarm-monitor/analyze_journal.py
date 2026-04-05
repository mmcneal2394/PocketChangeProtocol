import json, sys

journal = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/trade_journal.jsonl'
lines = open(journal).readlines()

buys, sells, pnls = [], [], []
for l in lines:
    l = l.strip()
    if not l: continue
    try:
        r = json.loads(l)
    except:
        continue
    if r.get('action') == 'BUY':
        buys.append(r)
    elif r.get('action') == 'SELL':
        sells.append(r)
        if r.get('pnlSol') is not None:
            pnls.append(r['pnlSol'])

wins = [p for p in pnls if p > 0]
losses = [p for p in pnls if p <= 0]
spent = sum(b.get('amountSol', 0) for b in buys)

print(f"=== TRADE JOURNAL SUMMARY ===")
print(f"Total entries: {len(lines)}")
print(f"Buys: {len(buys)} | Sells: {len(sells)}")
print(f"Total SOL deployed: {spent:.4f}")
print(f"---")
print(f"Sells with PnL data: {len(pnls)}")
print(f"Wins: {len(wins)} | Losses: {len(losses)}")
if pnls:
    print(f"Net PnL: {sum(pnls):.6f} SOL")
    print(f"Best trade: +{max(pnls):.6f} SOL")
    print(f"Worst trade: {min(pnls):.6f} SOL")
    print(f"Avg win: {sum(wins)/len(wins):.6f}" if wins else "No wins yet")
    print(f"Avg loss: {sum(losses)/len(losses):.6f}" if losses else "No losses")
    print(f"Win rate: {len(wins)/len(pnls)*100:.0f}%")
print()
print("=== LAST 8 SELLS ===")
for s in sells[-8:]:
    mint = s.get('mint', '')[:10]
    sol = s.get('amountSol', 0)
    pnl = s.get('pnlSol', 'n/a')
    reason = s.get('reason', '')[:35]
    pnl_str = f"{pnl:+.6f}" if isinstance(pnl, (int, float)) else pnl
    print(f"  {mint}... | {sol:.4f} SOL | PnL: {pnl_str} | {reason}")
