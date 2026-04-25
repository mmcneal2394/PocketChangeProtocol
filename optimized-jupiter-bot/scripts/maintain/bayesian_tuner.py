#!/usr/bin/env python3
"""
bayesian_tuner.py

Layer 4 of the Unified Mathematical Trading Framework.

Daily offline optimizer using Bayesian Optimization (Gaussian Process)
to tune Kelly/regime parameters based on recent trade history.

Optimizes: atr_multiplier, kelly_fraction, regime thresholds
Objective: maximize Sharpe ratio over last 7 days of trades

Reads:  signals/archive/trade_history.jsonl
Writes: signals/bayesian_params.json
"""

import json
import os
import sys
import math
from datetime import datetime, timedelta
from pathlib import Path

SIGNALS_DIR = Path(os.environ.get('SIGNALS_DIR', '/var/www/pcprotocol/signals'))
TRADE_HISTORY = SIGNALS_DIR / 'archive' / 'trade_history.jsonl'
OUTPUT_FILE = SIGNALS_DIR / 'bayesian_params.json'

# ── Parameter Bounds ────────────────────────────────────────────────────────

PARAM_BOUNDS = {
    'atr_multiplier':       (1.0, 4.0),    # Stop distance = ATR × this
    'kelly_fraction':       (0.25, 0.75),   # Fractional Kelly scaling
    'regime_high_threshold': (1.1, 2.0),    # Volatility ratio for HIGH_VOL
    'regime_low_threshold':  (0.4, 0.9),    # Volatility ratio for LOW_VOL
    'regime_high_mult':      (0.3, 0.8),    # Kelly multiplier in HIGH_VOL
    'regime_low_mult':       (1.0, 1.5),    # Kelly multiplier in LOW_VOL
}

DEFAULT_PARAMS = {
    'atr_multiplier': 2.0,
    'kelly_fraction': 0.5,
    'regime_high_threshold': 1.3,
    'regime_low_threshold': 0.8,
    'regime_high_mult': 0.5,
    'regime_low_mult': 1.2,
}


# ── Trade History Loading ───────────────────────────────────────────────────

def load_recent_trades(days=7):
    """Load trades from the last N days."""
    if not TRADE_HISTORY.exists():
        print(f'[BAYESIAN] Trade history not found at {TRADE_HISTORY}')
        return []

    cutoff = datetime.utcnow() - timedelta(days=days)
    cutoff_ms = cutoff.timestamp() * 1000
    trades = []

    with open(TRADE_HISTORY, 'r') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                trade = json.loads(line)
                ts = trade.get('exitTs') or trade.get('entryTs') or 0
                if ts >= cutoff_ms:
                    trades.append(trade)
            except json.JSONDecodeError:
                continue

    return trades


# ── Objective Function ──────────────────────────────────────────────────────

