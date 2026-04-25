#!/usr/bin/env python3
import json
import sys
import os
from collections import defaultdict

def load_journal(filepath):
    buys = {}
    sells = defaultdict(list)

    if not os.path.exists(filepath):
        return buys, sells

    with open(filepath, 'r', encoding='utf-8') as f:
        for line in f:
            if not line.strip():
                continue
            try:
                record = json.loads(line)
                action = record.get('action')
                if action == 'BUY':
                    # Only analyze slopfest (desperation_bypass) trades
                    if record.get('entryMode') == 'desperation_bypass':
                        buys[record.get('tradeId')] = record
                elif action == 'SELL':
                    parent_buy_id = record.get('parentBuyId')
                    if parent_buy_id:
                        sells[parent_buy_id].append(record)
            except json.JSONDecodeError:
                pass

    return buys, sells

def simulate_trade(buy_record, sell_records, hyp_params):
    """
    Simulates a trade outcome based on hypothetical parameters.
    Returns: (simulated_pnl_sol, simulated_hold_ms, exit_reason)
    or None if the trade was filtered out at entry.
    """
    # 1. Entry Filters
    vol5m = float(buy_record.get('volume5m', 0) or 0)
    mom5m = float(buy_record.get('momentum5m', 0) or 0)

    if vol5m < hyp_params.get('min_volume5m', 0):
        return None
    if mom5m < hyp_params.get('min_momentum5m', 0):
        return None

    # Determine peak PnL and total hold time
    peak_pnl_pct = max([float(s.get('rsi', 0) or 0) for s in sell_records], default=0.0)
    final_pnl_sol = sum([float(s.get('pnlSol', 0) or 0) for s in sell_records])
    entry_cost = float(buy_record.get('amountSol', 0) or 0)
    max_hold_ms = max([float(s.get('holdMs', 0) or 0) for s in sell_records], default=0.0)

    hyp_tp_pct = hyp_params.get('take_profit_pct', 999.0)
    hyp_sl_pct = hyp_params.get('stop_loss_pct', -999.0)
    hyp_trail_pct = hyp_params.get('trailing_stop_pct', 999.0)
    hyp_time_stop_ms = hyp_params.get('time_stop_ms', 99999999)

    # Simulation Logic (Conservative Approximation)
    # We assume price went linearly to Peak, then reversed.

    # Did it hit the hypothetical time stop before reaching peak?
    # Without tick data, if max_hold_ms > time_stop, we assume a forced exit.
    if max_hold_ms > hyp_time_stop_ms:
        # Penalize with flat loss (conservative)
        return (-0.02 * entry_cost, hyp_time_stop_ms, "HYP_TIME_STOP")

    # Did it hit the hypothetical Take Profit?
    if peak_pnl_pct >= hyp_tp_pct:
        return (hyp_tp_pct * entry_cost, max_hold_ms / 2, "HYP_TP_HIT")

    # Did it hit the hypothetical Stop Loss?
    # If the actual trade resulted in a massive loss worse than hyp_sl_pct, we cap it at hyp_sl.
    final_pnl_pct = final_pnl_sol / entry_cost if entry_cost > 0 else 0
    if final_pnl_pct <= hyp_sl_pct:
        return (hyp_sl_pct * entry_cost, max_hold_ms / 2, "HYP_SL_HIT")

    # Did it hit the hypothetical Trailing Stop?
    if peak_pnl_pct > 0:
        hyp_retrace_pct = peak_pnl_pct - hyp_trail_pct
        if final_pnl_pct <= hyp_retrace_pct:
            return (hyp_retrace_pct * entry_cost, max_hold_ms, "HYP_TRAIL_HIT")

    # Otherwise, assume actual outcome
    return (final_pnl_sol, max_hold_ms, "ACTUAL_EXIT")

def run_backtest(journal_path, hyp_params):
    buys, sells = load_journal(journal_path)

    actual_trades = 0
    actual_wins = 0
    actual_pnl = 0.0
    actual_hold = 0.0

    sim_trades = 0
    sim_wins = 0
    sim_pnl = 0.0
    sim_hold = 0.0

    print(f"Loaded {len(buys)} Slopfest entries from {journal_path}")

    for trade_id, buy_record in buys.items():
        sell_records = sells.get(trade_id, [])
        if not sell_records:
            continue # Trade still open or orphan

        # Actual Stats
        total_pnl = sum([float(s.get('pnlSol', 0) or 0) for s in sell_records])
        max_hold = max([float(s.get('holdMs', 0) or 0) for s in sell_records], default=0.0)

        actual_trades += 1
        actual_pnl += total_pnl
        actual_hold += max_hold
        if total_pnl > 0:
            actual_wins += 1

        # Simulated Stats
        sim_result = simulate_trade(buy_record, sell_records, hyp_params)
        if sim_result is not None:
            s_pnl, s_hold, s_reason = sim_result
            sim_trades += 1
            sim_pnl += s_pnl
            sim_hold += s_hold
            if s_pnl > 0:
                sim_wins += 1

    print("\n" + "="*50)
    print("BACKTEST RESULTS (SLOPFEST)")
    print("="*50)

    print("\n[HYPOTHETICAL PARAMETERS]")
    for k, v in hyp_params.items():
        print(f"  {k}: {v}")

    print("\n[ACTUAL STRATEGY]")
    print(f"  Trades:   {actual_trades}")
    print(f"  Win Rate: {(actual_wins/max(1, actual_trades))*100:.1f}%")
    print(f"  Net PnL:  {actual_pnl:+.4f} SOL")
    print(f"  Avg Hold: {(actual_hold/max(1, actual_trades))/1000:.1f}s")

    print("\n[SIMULATED STRATEGY]")
    print(f"  Trades:   {sim_trades}")
    print(f"  Win Rate: {(sim_wins/max(1, sim_trades))*100:.1f}%")
    print(f"  Net PnL:  {sim_pnl:+.4f} SOL")
    print(f"  Avg Hold: {(sim_hold/max(1, sim_trades))/1000:.1f}s")

    print("\n[DELTA]")
    print(f"  PnL Diff: {(sim_pnl - actual_pnl):+.4f} SOL")
    print("="*50)

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Slopfest Offline Backtester")
    parser.add_argument("--journal", type=str, default="signals/trade_journal.jsonl", help="Path to trade_journal.jsonl")
    parser.add_argument("--min_vol", type=float, default=0, help="Minimum 5m Volume (USD)")
    parser.add_argument("--min_mom", type=float, default=0, help="Minimum 5m Momentum (%)")
    parser.add_argument("--trail", type=float, default=0.05, help="Trailing Stop (%)")
    parser.add_argument("--time_stop", type=int, default=120000, help="Time Stop (ms)")

    args = parser.parse_args()

    hyp_params = {
        'min_volume5m': args.min_vol,
        'min_momentum5m': args.min_mom,
        'trailing_stop_pct': args.trail,
        'time_stop_ms': args.time_stop,
        'stop_loss_pct': -0.10,
        'take_profit_pct': 0.50
    }

    base_path = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    full_journal_path = os.path.join(base_path, args.journal)

    if not os.path.exists(full_journal_path):
        # try local to script
        full_journal_path = os.path.join(os.getcwd(), args.journal)

    run_backtest(full_journal_path, hyp_params)
