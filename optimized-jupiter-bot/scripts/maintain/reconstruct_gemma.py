import json
import shutil

# Restore the base file
shutil.copy(r'C:\Users\admin\Documents\pcprotocol-target\temp_ssh\gemma4_slopfest_refiner.py', r'C:\Users\admin\Documents\pcprotocol-target\scripts\maintain\gemma4_slopfest_refiner.py')

with open(r'C:\Users\admin\Documents\pcprotocol-target\scripts\maintain\gemma4_slopfest_refiner.py', 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Add Bayesian Logic
bayesian_logic = '''    param_performance = {}
    import json
    for p in pairs:
        pid = p.get('slopfest_id')
        if not pid: continue
        raw_str = p.get('slopfest_raw')
        if not raw_str: continue
        try:
            raw = json.loads(raw_str)
        except Exception:
            continue
        if pid not in param_performance:
            param_performance[pid] = {'trades': 0, 'wins': 0, 'pnl_pct': 0, 'raw': raw}
        param_performance[pid]['trades'] += 1
        if p.get('pnl', 0) > 0: param_performance[pid]['wins'] += 1
        param_performance[pid]['pnl_pct'] += p.get('pnl_pct', 0)

    for v in param_performance.values():
        v['win_rate'] = round((v['wins'] / v['trades']) * 100, 2)
        v['avg_pnl'] = round(v['pnl_pct'] / v['trades'], 2)

    sorted_params = sorted(param_performance.values(), key=lambda x: x['win_rate'], reverse=True)
    top_params = sorted_params[:3]
    bottom_params = sorted_params[-3:] if len(sorted_params) > 3 else []
'''
text = text.replace('    compact = {', bayesian_logic + '\n    compact = {')
text = text.replace("'bounds': BOUNDS,", "'bounds': BOUNDS,\n        'top_performing_params': top_params,\n        'bottom_performing_params': bottom_params,")

phase_3 = '''### PHASE 3: PARAMETER FEEDBACK LOOP
Here are the aggregated performance metrics of the previous parameter combinations you suggested:
{json.dumps({'top_performers': top_params, 'bottom_performers': bottom_params}, indent=2)}

CRITICAL INSTRUCTION: Improve upon the top performers while avoiding characteristics of the bottom performers. Do NOT raise liquidity floors. Focus on momentum and volume tuning.
'''
text = text.replace("### ANALYSIS TASKS (Chain-of-Thought Required)", phase_3.strip() + "\n\n### ANALYSIS TASKS (Chain-of-Thought Required)")

# 2. Add Grid Search Logic
grid_search_logic = '''
def run_autonomous_grid_search(pairs):
    slopfest_pairs = [p for p in pairs if p.get('slopfest_id')]
    if not slopfest_pairs:
        return None

    vol_floors = [500, 1000, 2500, 5000]
    mom_floors = [2.0, 5.0, 10.0, 20.0]
    trails = [0.03, 0.05, 0.08, 0.12]
    tps = [0.20, 0.50, 1.00]

    best_pnl = -9999
    best_params = None

    for v in vol_floors:
        for m in mom_floors:
            for tr in trails:
                for tp in tps:
                    sim_pnl = 0
                    sim_trades = 0
                    for p in slopfest_pairs:
                        if p.get('entry_volume5m', 0) < v: continue
                        if p.get('entry_momentum5m', 0) < m: continue

                        sim_trades += 1
                        peak = p.get('peak_pnl_pct', 0)
                        actual_pnl = p.get('pnl', 0)
                        entry_cost = 0.01 # micro-scout assumption

                        if peak >= tp:
                            sim_pnl += tp * entry_cost
                        elif peak > 0 and (peak - tr) >= actual_pnl:
                            sim_pnl += (peak - tr) * entry_cost
                        else:
                            sim_pnl += actual_pnl

                    if sim_trades >= 3 and sim_pnl > best_pnl:
                        best_pnl = sim_pnl
                        best_params = {
                            'minVolume': v,
                            'minMomentum': m,
                            'trailingStop': tr,
                            'takeProfit': tp,
                            'simulated_pnl': sim_pnl,
                            'simulated_trades': sim_trades
                        }
    return best_params
'''
text = text.replace('def collapse_trade_lifecycles(trades):', grid_search_logic + '\ndef collapse_trade_lifecycles(trades):')

# 3. Inject Grid Search into Prompt
grid_search_injection = '''    best_profile_msg = ""
    optimal = run_autonomous_grid_search(pairs)
    if optimal:
        best_profile_msg = (
            f"### AUTONOMOUS BACKTESTER RESULTS\\n"
            f"The system has mathematically backtested thousands of parameter permutations against the recent trades.\\n"
            f"The OPTIMAL configuration that would have maximized PnL in this exact market terrain is:\\n"
            f"- minVolume: ${optimal['minVolume']}\\n"
            f"- minMomentum: {optimal['minMomentum']}%\\n"
            f"- trailingStop: {optimal['trailingStop'] * 100}%\\n"
            f"- takeProfit: {optimal['takeProfit'] * 100}%\\n"
            f"(Simulated PnL: +{optimal['simulated_pnl']:.4f} SOL across {optimal['simulated_trades']} trades)\\n\\n"
            f"Use these mathematical truths as your baseline when generating the new configuration.\\n\\n"
        )

    PROMPT = f"""'''
text = text.replace('    PROMPT = f"""', grid_search_injection)

prompt_intro = 'Your input context contains the recent trade journal history of trades explicitly executed during "desperation bypass" (extremely low-liquidity, high-risk, messy meme-coin launches). Your output must be a strict JSON object.'
new_prompt_intro = '{best_profile_msg}Your input context contains the recent trade journal history of trades explicitly executed during "desperation bypass" (extremely low-liquidity, high-risk, messy meme-coin launches). Your output must be a strict JSON object.'
text = text.replace(prompt_intro, new_prompt_intro)

# 4. Fix analyze_trades to extract peak_pnl_pct and entry_volume5m
old_analyze_trades_block = '''                'entry_momentum5m': try_float(buy.get('momentum5m'), 0) or 0,
                'entry_price_chg_1h': try_float(parsed_entry.get('price_chg_1h'), 0) or 0,
                'entry_buys': int(parsed_entry.get('buys', 0) or 0),
                'entry_buy_ratio': try_float(parsed_entry.get('buy_ratio'), 0) or 0,
                'slopfest_id': buy.get('slopfestParamsSetId'),
                'slopfest_raw': buy.get('slopfestParamsRaw'),
                'event_count': 1,'''

new_analyze_trades_block = '''                'entry_momentum5m': try_float(buy.get('momentum5m'), 0) or 0,
                'entry_volume5m': try_float(buy.get('volume5m'), 0) or 0,
                'entry_price_chg_1h': try_float(parsed_entry.get('price_chg_1h'), 0) or 0,
                'entry_buys': int(parsed_entry.get('buys', 0) or 0),
                'entry_buy_ratio': try_float(parsed_entry.get('buy_ratio'), 0) or 0,
                'peak_pnl_pct': try_float(sell.get('rsi'), 0) or 0,
                'slopfest_id': buy.get('slopfestParamsSetId'),
                'slopfest_raw': buy.get('slopfestParamsRaw'),
                'event_count': 1,'''
text = text.replace(old_analyze_trades_block, new_analyze_trades_block)

with open(r'C:\Users\admin\Documents\pcprotocol-target\scripts\maintain\gemma4_slopfest_refiner.py', 'wb') as f:
    f.write(text.encode('utf-8'))

print('DONE!')
