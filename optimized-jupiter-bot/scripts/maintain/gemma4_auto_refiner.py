#!/usr/bin/env python3
"""
Gemma 4 Auto-Refiner — Runs on a schedule, analyzes trade data,
and pushes refined parameters to the live sniper via Redis.
Deployed as a PM2 process with a built-in sleep loop.
"""
import json, os, sys, time, subprocess
from datetime import datetime

JOURNAL = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/archive/trade_history.jsonl'
MISSED  = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/missed_targets.jsonl'
RECS    = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/signals/gemma4_recommendations.json'
SNIPER_TS = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/scripts/maintain/momentum_sniper.ts'
INTERVAL_SECONDS = 3600  # Run every 1 hour

# Safety bounds — Gemma 4 can never push outside these
BOUNDS = {
    'min_5m_change':       (1, 10),    # 1-10% 
    'min_liquidity_usd':   (5000, 50000),
    'max_top10_holder_pct':(20, 60),
    'tp1_pct':             (4, 15),
    'stop_loss_pct':       (2, 8),
    'max_hold_minutes':    (2, 10),
}

def clamp(val, lo, hi):
    return max(lo, min(hi, val))

def load_trades():
    trades = []
    if not os.path.exists(JOURNAL):
        return []
    with open(JOURNAL) as f:
        for line in f:
            line = line.strip()
            if line:
                try: trades.append(json.loads(line))
                except: pass
    return trades

def load_missed(n=500):
    missed = []
    if not os.path.exists(MISSED):
        return []
    with open(MISSED) as f:
        lines = f.readlines()
    for line in lines[-n:]:
        line = line.strip()
        if line:
            try: missed.append(json.loads(line))
            except: pass
    return missed

def analyze_trades(trades):
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
                'pnl': pnl,
                'pnl_pct': (pnl / buy['amountIn'] * 100) if buy.get('amountIn') else 0,
                'exit': sell.get('exitReason', sell.get('reason', '')),
                'hold_s': (sell.get('timestamp', 0) - buy.get('timestamp', 0)) / 1000,
                'success': sell.get('success', False),
            })
    return pairs

def analyze_entry_quality(trades):
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

def generate_recommendations(pairs, missed):
    wins = [p for p in pairs if p['pnl'] > 0]
    losses = [p for p in pairs if p['pnl'] <= 0]
    failed = [p for p in pairs if not p.get('success')]
    
    total = max(len(pairs), 1)
    win_rate = len(wins) / total * 100
    failed_ratio = len(failed) / total
    avg_loss = sum(p['pnl_pct'] for p in losses) / max(len(losses), 1) if losses else 0
    avg_win = sum(p['pnl_pct'] for p in wins) / max(len(wins), 1) if wins else 0
    
    # Count missed target reasons
    miss_reasons = {}
    for m in missed:
        r = m.get('reason', 'unknown')
        miss_reasons[r] = miss_reasons.get(r, 0) + 1
    
    # Current defaults
    recs = {
        'min_5m_change': 3,
        'min_liquidity_usd': 20000,
        'max_top10_holder_pct': 40,
        'tp1_pct': 6,
        'stop_loss_pct': 4,
        'max_hold_minutes': 5,
    }
    
    analysis = f"Win rate: {win_rate:.0f}% ({len(wins)}/{total}). "
    analysis += f"Avg win: {avg_win:+.1f}%, avg loss: {avg_loss:+.1f}%. "
    analysis += f"Failed sells: {failed_ratio*100:.0f}%."
    
    insight = ""
    confidence = 50
    
    # Decision logic based on data patterns
    if total < 5:
        insight = "Insufficient data for refinement. Maintaining current parameters."
        confidence = 30
    elif failed_ratio > 0.5:
        insight = "CRITICAL: Most sell attempts fail. Increasing liquidity floor to ensure sellable tokens."
        recs['min_liquidity_usd'] = 25000
        recs['min_5m_change'] = 3
        confidence = 80
    elif win_rate < 20:
        insight = "Win rate critically low. Tightening all entry filters."
        recs['min_5m_change'] = min(recs['min_5m_change'] + 1, 8)
        recs['min_liquidity_usd'] = min(recs['min_liquidity_usd'] + 5000, 40000)
        recs['max_top10_holder_pct'] = max(recs['max_top10_holder_pct'] - 5, 25)
        recs['stop_loss_pct'] = max(recs['stop_loss_pct'] - 1, 3)
        confidence = 65
    elif win_rate < 35:
        insight = "Win rate below breakeven. Fine-tuning entry quality."
        recs['min_5m_change'] = min(recs['min_5m_change'] + 1, 6)
        recs['min_liquidity_usd'] = min(recs['min_liquidity_usd'] + 2000, 30000)
        confidence = 60
    elif win_rate >= 35 and win_rate < 50:
        insight = "Win rate approaching profitability. Slightly loosening to increase volume."
        recs['min_5m_change'] = max(recs['min_5m_change'] - 0.5, 2)
        confidence = 70
    else:
        insight = "System profitable. Consider increasing position size."
        confidence = 85
    
    # If avg loss is huge (>50%), tighten SL
    if avg_loss < -30:
        recs['stop_loss_pct'] = max(recs['stop_loss_pct'] - 1, 3)
        insight += " Large avg losses detected — tightening stop loss."
    
    # Clamp all values
    for key in recs:
        if key in BOUNDS:
            lo, hi = BOUNDS[key]
            recs[key] = clamp(recs[key], lo, hi)
    
    # ── ENTRY POSITION ANALYSIS ──────────────────────────────────────────
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
    
    return {
        'analysis': analysis,
        'key_insight': insight,
        'confidence': confidence,
        'recommended_filters': recs,
        'trade_count': total,
        'win_rate': win_rate,
        'total_pnl_sol': sum(p['pnl'] for p in pairs),
        'generated_at': datetime.utcnow().isoformat(),
    }


