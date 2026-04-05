#!/usr/bin/env python3
"""
Gemma 4 Auto-Refiner — Runs on a schedule, analyzes trade data,
and pushes refined parameters to the live sniper via Redis.
Deployed as a PM2 process with a built-in sleep loop.
"""
import json, os, sys, time, subprocess
from datetime import datetime

JOURNAL = '/mnt/volume_sfo3_01/pcp-engine/optimized-jupiter-bot/trade_journal.jsonl'
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
            ['redis-cli', 'PUBLISH', 'sniper:override', payload],
            capture_output=True, text=True, timeout=5
        )
        subscribers = result.stdout.strip()
        print(f'  Redis PUBLISH sniper:override -> {subscribers} subscriber(s)')
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
    
    # Auto-apply if confident
    print(f'\n  Applying recommendations...')
    applied = apply_recommendations(recs)
    if applied:
        print(f'  ✅ Parameters pushed to live sniper')
    else:
        print(f'  ⏸️ Not applied (low confidence or error)')
    
    print(f'  Saved to {RECS}')

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
