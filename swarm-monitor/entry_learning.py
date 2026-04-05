import os

REFINER = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/gemma4_auto_refiner.py'

with open(REFINER) as f:
    code = f.read()

# Replace the simple generate_recommendations with an entry-aware version
old_func = "def generate_recommendations(pairs, missed):"
new_analysis = '''def analyze_entry_quality(trades):
    """Analyze WHERE in the pump we're entering based on momentum5m at buy time."""
    buys = [t for t in trades if t.get('action') == 'BUY' and t.get('momentum5m') is not None]
    sells = [t for t in trades if t.get('action') == 'SELL']
    
    # Pair buys with sells
    entry_data = []
    for sell in sells:
        buy_id = sell.get('parentBuyId', '')
        buy = next((b for b in buys if b.get('tradeId') == buy_id), None)
        if buy and buy.get('momentum5m') is not None:
            sell_out = sell.get('amountOut', 0) or 0
            buy_in = buy.get('amountIn', 0) or buy.get('amountSol', 0)
            pnl_pct = ((sell_out - buy_in) / buy_in * 100) if buy_in else 0
            entry_data.append({
                'mom5m': buy['momentum5m'],
                'pnl_pct': pnl_pct,
                'win': pnl_pct > 0,
                'sell_ok': sell.get('success', False),
            })
    
    if len(entry_data) < 3:
        return None  # Not enough data to analyze
    
    # Bucket by entry momentum
    buckets = {}
    for label, lo, hi in [('early_1_5', 1, 5), ('mid_5_10', 5, 10), ('mid_10_20', 10, 20), ('late_20_30', 20, 30)]:
        bucket = [e for e in entry_data if lo <= (e['mom5m'] or 0) < hi]
        if bucket:
            wins = sum(1 for e in bucket if e['win'])
            avg_pnl = sum(e['pnl_pct'] for e in bucket) / len(bucket)
            sell_rate = sum(1 for e in bucket if e['sell_ok']) / len(bucket)
            buckets[label] = {
                'count': len(bucket), 'wins': wins,
                'win_rate': wins / len(bucket),
                'avg_pnl': avg_pnl,
                'sell_rate': sell_rate,
            }
    
    # Find optimal entry window
    best_bucket = None
    best_score = -999
    for label, data in buckets.items():
        # Score = win_rate * sell_rate * (1 + avg_pnl/10) — balances profitability with executability
        score = data['win_rate'] * data['sell_rate'] * (1 + data['avg_pnl'] / 10)
        if score > best_score:
            best_score = score
            best_bucket = label
    
    return {
        'buckets': buckets,
        'best_entry_window': best_bucket,
        'entry_count': len(entry_data),
    }

def generate_recommendations(pairs, missed):'''

if 'analyze_entry_quality' not in code:
    code = code.replace(old_func, new_analysis)
    print('  Added analyze_entry_quality function')

# Now call it and use results in generate_recommendations
# Find where recs are built and add entry analysis
old_return = "    return {"
new_return = """    # ── ENTRY POSITION ANALYSIS ──────────────────────────────────────────
    all_trades = load_trades()
    entry_analysis = analyze_entry_quality(all_trades)
    
    optimal_min = recs['min_5m_change']
    optimal_max = 30  # default overbought ceiling
    
    if entry_analysis and entry_analysis['entry_count'] >= 5:
        best = entry_analysis.get('best_entry_window', '')
        buckets = entry_analysis.get('buckets', {})
        
        # Tighten entry window based on where wins happen
        if best == 'early_1_5':
            optimal_min = 1
            optimal_max = 10
            insight += ' ENTRY ANALYSIS: Early entries (1-5% 5m) perform best — narrowing window.'
        elif best == 'mid_5_10':
            optimal_min = 3
            optimal_max = 15
            insight += ' ENTRY ANALYSIS: Mid entries (5-10% 5m) perform best — targeting sweet spot.'
        elif best == 'mid_10_20':
            optimal_min = 8
            optimal_max = 25
            insight += ' ENTRY ANALYSIS: Higher momentum entries (10-20%) work — raising floor.'
        elif best == 'late_20_30':
            insight += ' ENTRY ANALYSIS: Late entries (20-30%) oddly winning — unusual market.'
        
        # If a bucket has 0% win rate, block it
        for label, data in buckets.items():
            if data['count'] >= 3 and data['win_rate'] == 0:
                if label == 'late_20_30':
                    optimal_max = min(optimal_max, 20)
                    insight += f' Blocking 20-30% entries (0% win rate).'
                elif label == 'mid_10_20':
                    optimal_max = min(optimal_max, 10)
                    insight += f' Blocking 10-20% entries (0% win rate).'
        
        recs['min_5m_change'] = clamp(optimal_min, 1, 10)
        recs['overbought_ceiling'] = clamp(optimal_max, 10, 50)
        confidence = min(confidence + 10, 95)
    
    return {"""

# Only replace the FIRST occurrence of "    return {"
if 'ENTRY POSITION ANALYSIS' not in code:
    # Find the return statement in generate_recommendations
    idx = code.find('def generate_recommendations(')
    if idx >= 0:
        ret_idx = code.find("    return {", idx)
        if ret_idx >= 0:
            code = code[:ret_idx] + new_return + code[ret_idx + len("    return {"):]
            print('  Added entry position analysis to generate_recommendations')

# Also log entry analysis in run_cycle
old_print = "    print(f'  Filters: {json.dumps(recs[\"recommended_filters\"], indent=4)}')"
new_print = """    print(f'  Filters: {json.dumps(recs["recommended_filters"], indent=4)}')
    if 'overbought_ceiling' in recs.get('recommended_filters', {}):
        print(f'  Entry window: +{recs["recommended_filters"].get("min_5m_change",1)}% to +{recs["recommended_filters"].get("overbought_ceiling",30)}% (5m)')"""

if 'Entry window' not in code:
    code = code.replace(old_print, new_print)
    print('  Added entry window logging')

with open(REFINER, 'w') as f:
    f.write(code)

print('\nDone. Gemma4 now analyzes entry momentum vs outcome to find the optimal buy zone.')