def update_env(filters):
    """Persist Gemma4 recommendations to .env so they survive restart."""
    env_path = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/.env'
    try:
        with open(env_path) as f:
            env = f.read()
        
        mappings = {
            'MAX_TP_PERCENT': str(filters.get('tp1_pct', 6)),
            'STOP_LOSS_PERCENT': str(filters.get('stop_loss_pct', 4)),
            'MAX_HOLD_MINUTES': str(filters.get('max_hold_minutes', 5)),
        }
        
        for key, val in mappings.items():
            import re
            pattern = f'^{key}=.*$'
            replacement = f'{key}={val}'
            env = re.sub(pattern, replacement, env, flags=re.MULTILINE)
        
        with open(env_path, 'w') as f:
            f.write(env)
        print(f'  .env updated: {mappings}')
    except Exception as e:
        print(f'  .env update error: {e}')

def apply_recommendations(recs):
    """Push recommendations to the sniper via Redis pub/sub."""
    filters = recs.get('recommended_filters', {})
    confidence = recs.get('confidence', 0)
    
    # Only auto-apply if confidence >= 60
    if confidence < 60:
        print(f'  SKIP auto-apply: confidence {confidence}% < 60% threshold')
        return False
    
    # Build Redis command to push params
    params = {
        'maxTPpct': filters.get('tp1_pct', 6) / 100,
        'stopLossPct': filters.get('stop_loss_pct', 4) / 100,
        'maxHoldMinutes': filters.get('max_hold_minutes', 5),
        'dynamicMinMom1m': filters.get('min_5m_change', 3),
    }
    
    payload = json.dumps(params)
    try:
        result = subprocess.run(
            ['redis-cli', 'PUBLISH', 'config:update', payload],
            capture_output=True, text=True, timeout=5
        )
        subscribers = result.stdout.strip()
        update_env(filters)
        print(f'  Redis PUBLISH config:update -> {subscribers} subscriber(s)')
        print(f'  Params: {json.dumps(params, indent=4)}')
        return True
    except Exception as e:
        print(f'  Redis publish error: {e}')
        return False

def run_cycle():
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    print(f'\n{"="*60}')
    print(f'[GEMMA4] Refinement cycle at {now}')
    print(f'{"="*60}')
    
    trades = load_trades()
    missed = load_missed()
    print(f'  Journal: {len(trades)} entries')
    print(f'  Missed targets: {len(missed)} entries')
    
    if len(trades) == 0:
        print('  No trade data yet. Skipping analysis.')
        return
    
    pairs = analyze_trades(trades)
    print(f'  Paired trades: {len(pairs)}')
    
    recs = generate_recommendations(pairs, missed)
    
    # Save recommendations
    with open(RECS, 'w') as f:
        json.dump(recs, f, indent=2)
    
    print(f'\n  Analysis: {recs["analysis"]}')
    print(f'  Insight: {recs["key_insight"]}')
    print(f'  Confidence: {recs["confidence"]}%')
    print(f'  Filters: {json.dumps(recs["recommended_filters"], indent=4)}')
    if 'overbought_ceiling' in recs.get('recommended_filters', {}):
        print(f'  Entry window: +{recs["recommended_filters"].get("min_5m_change",1)}% to +{recs["recommended_filters"].get("overbought_ceiling",30)}% (5m)')
    
    # Auto-apply if confident
    print(f'\n  Applying recommendations...')
    applied = apply_recommendations(recs)
    if applied:
        print(f'  ✅ Parameters pushed to live sniper')
    else:
        print(f'  ⏸️ Not applied (low confidence or error)')
    
    print(f'  Saved to {RECS}')


# ── LOSS-STREAK TRIGGERED REFINEMENT ──────────────────────────────────────────
import threading, subprocess as _sp

def redis_listener():
    """Listen for gemma4:refine events from the sniper."""
    import time as _time
    while True:
        try:
            # Use redis-cli SUBSCRIBE in blocking mode
            proc = _sp.Popen(
                ['redis-cli', 'SUBSCRIBE', 'gemma4:refine'],
                stdout=_sp.PIPE, stderr=_sp.PIPE, text=True
            )
            for line in proc.stdout:
                line = line.strip()
                if line.startswith('{'):
                    print(f'\n[GEMMA4] 🧠 LOSS STREAK TRIGGER received: {line[:80]}')
                    print('[GEMMA4] Running emergency refinement cycle...')
                    run_cycle()
        except Exception as e:
            print(f'[GEMMA4] Redis listener error: {e}')
            _time.sleep(5)

# Start listener thread
listener_thread = threading.Thread(target=redis_listener, daemon=True)
listener_thread.start()
print('[GEMMA4] 🧠 Loss-streak listener active on gemma4:refine channel')

# ─── Main loop ────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    print('[GEMMA4] Auto-Refiner started')
    print(f'[GEMMA4] Interval: {INTERVAL_SECONDS}s ({INTERVAL_SECONDS/60:.0f}min)')
    print(f'[GEMMA4] Safety bounds: {json.dumps(BOUNDS, indent=2)}')
    
    # Run immediately on start
    run_cycle()
    
    # Then loop
    while True:
        print(f'\n[GEMMA4] Next cycle in {INTERVAL_SECONDS/60:.0f} minutes...')
        time.sleep(INTERVAL_SECONDS)
        run_cycle()
