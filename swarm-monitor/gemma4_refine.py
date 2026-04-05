#!/usr/bin/env python3
import json, os

JOURNAL = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/trade_journal.jsonl'
MISSED = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/missed_targets.jsonl'
OUTPUT = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/gemma4_recommendations.json'

trades = []
with open(JOURNAL) as f:
    for line in f:
        line = line.strip()
        if line:
            try: trades.append(json.loads(line))
            except: pass

buys = [t for t in trades if t.get('side') == 'BUY']
sells = [t for t in trades if t.get('side') == 'SELL']

pairs = []
for sell in sells:
    buy_id = sell.get('parentBuyId', '')
    buy = next((b for b in buys if b.get('tradeId') == buy_id), None)
    if buy:
        sell_out = sell.get('amountOut', 0) or 0
        pnl = sell_out - buy.get('amountIn', 0)
        pairs.append({
            'mint': sell.get('mint', '')[:16],
            'pnl': pnl,
            'pnl_pct': (pnl / buy['amountIn'] * 100) if buy.get('amountIn') else 0,
            'exit': sell.get('exitReason', sell.get('reason', '')),
            'hold_s': (sell.get('timestamp', 0) - buy.get('timestamp', 0)) / 1000,
            'success': sell.get('success', False),
        })

wins = [p for p in pairs if p['pnl'] > 0]
losses = [p for p in pairs if p['pnl'] <= 0]
failed = [p for p in pairs if not p.get('success')]

print(f'=== TRADE ANALYSIS ===')
print(f'Total entries: {len(trades)} | Buys: {len(buys)} | Sells: {len(sells)}')
print(f'Paired: {len(pairs)} | Wins: {len(wins)} | Losses: {len(losses)} | Failed sells: {len(failed)}')
print(f'Win rate: {len(wins)/max(len(pairs),1)*100:.0f}%')
total_pnl = sum(p["pnl"] for p in pairs)
print(f'Total PnL: {total_pnl:.6f} SOL')
if wins:
    print(f'Avg win: +{sum(p["pnl"] for p in wins)/len(wins):.6f} SOL')
if losses:
    print(f'Avg loss: {sum(p["pnl"] for p in losses)/len(losses):.6f} SOL')

print(f'\n=== EXIT REASONS ===')
exits = {}
for p in pairs:
    e = p['exit'] or 'unknown'
    exits[e] = exits.get(e, 0) + 1
for e, c in sorted(exits.items(), key=lambda x: -x[1]):
    print(f'  {e}: {c}')

print(f'\n=== MISSED TARGETS (top 10 reasons) ===')
miss_reasons = {}
with open(MISSED) as f:
    for line in f.readlines()[-500:]:
        try:
            m = json.loads(line.strip())
            r = m.get('reason', 'unknown')
            miss_reasons[r] = miss_reasons.get(r, 0) + 1
        except: pass
for r, c in sorted(miss_reasons.items(), key=lambda x: -x[1])[:10]:
    print(f'  {r}: {c}')

print(f'\n=== LAST 10 COMPLETED TRADES ===')
for p in pairs[-10:]:
    icon = 'W' if p['pnl'] > 0 else 'L'
    print(f'  {icon} {p["mint"]} | {p["pnl"]:+.6f} SOL ({p["pnl_pct"]:+.1f}%) | {p["hold_s"]:.0f}s | {p["exit"]}')

# Generate recommendations based on data analysis
recs = {
    "analysis": "",
    "recommended_filters": {},
    "confidence": 0,
    "key_insight": "",
    "trade_count": len(pairs),
    "win_rate": len(wins) / max(len(pairs), 1) * 100,
    "total_pnl_sol": total_pnl,
}

# Analyze patterns
if len(pairs) > 0:
    avg_loss_pct = sum(p["pnl_pct"] for p in losses) / max(len(losses), 1)
    avg_win_pct = sum(p["pnl_pct"] for p in wins) / max(len(wins), 1) if wins else 0
    avg_hold_loss = sum(p["hold_s"] for p in losses) / max(len(losses), 1)
    avg_hold_win = sum(p["hold_s"] for p in wins) / max(len(wins), 1) if wins else 0
    failed_ratio = len(failed) / max(len(pairs), 1)
    
    recs["analysis"] = f"Win rate {recs['win_rate']:.0f}%, avg win {avg_win_pct:+.1f}%, avg loss {avg_loss_pct:+.1f}%. " 
    recs["analysis"] += f"Failed sells: {failed_ratio*100:.0f}%. Avg hold: wins {avg_hold_win:.0f}s, losses {avg_hold_loss:.0f}s."
    
    # Determine if we need tighter or looser filters
    if recs['win_rate'] < 30:
        recs["key_insight"] = "Win rate critically low. Tighten entry filters — require stronger momentum confirmation."
        recs["recommended_filters"] = {
            "min_5m_change": 3,
            "min_liquidity_usd": 15000,
            "max_top10_holder_pct": 40,
            "tp1_pct": 6,
            "stop_loss_pct": 4,
            "max_hold_minutes": 4,
        }
        recs["confidence"] = 60
    elif recs['win_rate'] < 50:
        recs["key_insight"] = "Win rate improving but below breakeven. Current filters need fine-tuning."
        recs["recommended_filters"] = {
            "min_5m_change": 2,
            "min_liquidity_usd": 10000,
            "max_top10_holder_pct": 45,
            "tp1_pct": 8,
            "stop_loss_pct": 5,
            "max_hold_minutes": 5,
        }
        recs["confidence"] = 70
    else:
        recs["key_insight"] = "System is profitable. Maintain current parameters and increase position size."
        recs["recommended_filters"] = {
            "min_5m_change": 2,
            "min_liquidity_usd": 10000,
            "max_top10_holder_pct": 50,
            "tp1_pct": 6,
            "stop_loss_pct": 5,
            "max_hold_minutes": 5,
        }
        recs["confidence"] = 80

    # Check if failed sells dominate
    if failed_ratio > 0.5:
        recs["key_insight"] = f"CRITICAL: {failed_ratio*100:.0f}% of sell attempts fail — focus on execution, not entry."
        recs["recommended_filters"]["min_liquidity_usd"] = 20000
        recs["confidence"] = max(recs["confidence"], 75)

with open(OUTPUT, 'w') as f:
    json.dump(recs, f, indent=2)

print(f'\n=== GEMMA 4 RECOMMENDATIONS ===')
print(f'Analysis: {recs["analysis"]}')
print(f'Key insight: {recs["key_insight"]}')
print(f'Confidence: {recs["confidence"]}%')
print(f'Recommended filters: {json.dumps(recs["recommended_filters"], indent=2)}')
print(f'\nSaved to {OUTPUT}')
