import json, sys
from collections import defaultdict

journal = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/trade_journal.jsonl'
lines = open(journal).readlines()

buys, sells = [], []
for l in lines:
    l = l.strip()
    if not l:
        continue
    try:
        r = json.loads(l)
    except:
        continue
    if r.get('action') == 'BUY':
        buys.append(r)
    elif r.get('action') == 'SELL':
        sells.append(r)

# Total SOL spent on buys
total_buy_sol = sum(b.get('amountSol', 0) for b in buys)
total_sell_sol = sum(s.get('amountSol', 0) for s in sells)
total_pnl = sum(s.get('pnlSol', 0) for s in sells if s.get('pnlSol') is not None)

# Count by exit reason
reasons = defaultdict(lambda: {'count': 0, 'pnl': 0, 'sol_out': 0})
for s in sells:
    reason = s.get('reason', 'unknown')
    # Normalize reason
    if 'APEX' in reason and 'MANIP' in reason:
        key = 'APEX: MANIPULATION'
    elif 'FORCE_EXIT' in reason:
        key = 'FORCE_EXIT (Apex)'
    elif 'MAX_TP' in reason:
        key = 'TP HIT'
    elif 'TRAIL' in reason or 'STOP' in reason:
        key = 'STOP LOSS'
    elif 'TIME' in reason:
        key = 'TIME EXIT'
    elif 'orphan' in reason:
        key = 'ORPHAN RECOVERY'
    else:
        key = reason[:30]
    reasons[key]['count'] += 1
    reasons[key]['pnl'] += s.get('pnlSol', 0) or 0
    reasons[key]['sol_out'] += s.get('amountSol', 0)

# Gas estimate: each tx costs ~0.000005 SOL base + priority
# But we had high priority fees before fixes
sol_price = 135  # approximate

print("=" * 60)
print("FORENSIC TRADE JOURNAL ANALYSIS")
print("=" * 60)
print(f"Total BUYs:  {len(buys)} trades, {total_buy_sol:.4f} SOL deployed")
print(f"Total SELLs: {len(sells)} trades, {total_sell_sol:.4f} SOL received")
print(f"Trade PnL:   {total_pnl:+.6f} SOL (${total_pnl * sol_price:+.2f})")
print(f"SOL gap:     {total_sell_sol - total_buy_sol:+.6f} SOL (buy-sell difference)")
print()
print("BREAKDOWN BY EXIT REASON:")
print("-" * 60)
for reason, data in sorted(reasons.items(), key=lambda x: x[1]['pnl']):
    print(f"  {reason:25s} | {data['count']:3d} trades | PnL: {data['pnl']:+.6f} SOL (${data['pnl']*sol_price:+.2f})")
print()

# Estimate gas burned
# Before fix: buy=250K, sell_normal=250K, sell_apex=5M (emergency)
apex_sells = sum(1 for s in sells if 'APEX' in s.get('reason', '') or 'FORCE' in s.get('reason', ''))
normal_sells = len(sells) - apex_sells

# Old fee structure
gas_buy_old = len(buys) * 0.00025  # 250K lamports each
gas_sell_normal = normal_sells * 0.00025
gas_sell_apex = apex_sells * 0.005  # 5M lamports emergency exits!
total_gas_old = gas_buy_old + gas_sell_normal + gas_sell_apex

# Plus base tx fee (5000 lamports per tx)
base_fees = (len(buys) + len(sells)) * 0.000005
total_gas = total_gas_old + base_fees

# Unaccounted
wallet_loss = 1.0  # approximate from balance check
unaccounted = wallet_loss - abs(total_pnl) - total_gas

print("GAS & FEE ESTIMATE:")
print("-" * 60)
print(f"  Buy priority fees:    {gas_buy_old:.6f} SOL ({len(buys)} x 250K lamports)")
print(f"  Sell (normal) fees:   {gas_sell_normal:.6f} SOL ({normal_sells} x 250K lamports)")
print(f"  Sell (APEX/emergency):{gas_sell_apex:.6f} SOL ({apex_sells} x 5M lamports!)")
print(f"  Base tx fees:         {base_fees:.6f} SOL ({len(buys)+len(sells)} txns)")
print(f"  TOTAL GAS ESTIMATE:   {total_gas:.6f} SOL (${total_gas*sol_price:.2f})")
print()
print("LOSS ACCOUNTING:")
print("-" * 60)
print(f"  Trade losses:         {abs(total_pnl):.6f} SOL (${abs(total_pnl)*sol_price:.2f})")
print(f"  Gas/fees:             {total_gas:.6f} SOL (${total_gas*sol_price:.2f})")
print(f"  TOTAL EXPLAINED:      {abs(total_pnl)+total_gas:.6f} SOL (${(abs(total_pnl)+total_gas)*sol_price:.2f})")
print(f"  Actual wallet loss:   ~1.0 SOL (~$135)")
print(f"  Unaccounted:          ~{unaccounted:.4f} SOL (failed txns, slippage, WSOL wrapping)")
print()
print("TOP LOSS TRADES:")
print("-" * 60)
loss_sells = sorted([s for s in sells if s.get('pnlSol') and s['pnlSol'] < -0.001], key=lambda x: x['pnlSol'])
for s in loss_sells[:5]:
    print(f"  {s['mint'][:12]}... | {s['amountSol']:.4f} SOL | PnL: {s['pnlSol']:+.6f} | {s.get('reason','')[:35]}")