def simulate_kelly_pnl(trades, params):
    """
    Simulate trading with Kelly sizing using the given parameters.
    Returns the Sharpe ratio of the simulated PnL curve.
    """
    if len(trades) < 10:
        return -999.0  # Not enough data

    bankroll = 1.0  # Normalized
    returns = []

    # Compute rolling win/loss ratio from first 20% of trades
    warmup = max(10, len(trades) // 5)
    wins = [t['pnlPct'] for t in trades[:warmup] if t.get('pnlPct', 0) > 0]
    losses = [abs(t['pnlPct']) for t in trades[:warmup] if t.get('pnlPct', 0) < 0]
    avg_win = sum(wins) / len(wins) if wins else 5.0
    avg_loss = sum(losses) / len(losses) if losses else 5.0
    win_loss_ratio = max(0.1, min(10.0, avg_win / max(0.01, avg_loss)))

    # Simulate trades with Kelly sizing
    for trade in trades[warmup:]:
        pnl_pct = trade.get('pnlPct', 0)
        if pnl_pct is None:
            continue

        # Simple win probability estimate from entry confidence
        p = max(0.1, min(0.9, trade.get('confidenceScore', 0.5)))

        # Kelly fraction
        b = win_loss_ratio
        f_star = (p * b - (1 - p)) / b
        if f_star <= 0:
            continue  # Would have skipped this trade

        f_adj = f_star * params['kelly_fraction']

        # ATR-based sizing (use priceChange5m as volatility proxy)
        atr_proxy = abs(trade.get('entryMom5m', 5.0))
        atr_proxy = max(0.5, atr_proxy)
        stop_distance = atr_proxy * params['atr_multiplier']

        # Position size as fraction of bankroll
        size_frac = min(0.25, f_adj / (stop_distance / 100))

        # Simulated PnL
        trade_return = size_frac * (pnl_pct / 100)
        bankroll *= (1 + trade_return)
        returns.append(trade_return)

        if bankroll <= 0.01:
            break  # Blew up

    if len(returns) < 5:
        return -999.0

    # Sharpe ratio (annualized approximately)
    mean_return = sum(returns) / len(returns)
    if len(returns) < 2:
        return mean_return * 100

    variance = sum((r - mean_return) ** 2 for r in returns) / (len(returns) - 1)
    std_dev = math.sqrt(variance) if variance > 0 else 0.0001

    sharpe = mean_return / std_dev
    return sharpe


# ── Bayesian Optimization ──────────────────────────────────────────────────

def run_optimization(trades, n_calls=50):
    """
    Run Bayesian optimization to find the best parameters.
    Falls back to grid search if scikit-optimize is not available.
    """
    try:
        from skopt import gp_minimize
        from skopt.space import Real
        HAS_SKOPT = True
    except ImportError:
        HAS_SKOPT = False
        print('[BAYESIAN] scikit-optimize not installed, falling back to grid search')

    if HAS_SKOPT:
        space = [
            Real(PARAM_BOUNDS['atr_multiplier'][0], PARAM_BOUNDS['atr_multiplier'][1], name='atr_multiplier'),
            Real(PARAM_BOUNDS['kelly_fraction'][0], PARAM_BOUNDS['kelly_fraction'][1], name='kelly_fraction'),
            Real(PARAM_BOUNDS['regime_high_threshold'][0], PARAM_BOUNDS['regime_high_threshold'][1], name='regime_high_threshold'),
            Real(PARAM_BOUNDS['regime_low_threshold'][0], PARAM_BOUNDS['regime_low_threshold'][1], name='regime_low_threshold'),
            Real(PARAM_BOUNDS['regime_high_mult'][0], PARAM_BOUNDS['regime_high_mult'][1], name='regime_high_mult'),
            Real(PARAM_BOUNDS['regime_low_mult'][0], PARAM_BOUNDS['regime_low_mult'][1], name='regime_low_mult'),
        ]

        def objective(x):
            params = {
                'atr_multiplier': x[0],
                'kelly_fraction': x[1],
                'regime_high_threshold': x[2],
                'regime_low_threshold': x[3],
                'regime_high_mult': x[4],
                'regime_low_mult': x[5],
            }
            sharpe = simulate_kelly_pnl(trades, params)
            return -sharpe  # Minimize negative Sharpe = maximize Sharpe

        result = gp_minimize(objective, space, n_calls=n_calls, random_state=42,
                           n_initial_points=10, verbose=False)

        best_params = {
            'atr_multiplier': round(result.x[0], 3),
            'kelly_fraction': round(result.x[1], 3),
            'regime_high_threshold': round(result.x[2], 3),
            'regime_low_threshold': round(result.x[3], 3),
            'regime_high_mult': round(result.x[4], 3),
            'regime_low_mult': round(result.x[5], 3),
        }
        best_sharpe = -result.fun
        return best_params, best_sharpe

    else:
        # Grid search fallback
        return _grid_search(trades)


def _grid_search(trades, resolution=5):
    """Simple grid search over parameter space."""
    import itertools

    best_params = dict(DEFAULT_PARAMS)
    best_sharpe = simulate_kelly_pnl(trades, best_params)

    # Coarse grid over key parameters
    atr_range = [1.5, 2.0, 2.5, 3.0]
    kelly_range = [0.3, 0.4, 0.5, 0.6]
    high_thresh_range = [1.2, 1.3, 1.5]
    high_mult_range = [0.4, 0.5, 0.6]

    total = len(atr_range) * len(kelly_range) * len(high_thresh_range) * len(high_mult_range)
    tested = 0

    for atr, kelly, ht, hm in itertools.product(atr_range, kelly_range, high_thresh_range, high_mult_range):
        params = {
            'atr_multiplier': atr,
            'kelly_fraction': kelly,
            'regime_high_threshold': ht,
            'regime_low_threshold': 0.8,
            'regime_high_mult': hm,
            'regime_low_mult': 1.2,
        }
        sharpe = simulate_kelly_pnl(trades, params)
        tested += 1

        if sharpe > best_sharpe:
            best_sharpe = sharpe
            best_params = dict(params)

    print(f'[BAYESIAN] Grid search tested {tested} combinations')
    return best_params, best_sharpe


# ── Main ────────────────────────────────────────────────────────────────────

def main():
    print(f'[BAYESIAN] Starting optimization at {datetime.utcnow().isoformat()}Z')

    trades = load_recent_trades(days=7)
    print(f'[BAYESIAN] Loaded {len(trades)} trades from last 7 days')

    if len(trades) < 20:
        print('[BAYESIAN] Insufficient trades for optimization. Using defaults.')
        result = {
            'updatedAt': int(datetime.utcnow().timestamp() * 1000),
            'params': DEFAULT_PARAMS,
            'sharpe': 0,
            'tradeCount': len(trades),
            'method': 'defaults',
        }
    else:
        best_params, best_sharpe = run_optimization(trades)
        print(f'[BAYESIAN] Best Sharpe: {best_sharpe:.4f}')
        for k, v in best_params.items():
            print(f'  {k}: {v}')

        result = {
            'updatedAt': int(datetime.utcnow().timestamp() * 1000),
            'params': best_params,
            'sharpe': round(best_sharpe, 4),
            'tradeCount': len(trades),
            'method': 'bayesian' if 'skopt' in sys.modules else 'grid_search',
        }

    # Write results
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_FILE, 'w') as f:
        json.dump(result, f, indent=2)

    print(f'[BAYESIAN] Wrote optimized params to {OUTPUT_FILE}')
    return result


if __name__ == '__main__':
    # If running as PM2 service, run daily
    import time

    main()  # Initial run

    INTERVAL = 24 * 60 * 60  # 24 hours
    print(f'[BAYESIAN] Next optimization in {INTERVAL // 3600} hours')

    while True:
        time.sleep(INTERVAL)
        try:
            main()
        except Exception as e:
            print(f'[BAYESIAN] Optimization failed: {e}')
