#!/usr/bin/env python3
"""
Gemma 4 Auto-Refiner — Runs on a schedule, analyzes trade data,
and pushes refined parameters to the live sniper via Redis.
Deployed as a PM2 process with a built-in sleep loop.
"""
import hashlib
import json, os, sys, time, subprocess, io, re, socket
import urllib.request
import urllib.error
from dotenv import load_dotenv

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.environ.get('PCP_ROOT') or os.path.join(SCRIPT_DIR, '..', '..'))

load_dotenv(os.path.join(PROJECT_ROOT, '.env'))
load_dotenv()

from datetime import datetime, timezone
# ── FIX: Windows console encoding for emoji (MUST be before any print) ────────
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace', line_buffering=True, write_through=True)
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace', line_buffering=True, write_through=True)

PAPER_MODE = os.environ.get('PAPER_MODE', '').lower() == 'true'
SIGNALS_DIR = os.path.join(PROJECT_ROOT, 'signals')
JOURNAL = os.path.join(SIGNALS_DIR, 'trade_journal_paper.jsonl' if PAPER_MODE else 'trade_journal.jsonl')
FALLBACK_JOURNAL = os.path.join(SIGNALS_DIR, 'trade_journal.jsonl')
MISSED  = os.path.join(SIGNALS_DIR, 'missed_targets.jsonl')
RECS    = os.path.join(SIGNALS_DIR, 'slopfest_recommendations.json')
WALLET_SIGNALS = os.path.join(SIGNALS_DIR, 'wallet_signals.json')
WALLET_PNL_FILE = os.path.join(SIGNALS_DIR, 'wallet_pnl.json')
ALPHA_WALLETS = os.path.join(SIGNALS_DIR, 'alpha_wallets.json')
KOL_WALLETS = os.path.join(SIGNALS_DIR, 'kol_wallets.json')
FOLLOW_MONITOR = os.path.join(SIGNALS_DIR, 'gmgn_follow_monitor.json')
VELOCITY_FILE = os.path.join(SIGNALS_DIR, 'velocity.json')
TRENDING_FILE = os.path.join(SIGNALS_DIR, 'trending.json')
BAYESIAN_FILE = os.path.join(SIGNALS_DIR, 'bayesian_params.json')
BAYESIAN_FILE = os.path.join(SIGNALS_DIR, 'bayesian_params.json')
REALIZED_PROFIT_FILE = os.path.join(SIGNALS_DIR, 'realized_profit_paper.json' if PAPER_MODE else 'realized_profit.json')
SWARM_DIR = os.path.join(SIGNALS_DIR, 'swarm')
BACKTEST_RESULTS_FILE = os.path.join(SWARM_DIR, 'backtest_results.json')
SNIPER_TS = os.path.join(PROJECT_ROOT, 'scripts', 'maintain', 'momentum_sniper.ts')
INTERVAL_SECONDS = int(os.environ.get('GEMMA4_INTERVAL_SECONDS', '900'))  # Run every 15 minutes
MIN_TRADE_SAMPLE = 10
LOOKBACK_HOURS = float(os.environ.get('GEMMA4_LOOKBACK_HOURS', '6'))
OLLAMA_URL = os.environ.get('OLLAMA_URL', 'http://127.0.0.1:11434/api/chat')
OLLAMA_MODEL = os.environ.get('GEMMA4_MODEL') or os.environ.get('OLLAMA_MODEL') or 'dmind-risk'
LIVE_INFERENCE_ENABLED = os.environ.get('GEMMA4_LIVE_INFERENCE', 'true').lower() != 'false'
OLLAMA_TIMEOUT_SECONDS = int(os.environ.get('GEMMA4_TIMEOUT_SECONDS', '600'))
OLLAMA_RETRY_COUNT = int(os.environ.get('GEMMA4_RETRY_COUNT', '2'))
OLLAMA_RETRY_BACKOFF_SECONDS = float(os.environ.get('GEMMA4_RETRY_BACKOFF_SECONDS', '3'))
OLLAMA_RETRY_TIMEOUT_SECONDS = int(os.environ.get('GEMMA4_RETRY_TIMEOUT_SECONDS', str(max(180, OLLAMA_TIMEOUT_SECONDS))))
DATA_ROOT = os.path.join(PROJECT_ROOT, 'signals')
SIGNAL_DB_PATH = os.path.join(PROJECT_ROOT, 'signals', 'signal_history.sqlite')
GHOST_SIG_PREFIX = 'PAPER_TRADE_'

# Safety bounds — Gemma 4 can never push outside these
BOUNDS = {
    'min_5m_change':       (1, 10),    # 1-10%
    'min_liquidity_usd':   (5000, 50000),
    'min_volume_5m':       (0, 5000),
    'max_top10_holder_pct':(20, 60),
    'tp1_pct':             (4, 25),
    'stop_loss_pct':       (3, 20),
    'max_hold_minutes':    (2, 10),
}

CYCLE_LOCK = None
SOURCE_KEYS = ['velocity', 'bridge', 'follow-monitor', 'wallet', 'hybrid', 'market', 'unknown']

def clamp(val, lo, hi):
    return max(lo, min(hi, val))

def try_float(value, default=None):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default

def calculate_profit_seeking_score(pnl_sol):
    pnl = try_float(pnl_sol, 0) or 0
    if pnl > 0:
        return (pnl ** 2) * 100
    if pnl < 0:
        return -((abs(pnl) ** 2) * 200)
    return 0.0

def round_metric(value, digits=6):
    numeric = try_float(value, 0) or 0
    return round(numeric, digits)

def summarize_profit_seeking_pairs(pairs):
    positive_score = 0.0
    negative_score_abs = 0.0
    total_score = 0.0
    for pair in pairs or []:
        score = calculate_profit_seeking_score(pair.get('pnl', 0))
        total_score += score
        if score > 0:
            positive_score += score
        elif score < 0:
            negative_score_abs += abs(score)
    if negative_score_abs > 0:
        psr = positive_score / negative_score_abs
    elif positive_score > 0:
        psr = 100.0
    else:
        psr = 0.0
    return {
        'positive_score': round(positive_score, 6),
        'negative_score_abs': round(negative_score_abs, 6),
        'total_score': round(total_score, 6),
        'psr': round(psr, 6),
    }

def parse_timestamp_ms(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        numeric = int(value)
        return numeric if numeric > 10_000_000_000 else numeric * 1000
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        numeric = try_float(stripped)
        if numeric is not None:
            numeric = int(numeric)
            return numeric if numeric > 10_000_000_000 else numeric * 1000
        try:
            iso = datetime.fromisoformat(stripped.replace('Z', '+00:00'))
            return int(iso.timestamp() * 1000)
        except ValueError:
            return None
    return None

def event_timestamp_ms(item):
    for key in ('ts', 'timestamp', 'fallbackTimestamp', 'updated_at', 'generated_at'):
        parsed = parse_timestamp_ms(item.get(key))
        if parsed is not None:
            return parsed
    return None

def in_lookback_window(item, cutoff_ms):
    event_ms = event_timestamp_ms(item)
    if event_ms is None:
        return True
    return event_ms >= cutoff_ms

def sanitize_filters(filters):
    cleaned = {}
    if isinstance(filters, list):
        filters = filters[0] if len(filters) > 0 and isinstance(filters[0], dict) else {}
    for key, value in (filters or {}).items():
        if key not in BOUNDS:
            continue
        numeric = try_float(value)
        if numeric is None:
            continue
        lo, hi = BOUNDS[key]
        cleaned[key] = clamp(numeric, lo, hi)
    return cleaned

def normalize_signal_source(value):
    raw = str(value or '').strip().lower().replace('_', '-')
    if not raw:
        return 'unknown'
    if 'follow' in raw:
        return 'follow-monitor'
    if 'wallet' in raw or 'alpha' in raw:
        return 'wallet'
    if 'velocity' in raw:
        return 'velocity'
    if 'bridge' in raw or 'gmgn' in raw:
        return 'bridge'
    if 'hybrid' in raw:
        return 'hybrid'
    if 'market' in raw:
        return 'market'
    return 'unknown'

def parse_entry_reason_snapshot(reason):
    text = str(reason or '')
    match = re.search(r'(?P<chg>-?\d+(?:\.\d+)?)%/1h\s+(?P<buys>\d+)B/(?P<sells>\d+)S', text)
    if not match:
        return {}
    buys = int(match.group('buys'))
    sells = int(match.group('sells'))
    return {
        'price_chg_1h': float(match.group('chg')),
        'buys': buys,
        'sells': sells,
        'buy_ratio': (buys / sells) if sells > 0 else float(buys),
    }

def infer_signal_source(buy, sell=None):
    explicit = normalize_signal_source((buy or {}).get('signalSource') or (sell or {}).get('signalSource'))
    if explicit != 'unknown':
        return explicit
    ta_sig = str((buy or {}).get('taSig') or (sell or {}).get('taSig') or '')
    if ta_sig.startswith('ALPHA_'):
        return 'wallet'
    momentum5m = try_float((buy or {}).get('momentum5m'), 0) or 0
    price_chg_1h = parse_entry_reason_snapshot((buy or {}).get('reason')).get('price_chg_1h', 0)
    if momentum5m >= 45 or price_chg_1h >= 45:
        return 'velocity'
    if momentum5m <= 1 and price_chg_1h <= 1:
        return 'bridge'
    return 'market'

def is_ghost_trade(trade):
    sig = str((trade or {}).get('sig') or (trade or {}).get('signature') or '')
    mode = str((trade or {}).get('mode') or (trade or {}).get('entryMode') or '').strip().lower()
    return sig.startswith(GHOST_SIG_PREFIX) or mode == 'paper' or mode == 'desperation_bypass'


def select_replay_pairs(pairs):
    slopfest_pairs = [p for p in (pairs or []) if p.get('slopfest_id')]
    broad_pairs = [
        p for p in (pairs or [])
        if p.get('entry_volume5m') is not None or p.get('entry_momentum5m') is not None
    ]
    if len(slopfest_pairs) >= MIN_TRADE_SAMPLE:
        return slopfest_pairs, 'slopfest'
    if broad_pairs:
        return broad_pairs, 'all_recent'
    return [], 'none'


def _build_grid_recommended_filters(candidate, base_filters=None):
    merged = dict(base_filters or {})
    merged['min_5m_change'] = clamp(round_metric(candidate.get('minMomentum', 0), 3), *BOUNDS['min_5m_change'])
    merged['min_volume_5m'] = clamp(round_metric(candidate.get('minVolume', 0), 3), *BOUNDS['min_volume_5m'])
    merged['tp1_pct'] = clamp(round_metric((candidate.get('takeProfit', 0) or 0) * 100, 3), *BOUNDS['tp1_pct'])
    if 'max_hold_minutes' in merged:
        merged['max_hold_minutes'] = clamp(round_metric(merged.get('max_hold_minutes', 0), 3), *BOUNDS['max_hold_minutes'])
    if 'stop_loss_pct' in merged:
        merged['stop_loss_pct'] = clamp(round_metric(merged.get('stop_loss_pct', 0), 3), *BOUNDS['stop_loss_pct'])
    if 'min_liquidity_usd' in merged:
        merged['min_liquidity_usd'] = clamp(round_metric(merged.get('min_liquidity_usd', 0), 3), *BOUNDS['min_liquidity_usd'])
    if 'max_top10_holder_pct' in merged:
        merged['max_top10_holder_pct'] = clamp(round_metric(merged.get('max_top10_holder_pct', 0), 3), *BOUNDS['max_top10_holder_pct'])
    return merged

def generate_autonomous_grid_search_results(pairs, base_filters=None):
    replay_pairs, _replay_scope = select_replay_pairs(pairs)
    if not replay_pairs:
        return []

    vol_floors = [0, 500, 1000, 2500, 5000]
    mom_floors = [0.0, 2.0, 5.0, 10.0, 20.0]
    trails = [0.03, 0.05, 0.08, 0.12]
    tps = [0.20, 0.50, 1.00]

    results = []

    for v in vol_floors:
        for m in mom_floors:
            for tr in trails:
                for tp in tps:
                    sim_pnl = 0
                    sim_score = 0
                    simulated_pairs = []
                    sim_trades = 0
                    for p in replay_pairs:
                        if p.get('entry_volume5m', 0) < v: continue
                        if p.get('entry_momentum5m', 0) < m: continue

                        sim_trades += 1
                        peak = p.get('peak_pnl_pct', 0)
                        actual_pnl = p.get('pnl', 0)
                        entry_cost = 0.01 # micro-scout assumption

                        if peak >= tp:
                            realized_pnl = tp * entry_cost
                        elif peak > 0 and (peak - tr) >= actual_pnl:
                            realized_pnl = (peak - tr) * entry_cost
                        else:
                            realized_pnl = actual_pnl

                        sim_pnl += realized_pnl
                        sim_score += calculate_profit_seeking_score(realized_pnl)
                        simulated_pairs.append({'pnl': realized_pnl})

                    if sim_trades < 3:
                        continue
                    score_summary = summarize_profit_seeking_pairs(simulated_pairs)
                    positive_pnl = sum(max(0, try_float(p.get('pnl'), 0) or 0) for p in simulated_pairs)
                    negative_pnl_abs = sum(abs(min(0, try_float(p.get('pnl'), 0) or 0)) for p in simulated_pairs)
                    win_count = sum(1 for p in simulated_pairs if (try_float(p.get('pnl'), 0) or 0) > 0)
                    profit_factor = positive_pnl / negative_pnl_abs if negative_pnl_abs > 0 else (positive_pnl if positive_pnl > 0 else 0)
                    base_candidate = {
                        'minVolume': v,
                        'minMomentum': m,
                        'trailingStop': tr,
                        'takeProfit': tp,
                        'simulated_pnl': round_metric(sim_pnl),
                        'simulated_profit_score': round_metric(sim_score),
                        'simulated_psr': round_metric(score_summary.get('psr', 0)),
                        'simulated_trades': sim_trades,
                        'win_rate': round_metric((win_count / max(sim_trades, 1)) * 100, 2),
                        'profit_factor': round_metric(profit_factor),
                        'positive_pnl_sol': round_metric(positive_pnl),
                        'negative_pnl_sol_abs': round_metric(negative_pnl_abs),
                    }
                    recommended_filters = _build_grid_recommended_filters(base_candidate, base_filters=base_filters)
                    signature = {
                        'minVolume': v,
                        'minMomentum': m,
                        'trailingStop': tr,
                        'takeProfit': tp,
                        'recommended_filters': recommended_filters,
                    }
                    base_candidate['param_hash'] = hashlib.sha1(
                        json.dumps(signature, sort_keys=True).encode('utf-8')
                    ).hexdigest()[:12]
                    base_candidate['fitness'] = base_candidate['simulated_profit_score']
                    base_candidate['trades_sim'] = base_candidate['simulated_trades']
                    base_candidate['total_pnl_sol'] = base_candidate['simulated_pnl']
                    base_candidate['profit_seeking_ratio'] = base_candidate['simulated_psr']
                    base_candidate['recommended_filters'] = recommended_filters
                    base_candidate['min_volume_5m'] = v
                    base_candidate['min_momentum5m'] = m
                    base_candidate['trailing_stop_pct'] = round_metric(tr * 100, 3)
                    base_candidate['take_profit_pct'] = round_metric(tp * 100, 3)
                    base_candidate['min_volume_1h'] = v
                    base_candidate['min_price_chg_1h'] = m
                    base_candidate['recency_gate_min'] = recommended_filters.get('max_hold_minutes')
                    base_candidate['tp_pct'] = recommended_filters.get('tp1_pct')
                    base_candidate['sl_pct'] = recommended_filters.get('stop_loss_pct')
                    base_candidate['trail_activate_pct'] = round_metric(tp * 100, 3)
                    base_candidate['trail_lock_pct'] = round_metric(tr * 100, 3)
                    results.append(base_candidate)

    results.sort(
        key=lambda item: (
            item.get('fitness', 0),
            item.get('total_pnl_sol', 0),
            item.get('win_rate', 0),
            item.get('profit_factor', 0),
        ),
        reverse=True,
    )
    return results

def run_autonomous_grid_search(pairs, base_filters=None):
    results = generate_autonomous_grid_search_results(pairs, base_filters=base_filters)
    return results[0] if results else None

def persist_swarm_backtest_results(pairs, recs):
    base_filters = ((recs or {}).get('recommended_filters') or {})
    slopfest_pair_count = len([p for p in (pairs or []) if p.get('slopfest_id')])
    replay_pairs, replay_scope = select_replay_pairs(pairs)
    results = generate_autonomous_grid_search_results(pairs, base_filters=base_filters)
    payload = {
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'optimizer': 'gemma4_slopfest_refiner',
        'mode': 'paper' if PAPER_MODE else 'live',
        'journal_file': JOURNAL,
        'lookback_hours': LOOKBACK_HOURS,
        'pair_count': len(pairs or []),
        'slopfest_pair_count': slopfest_pair_count,
        'replay_pair_count': len(replay_pairs),
        'replay_scope': replay_scope,
        'results': results[:25],
    }
    os.makedirs(SWARM_DIR, exist_ok=True)
    with open(BACKTEST_RESULTS_FILE, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle, indent=2)
    return payload

def run_swarm_memory_cycle():
    try:
        from swarm_memory_agent import run as run_memory_agent
        return run_memory_agent()
    except Exception as exc:
        print(f'[GEMMA4] Memory agent skipped: {exc}')
        return {}

def collapse_trade_lifecycles(trades):
    buys = []
    grouped_sells = {}
    for trade in trades:
        action = trade.get('action') or trade.get('side')
        if action == 'BUY':
            buys.append(trade)
            continue
        if action != 'SELL':
            continue
        if trade.get('reason') == 'orphan-recovery':
            continue
        parent = trade.get('parentBuyId')
        if not parent:
            continue
        grouped_sells.setdefault(parent, []).append(trade)

    final_sells = []
    for parent, group in grouped_sells.items():
        deduped = {}
        for sell in group:
            dedupe_key = (
                sell.get('sig') or '',
                sell.get('reason') or '',
                round(try_float(sell.get('amountSol'), 0) or 0, 9),
                round(try_float(sell.get('pnlSol'), 0) or 0, 9),
            )
            deduped[dedupe_key] = sell
        rows = list(deduped.values())
        rows.sort(key=lambda s: (
            0 if 'PARTIAL_TP_HIT' in str(s.get('reason', '')) else 1,
            try_float(s.get('lifecyclePnlSol'), try_float(s.get('pnlSol'), 0) or 0) or 0,
            try_float(s.get('holdMs'), 0) or 0,
            event_timestamp_ms(s) or 0,
        ))
        final_sells.append(rows[-1])
    return buys, final_sells

def summarize_source_performance(pairs):
    summary = {}
    for source in SOURCE_KEYS:
        group = [p for p in pairs if normalize_signal_source(p.get('signal_source')) == source]
        if not group:
            continue
        wins = [p for p in group if p.get('pnl', 0) > 0]
        losses = [p for p in group if p.get('pnl', 0) <= 0]
        summary[source] = {
            'count': len(group),
            'win_count': len(wins),
            'loss_count': len(losses),
            'win_rate': round((len(wins) / max(len(group), 1)) * 100, 2),
            'total_pnl_sol': round(sum(p.get('pnl', 0) or 0 for p in group), 6),
            'avg_pnl_pct': round(sum(p.get('pnl_pct', 0) or 0 for p in group) / max(len(group), 1), 3),
            'avg_hold_s': round(sum(p.get('hold_s', 0) or 0 for p in group) / max(len(group), 1), 2),
            'avg_entry_momentum5m': round(sum(p.get('entry_momentum5m', 0) or 0 for p in group) / max(len(group), 1), 3),
            'avg_entry_price_chg_1h': round(sum(p.get('entry_price_chg_1h', 0) or 0 for p in group) / max(len(group), 1), 3),
            'avg_buy_ratio': round(sum(p.get('entry_buy_ratio', 0) or 0 for p in group) / max(len(group), 1), 3),
        }
    return summary

def build_source_policy(source_performance):
    policy = {}
    for source in SOURCE_KEYS:
        row = source_performance.get(source, {}) or {}
        count = int(row.get('count', 0) or 0)
        win_rate = try_float(row.get('win_rate'), 0) or 0
        total_pnl = try_float(row.get('total_pnl_sol'), 0) or 0
        avg_hold = try_float(row.get('avg_hold_s'), 0) or 0
        current = {
            'scoreAdjustment': 0.0,
            'minScoreOffset': 0.0,
            'reqBuysScale': 1.0,
            'reqRatioScale': 1.0,
            'minLiquidityScale': 1.0,
            'minVolume5mScale': 1.0,
            'sampleSize': count,
            'winRate': round(win_rate, 2),
            'totalPnlSol': round(total_pnl, 6),
        }
        if count >= 3 and source == 'hybrid' and (win_rate < 25 or total_pnl < 0):
            current.update({
                'scoreAdjustment': -0.55,
                'minScoreOffset': 0.55,
                'reqBuysScale': 1.12,
                'reqRatioScale': 1.15,
                'minLiquidityScale': 1.08,
                'minVolume5mScale': 1.12,
            })
        elif count >= 5:
            if source in ('bridge', 'market') and (win_rate < 22 or total_pnl < 0):
                current.update({
                    'scoreAdjustment': -0.45,
                    'minScoreOffset': 0.45,
                    'reqBuysScale': 1.15,
                    'reqRatioScale': 1.12,
                    'minLiquidityScale': 1.12,
                    'minVolume5mScale': 1.1,
                })
            elif source == 'velocity' and (win_rate < 28 or total_pnl < 0):
                current.update({
                    'scoreAdjustment': -0.35,
                    'minScoreOffset': 0.4,
                    'reqBuysScale': 1.1,
                    'reqRatioScale': 1.12,
                    'minLiquidityScale': 1.05,
                    'minVolume5mScale': 1.1,
                })
            elif source in ('follow-monitor', 'wallet') and win_rate >= 40 and total_pnl >= 0:
                current.update({
                    'scoreAdjustment': 0.35 if source == 'wallet' else 0.3,
                    'minScoreOffset': -0.25 if source == 'wallet' else -0.2,
                    'reqBuysScale': 0.92 if source == 'wallet' else 0.95,
                    'reqRatioScale': 0.92 if source == 'wallet' else 0.95,
                    'minLiquidityScale': 0.92 if source == 'follow-monitor' else 0.95,
                    'minVolume5mScale': 0.9 if source == 'follow-monitor' else 0.95,
                })
        if avg_hold > 180 and total_pnl < 0:
            current['minScoreOffset'] = round(current['minScoreOffset'] + 0.1, 3)
            current['minVolume5mScale'] = round(current['minVolume5mScale'] + 0.05, 3)
        policy[source] = current
    return policy

def build_llm_prompt(pairs, missed, wallet_ctx, base_recs, entry_analysis, signal_profile=None, live_signal_context=None):
    wins = [p for p in pairs if p['pnl'] > 0]
    losses = [p for p in pairs if p['pnl'] <= 0]
    profit_objective = summarize_profit_seeking_pairs(pairs)
    miss_counts = {}
    for item in missed[-150:]:
        reason = item.get('reason', 'unknown')
        miss_counts[reason] = miss_counts.get(reason, 0) + 1
    top_misses = sorted(miss_counts.items(), key=lambda kv: kv[1], reverse=True)[:8]
    sample_pairs = []
    for pair in pairs[-12:]:
        sample_pairs.append({
            'pnl_pct': round(pair.get('pnl_pct', 0), 3),
            'hold_s': round(pair.get('hold_s', 0), 2),
            'exit': pair.get('exit', ''),
            'success': bool(pair.get('success')),
        })

    param_performance = {}
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

    compact = {
        'mode': 'LIVE' if not PAPER_MODE else 'PAPER',
        'base': base_recs.get('recommended_filters', {}),
        'confidence': base_recs.get('confidence'),
        'win_rate': round((len(wins) / max(len(pairs), 1)) * 100, 2),
        'avg_win_pct': round(sum(p.get('pnl_pct', 0) for p in wins) / max(len(wins), 1), 3) if wins else 0,
        'avg_loss_pct': round(sum(p.get('pnl_pct', 0) for p in losses) / max(len(losses), 1), 3) if losses else 0,
        'profit_objective': {
            **profit_objective,
            'realized_summary': wallet_ctx.get('realized_profit_summary', {}) or {},
        },
        'wallets': {
            'active': wallet_ctx.get('active_buy_count', 0),
            'executable': wallet_ctx.get('executable_buy_count', 0),
            'kol': wallet_ctx.get('kol_signal_count', 0),
            'kol_confirmed': wallet_ctx.get('kol_confirmed_buy_count', 0),
            'boost': wallet_ctx.get('position_boost', 1.0),
        },
        'missed': top_misses[:5],
        'entry_window': (entry_analysis or {}).get('best_entry_window'),
        'recent_pairs': sample_pairs[:6],
        'signal_profile': signal_profile or {},
        'source_performance': (base_recs or {}).get('source_performance', {}),
        'source_policy': (base_recs or {}).get('source_policy', {}),
        'live_signals': live_signal_context or {},
        'bounds': BOUNDS,
        'top_performing_params': top_params,
        'bottom_performing_params': bottom_params,
    }

    best_profile_msg = ""
    optimal = run_autonomous_grid_search(pairs, base_filters=(base_recs or {}).get('recommended_filters'))
    if optimal:
        best_profile_msg = (
            f"### AUTONOMOUS BACKTESTER RESULTS\n"
            f"The system has mathematically backtested thousands of parameter permutations against the recent trades.\n"
            f"The OPTIMAL configuration that would have maximized PnL in this exact market terrain is:\n"
            f"- minVolume: ${optimal['minVolume']}\n"
            f"- minMomentum: {optimal['minMomentum']}%\n"
            f"- trailingStop: {optimal['trailingStop'] * 100}%\n"
            f"- takeProfit: {optimal['takeProfit'] * 100}%\n"
            f"(Simulated PnL: +{optimal['simulated_pnl']:.4f} SOL | score {optimal.get('simulated_profit_score', 0):.4f} | PSR {optimal.get('simulated_psr', 0):.2f} across {optimal['simulated_trades']} trades)\n\n"
            f"Use these mathematical truths as your baseline when generating the new configuration.\n\n"
        )

    PROMPT = f"""
You are the Slopfest Refiner for the Antigravity Pipeline, an autonomous HFT swarm on Solana.
{best_profile_msg}Your input context contains the recent trade journal history of trades explicitly executed during "desperation bypass" (extremely low-liquidity, high-risk, messy meme-coin launches). Your output must be a strict JSON object.

### MISSION OBJECTIVE
Your goal is to become the most efficient "trash-picker" on the chain. Do NOT try to avoid the trash by raising liquidity floors.
Maximize Net Realized SOL Profit by identifying the microscopic differences between the 80% that instantly rug and the 20% that explode into massive runners.

### CRITICAL RULES FOR SLOPFEST MODE
1. EXPECT LOSSES: Accept that the win rate will be low. The goal is asymmetrical returns (small rapid losses, massive trailing wins).
2. DO NOT RAISE LIQUIDITY FLOORS: Keep `min_liquidity_usd` extremely low (e.g. 0 to 2000). The 100x returns come from tokens with near-zero initial liquidity.
3. FIND THE SIGNAL: Focus on `min_5m_change`, `min_volume_5m`, and `buy_ratio`. What did the few winners have in common right before they launched?

### PHASE 3: PARAMETER FEEDBACK LOOP
Here are the aggregated performance metrics of the previous parameter combinations you suggested:
{json.dumps({'top_performers': top_params, 'bottom_performers': bottom_params}, indent=2)}

CRITICAL INSTRUCTION: Improve upon the top performers while avoiding characteristics of the bottom performers. Do NOT raise liquidity floors. Focus on momentum and volume tuning.

### ANALYSIS TASKS (Chain-of-Thought Required)
Before finalizing the JSON, reason through the following steps internally. Be ruthlessly data-driven.
- **Step 1:** Analyze the Winners vs Losers in the recent pairs. Even if there are 20 losers and 1 winner, focus heavily on the metrics of that 1 winner.
- **Step 2:** Calibration. Determine the absolute minimum momentum or volume needed to filter out the stagnant "duds" without filtering out the messy runners.
- **Step 3:** Time and Take-Profit. Since these are highly volatile, should `tp1_pct` be higher to secure principal instantly? Should `stop_loss_pct` be tighter to cut losses instantly before a rug completes?

### OUTPUT FORMAT (STRICT JSON)
You MUST return ONLY a JSON payload. Do not include markdown blocks or text outside the JSON.
{{
  "analysis": "string detailing your Step 1-3 Chain-of-Thought findings.",
  "key_insight": "A single sentence summarizing the critical change logic for trash-picking.",
  "confidence": 85,
  "recommended_filters": {{
    "min_5m_change": 0.0,
    "min_liquidity_usd": 0.0,
    "min_volume_5m": 0.0,
    "max_top10_holder_pct": 0.0,
    "tp1_pct": 0.0,
    "stop_loss_pct": 0.0,
    "max_hold_minutes": 0,
    "overbought_ceiling": 0.0
  }}
}}

### CONSTRAINT ENFORCEMENT
- Safety Limit: Never set `stop_loss_pct` above 20 or below 2.
- Data Integration Context limits: {json.dumps(compact, ensure_ascii=True, separators=(',', ':'))}
"""
    return PROMPT.strip()

def compact_live_signal_context(live_signal_context):
    live_signal_context = live_signal_context or {}
    follow = live_signal_context.get('follow_monitor') or {}
    trending = live_signal_context.get('trending') or {}
    velocity = live_signal_context.get('velocity') or {}
    return {
        'follow_monitor': {
            'enabled': bool(follow.get('enabled')),
            'count': int(follow.get('count', 0) or 0),
            'top_tokens': (follow.get('top_tokens') or [])[:2],
        },
        'trending': {
            'count': int(trending.get('count', 0) or 0),
            'top_bridge_tokens': (trending.get('top_bridge_tokens') or [])[:2],
        },
        'velocity': {
            'available': bool(velocity.get('available')),
            'count': int(velocity.get('count', 0) or 0),
            'top_mints': (velocity.get('top_mints') or [])[:2],
        },
        'profile_match_count': int(live_signal_context.get('profile_match_count', 0) or 0),
        'profile_matches': (live_signal_context.get('profile_matches') or [])[:2],
    }

def compact_signal_profile(signal_profile):
    signal_profile = signal_profile or {}
    return {
        'sample_size': int(signal_profile.get('sample_size', 0) or 0),
        'winner_count': int(signal_profile.get('winner_count', 0) or 0),
        'loser_count': int(signal_profile.get('loser_count', 0) or 0),
        'preferred_profile': signal_profile.get('preferred_profile') or {},
        'winners': signal_profile.get('winners') or {},
        'losers': signal_profile.get('losers') or {},
        'source_performance': signal_profile.get('source_performance') or {},
    }

def extract_json_block(text):
    if not text:
        return None
    text = text.strip()
    try:
        parsed = json.loads(text)
        return parsed[0] if isinstance(parsed, list) and len(parsed) > 0 else parsed
    except Exception:
        pass
    match = re.search(r'\{.*\}', text, re.DOTALL)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
        return parsed[0] if isinstance(parsed, list) and len(parsed) > 0 else parsed
    except Exception:
        return None

def query_ollama_json(prompt, timeout_seconds=None):
    payload = json.dumps({
        'model': OLLAMA_MODEL,
        'messages': [{'role': 'user', 'content': prompt}],
        'stream': False,
        'format': 'json',
        'think': False,
    }).encode('utf-8')
    request = urllib.request.Request(
        OLLAMA_URL,
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    with urllib.request.urlopen(request, timeout=(timeout_seconds or OLLAMA_TIMEOUT_SECONDS)) as response:
        body = response.read().decode('utf-8', errors='replace')
    parsed = json.loads(body)
    content = (((parsed or {}).get('message') or {}).get('content') or '').strip()
    return extract_json_block(content), content

def query_ollama_with_retries(prompt, lean_prompt=None):
    attempts = max(1, OLLAMA_RETRY_COUNT)
    last_error = None
    raw_text = ''
    for attempt in range(1, attempts + 1):
        use_lean = attempt > 1 and bool(lean_prompt)
        timeout_seconds = OLLAMA_TIMEOUT_SECONDS if attempt == 1 else max(OLLAMA_TIMEOUT_SECONDS, OLLAMA_RETRY_TIMEOUT_SECONDS)
        active_prompt = lean_prompt if use_lean else prompt
        try:
            llm_json, raw_text = query_ollama_json(active_prompt, timeout_seconds=timeout_seconds)
            return llm_json, raw_text, {
                'attempts': attempt,
                'used_lean_prompt': use_lean,
                'timeout_seconds': timeout_seconds,
            }
        except (TimeoutError, socket.timeout) as e:
            last_error = f'timed out after {timeout_seconds}s'
        except urllib.error.URLError as e:
            reason = getattr(e, 'reason', e)
            if isinstance(reason, socket.timeout):
                last_error = f'timed out after {timeout_seconds}s'
            else:
                last_error = f'ollama_unreachable: {reason}'
        except Exception as e:
            last_error = str(e)
        if attempt < attempts:
            time.sleep(OLLAMA_RETRY_BACKOFF_SECONDS * attempt)
    raise RuntimeError(last_error or 'unknown_ollama_error')

def apply_live_inference(base_recs, pairs, missed, wallet_ctx, entry_analysis, signal_profile=None, live_signal_context=None):
    result = dict(base_recs)
    metadata = {
        'enabled': LIVE_INFERENCE_ENABLED,
        'model': OLLAMA_MODEL,
        'status': 'disabled' if not LIVE_INFERENCE_ENABLED else 'pending',
        'applied': False,
    }
    if not LIVE_INFERENCE_ENABLED:
        result['inference'] = metadata
        return result

    try:
        prompt = build_llm_prompt(pairs, missed, wallet_ctx, base_recs, entry_analysis, signal_profile, live_signal_context)
        lean_prompt = build_llm_prompt(
            pairs[-6:],
            missed[-40:],
            wallet_ctx,
            base_recs,
            entry_analysis,
            compact_signal_profile(signal_profile),
            compact_live_signal_context(live_signal_context),
        )
        llm_json, raw_text, attempt_meta = query_ollama_with_retries(prompt, lean_prompt=lean_prompt)
        if not llm_json:
            metadata['status'] = 'invalid_response'
            metadata['raw_excerpt'] = (raw_text or '')[:200]
            result['inference'] = metadata
            return result

        llm_filters = sanitize_filters((llm_json or {}).get('recommended_filters', {}))
        merged_filters = dict(base_recs.get('recommended_filters', {}))
        merged_filters.update(llm_filters)
        if (
            wallet_ctx.get('executable_buy_count', 0) == 0 and
            wallet_ctx.get('info_only_buy_count', 0) == 0 and
            base_recs.get('win_rate', 0) >= 35 and
            base_recs.get('total_pnl_sol', 0) >= 0
        ):
            merged_filters['min_liquidity_usd'] = clamp(min(merged_filters.get('min_liquidity_usd', 12000), 12000), *BOUNDS['min_liquidity_usd'])
            merged_filters['min_volume_5m'] = clamp(min(merged_filters.get('min_volume_5m', 500), 500), *BOUNDS['min_volume_5m'])
            merged_filters['overbought_ceiling'] = clamp(max(merged_filters.get('overbought_ceiling', 20), 20), 10, 50)
        result['recommended_filters'] = merged_filters

        llm_confidence = try_float((llm_json or {}).get('confidence'))
        if llm_confidence is not None:
            result['confidence'] = int(round(clamp(llm_confidence, 0, 100)))
        if (llm_json or {}).get('analysis'):
            result['analysis'] = str(llm_json.get('analysis'))
        if (llm_json or {}).get('key_insight'):
            result['key_insight'] = str(llm_json.get('key_insight'))

        metadata['status'] = 'applied'
        metadata['applied'] = True
        metadata['filter_keys'] = sorted(llm_filters.keys())
        metadata.update(attempt_meta)
        result['inference'] = metadata
        return result
    except Exception as e:
        metadata['status'] = f'error: {e}'
    result['inference'] = metadata
    return result

def load_trades():
    trades = load_recent_trade_events(LOOKBACK_HOURS, db_path=SIGNAL_DB_PATH)
    slopfest_trades = [trade for trade in trades if not is_ghost_trade(trade)]
    if len(slopfest_trades) >= MIN_TRADE_SAMPLE:
        return slopfest_trades
    if slopfest_trades and len(slopfest_trades) == len(trades):
        return slopfest_trades
    if slopfest_trades and len(slopfest_trades) < MIN_TRADE_SAMPLE and len(trades) > len(slopfest_trades):
        print(
            f'[GEMMA4] Slopfest sample undersized ({len(slopfest_trades)} entries); '
            f'falling back to all recent trades ({len(trades)} entries).'
        )
        return trades
    if not slopfest_trades and trades:
        print(f'[GEMMA4] No recent slopfest sample; falling back to all recent trades ({len(trades)} entries).')
        return trades
    return slopfest_trades

def load_missed(n=500):
    return load_recent_missed_targets(LOOKBACK_HOURS, limit=n, db_path=SIGNAL_DB_PATH)

def _read_jsonl_rows(file_path):
    rows = []
    if not os.path.exists(file_path):
        return rows
    try:
        with open(file_path, encoding='utf-8') as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    rows.append(json.loads(line))
                except Exception:
                    continue
    except Exception:
        return []
    return rows

def load_recent_trade_events(lookback_hours, db_path=None):
    cutoff_ms = int((time.time() - max(float(lookback_hours or 0), 0) * 3600) * 1000)
    rows = _read_jsonl_rows(JOURNAL)
    if not rows and os.path.exists(FALLBACK_JOURNAL) and FALLBACK_JOURNAL != JOURNAL:
        rows = _read_jsonl_rows(FALLBACK_JOURNAL)
    return [row for row in rows if in_lookback_window(row, cutoff_ms)]

def load_recent_missed_targets(lookback_hours, limit=500, db_path=None):
    cutoff_ms = int((time.time() - max(float(lookback_hours or 0), 0) * 3600) * 1000)
    rows = [row for row in _read_jsonl_rows(MISSED) if in_lookback_window(row, cutoff_ms)]
    return rows[-max(int(limit or 0), 0):] if limit else rows

def get_vps_ssh_config():
    host = str(os.environ.get('VPS_HOST', '')).strip()
    username = str(os.environ.get('VPS_USER', 'root')).strip() or 'root'
    password = str(os.environ.get('VPS_PW', '')).strip()
    if not host or not password:
        raise RuntimeError('VPS_HOST and VPS_PW must be set for remote sync/publish')
    return host, username, password

def has_vps_ssh_config():
    return bool(str(os.environ.get('VPS_HOST', '')).strip() and str(os.environ.get('VPS_PW', '')).strip())

def is_local_runtime_ready():
    return os.path.exists(JOURNAL) or os.path.exists(FALLBACK_JOURNAL)

def sync_history_store():
    import paramiko
    import os
    if not has_vps_ssh_config() and is_local_runtime_ready():
        print('[GEMMA4] Remote sync skipped; using local journal files')
        return
    try:
        host, username, password = get_vps_ssh_config()
        ssh = paramiko.SSHClient()
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh.connect(host, username=username, password=password, timeout=10)
        sftp = ssh.open_sftp()
        sftp.get('/var/www/pcprotocol/signals/trade_journal.jsonl', JOURNAL)
        sftp.close()
        ssh.close()
        print('[GEMMA4] Synced trade_journal.jsonl from VPS successfully')
    except Exception as e:
        print(f'[GEMMA4] Failed to sync from VPS: {e}')

def load_json(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default

def parse_buy_reason_metrics(reason):
    reason = str(reason or '')
    match = re.search(r'([+-]?\d+(?:\.\d+)?)%/1h\s+(\d+)B/(\d+)S', reason)
    if not match:
        return None
    price_chg_1h = try_float(match.group(1), 0) or 0
    buys = int(match.group(2))
    sells = int(match.group(3))
    buy_ratio = buys / max(sells, 1)
    return {
        'price_chg_1h': price_chg_1h,
        'buys': buys,
        'sells': sells,
        'buy_ratio': round(buy_ratio, 3),
    }

def avg(values, default=0):
    filtered = [v for v in values if v is not None]
    return (sum(filtered) / len(filtered)) if filtered else default

def analyze_signal_patterns(trades):
    paired = []
    for pair in analyze_trades(trades):
        price_chg_1h = try_float(pair.get('entry_price_chg_1h'), None)
        buy_ratio = try_float(pair.get('entry_buy_ratio'), None)
        momentum5m = try_float(pair.get('entry_momentum5m'), None)
        if price_chg_1h is None or buy_ratio is None or momentum5m is None:
            continue
        paired.append({
            'momentum5m': momentum5m,
            'price_chg_1h': price_chg_1h,
            'buys': int(pair.get('entry_buys', 0) or 0),
            'buy_ratio': buy_ratio,
            'hold_s': try_float(pair.get('hold_s'), 0) or 0,
            'pnl_sol': try_float(pair.get('pnl'), 0) or 0,
            'win': (try_float(pair.get('pnl'), 0) or 0) > 0,
            'signal_source': pair.get('signal_source'),
        })
    if len(paired) < 4:
        return {}

    winners = [p for p in paired if p['win']]
    losers = [p for p in paired if not p['win']]
    summary = {
        'sample_size': len(paired),
        'winner_count': len(winners),
        'loser_count': len(losers),
        'winners': {
            'avg_momentum5m': round(avg([p['momentum5m'] for p in winners]), 3),
            'avg_price_chg_1h': round(avg([p['price_chg_1h'] for p in winners]), 3),
            'avg_buys': round(avg([p['buys'] for p in winners]), 1),
            'avg_buy_ratio': round(avg([p['buy_ratio'] for p in winners]), 3),
            'avg_hold_s': round(avg([p['hold_s'] for p in winners]), 2),
        },
        'losers': {
            'avg_momentum5m': round(avg([p['momentum5m'] for p in losers]), 3),
            'avg_price_chg_1h': round(avg([p['price_chg_1h'] for p in losers]), 3),
            'avg_buys': round(avg([p['buys'] for p in losers]), 1),
            'avg_buy_ratio': round(avg([p['buy_ratio'] for p in losers]), 3),
            'avg_hold_s': round(avg([p['hold_s'] for p in losers]), 2),
        },
        'source_performance': summarize_source_performance(analyze_trades(trades)),
    }
    if winners:
        summary['preferred_profile'] = {
            'momentum5m_floor': round(max(0, avg([p['momentum5m'] for p in winners]) * 0.6), 3),
            'price_chg_1h_floor': round(avg([p['price_chg_1h'] for p in winners]) * 0.5, 3),
            'buy_ratio_floor': round(max(1.0, avg([p['buy_ratio'] for p in winners]) * 0.75), 3),
            'buys_floor': int(max(50, avg([p['buys'] for p in winners]) * 0.5)),
        }
    return summary

def load_live_signal_context(signal_profile=None):
    follow_data = load_json(FOLLOW_MONITOR, {})
    trending_rows = load_json(TRENDING_FILE, [])
    velocity_data = load_json(VELOCITY_FILE, {})

    live = {
        'follow_monitor': {
            'enabled': bool(follow_data.get('enabled')),
            'count': int(follow_data.get('count', 0) or 0),
            'top_tokens': [],
        },
        'trending': {
            'count': 0,
            'top_bridge_tokens': [],
        },
        'velocity': {
            'available': bool(velocity_data),
            'count': 0,
            'top_mints': [],
        },
        'profile_match_count': 0,
        'profile_matches': [],
    }

    for token in (follow_data.get('tokens') or [])[:5]:
        live['follow_monitor']['top_tokens'].append({
            'symbol': token.get('symbol'),
            'mint': token.get('mint'),
            'inflow_usd_5m': round(try_float(token.get('inflowUsd5m'), 0) or 0, 2),
            'wallets_5m': int(token.get('uniqueWallets5m', 0) or 0),
            'trades_5m': int(token.get('tradeCount5m', 0) or 0),
        })

    if isinstance(trending_rows, dict):
        trending_rows = trending_rows.get('pairs') or trending_rows.get('tokens') or []
    bridge_rows = []
    for row in (trending_rows or []):
        gmgn = row.get('_gmgn') or {}
        source = gmgn.get('source') or row.get('dexId')
        if source not in ('gmgn-bridge', 'gmgn-follow-monitor'):
            continue
        buys = ((row.get('txns') or {}).get('h1') or {}).get('buys') or row.get('buys') or 0
        sells = ((row.get('txns') or {}).get('h1') or {}).get('sells') or row.get('sells') or 0
        bridge_rows.append({
            'symbol': ((row.get('baseToken') or {}).get('symbol')) or row.get('symbol'),
            'mint': ((row.get('baseToken') or {}).get('address')) or row.get('mint'),
            'source': source,
            'momentum5m': try_float(((row.get('priceChange') or {}).get('m5')) or row.get('priceChange5m'), 0) or 0,
            'price_chg_1h': try_float(((row.get('priceChange') or {}).get('h1')) or row.get('priceChange1h'), 0) or 0,
            'volume_5m': round(try_float(((row.get('volume') or {}).get('m5')) or row.get('volume5m'), 0) or 0, 2),
            'volume_1h': round(try_float(((row.get('volume') or {}).get('h1')) or row.get('volume1h'), 0) or 0, 2),
            'liquidity_usd': round(try_float(((row.get('liquidity') or {}).get('usd')) or row.get('liquidity'), 0) or 0, 2),
            'buys': int(buys or 0),
            'buy_ratio': round((buys / max(sells, 1)) if buys else 0, 3),
        })
    bridge_rows = sorted(bridge_rows, key=lambda r: (r['volume_1h'], r['buys']), reverse=True)
    live['trending']['count'] = len(bridge_rows)
    live['trending']['top_bridge_tokens'] = bridge_rows[:5]

    velocity_mints = velocity_data.get('mints') if isinstance(velocity_data, dict) else {}
    if isinstance(velocity_mints, dict):
        hot = []
        for mint, data in velocity_mints.items():
            hot.append({
                'mint': mint,
                'symbol': data.get('symbol'),
                'buys60s': int(data.get('buys60s', 0) or 0),
                'buy_ratio60s': round(try_float(data.get('buyRatio60s'), 0) or 0, 3),
                'velocity': round(try_float(data.get('velocity'), 0) or 0, 2),
                'sol_volume60s': round(try_float(data.get('solVolume60s'), 0) or 0, 3),
                'is_accelerating': bool(data.get('isAccelerating')),
            })
        hot = sorted(hot, key=lambda r: (r['is_accelerating'], r['velocity'], r['buys60s'], r['sol_volume60s']), reverse=True)
        live['velocity']['count'] = len(hot)
        live['velocity']['top_mints'] = hot[:5]

    preferred = (signal_profile or {}).get('preferred_profile') or {}
    if preferred:
        matches = []
        for row in bridge_rows[:12]:
            if (
                row['buys'] >= preferred.get('buys_floor', 0) and
                row['buy_ratio'] >= preferred.get('buy_ratio_floor', 0) and
                row['momentum5m'] >= preferred.get('momentum5m_floor', 0) and
                row['price_chg_1h'] >= preferred.get('price_chg_1h_floor', -999)
            ):
                matches.append({
                    'symbol': row['symbol'],
                    'mint': row['mint'],
                    'source': row['source'],
                    'buys': row['buys'],
                    'buy_ratio': row['buy_ratio'],
                    'momentum5m': row['momentum5m'],
                    'price_chg_1h': row['price_chg_1h'],
                })
        live['profile_match_count'] = len(matches)
        live['profile_matches'] = matches[:5]

    return live

def load_wallet_context():
    wallet_data = load_json(WALLET_SIGNALS, {})
    wallet_pnl_data = load_json(WALLET_PNL_FILE, {})
    alpha_data = load_json(ALPHA_WALLETS, {})
    kol_data = load_json(KOL_WALLETS, {})
    realized_profit_data = load_json(REALIZED_PROFIT_FILE, {})
    wallet_pnl_rows = wallet_pnl_data.get('wallets', []) or []
    wallet_pnl_map = {row.get('walletAddr'): row for row in wallet_pnl_rows if row.get('walletAddr')}
    tracked_wallet_rows = (alpha_data.get('tracked_wallets', []) or []) + (kol_data.get('tracked_wallets', []) or [])
    tracked_wallet_map = {row.get('address'): row for row in tracked_wallet_rows if row.get('address')}
    buy_signals = wallet_data.get('buy_signals', []) or []
    sell_signals = wallet_data.get('sell_signals', []) or []
    for signal in buy_signals:
        wallets = signal.get('wallets', []) or []
        matched = []
        for wallet in wallets:
            if wallet in wallet_pnl_map:
                matched.append(wallet_pnl_map[wallet])
                continue
            meta = tracked_wallet_map.get(wallet)
            if meta:
                matched.append({
                    'walletAddr': wallet,
                    'winRate': try_float(meta.get('win_rate_gmgn'), 0) or 0,
                    'realizedProfitUsd': 0,
                    'lastTimestamp': 0,
                    'profitabilityScore': round(((try_float(meta.get('score'), 0.5) or 0.5) * 0.65) + ((try_float(meta.get('win_rate_gmgn'), 0.5) or 0.5) * 0.35), 3),
                })
        if matched and not try_float(signal.get('walletPnlScore'), 0):
            signal['walletPnlScore'] = round(sum(try_float(row.get('profitabilityScore'), 0) or 0 for row in matched) / len(matched), 4)
            signal['avgWalletWinRate'] = round(sum(try_float(row.get('winRate'), 0) or 0 for row in matched) / len(matched), 4)
            signal['avgWalletRealizedProfit'] = round(sum(try_float(row.get('realizedProfitUsd'), 0) or 0 for row in matched) / len(matched), 2)
            signal['topWalletRealizedProfit'] = round(max(try_float(row.get('realizedProfitUsd'), 0) or 0 for row in matched), 2)
            signal['topWalletLastActiveAt'] = max(int(try_float(row.get('lastTimestamp'), 0) or 0) for row in matched)
    active_buy_signals = [s for s in buy_signals if not s.get('expired')]
    executable_buy_signals = [s for s in active_buy_signals if s.get('executable')]
    info_only_buy_signals = [s for s in active_buy_signals if not s.get('executable')]
    kol_signals = [s for s in active_buy_signals if s.get('kolCount', 0) or 'KOL' in (s.get('walletStyles') or [])]
    tracked_wallets = tracked_wallet_rows

    priority_rank = {'VERY_HIGH': 4, 'SCALP': 3, 'HIGH': 2, 'INFO': 1}
    top_signal = None
    if executable_buy_signals:
        top_signal = sorted(
            executable_buy_signals,
            key=lambda s: (
                priority_rank.get(s.get('priority', 'INFO'), 0),
                1 if s.get('kolConfirmed') else 0,
                1 if s.get('sizeUp') else 0,
                float(s.get('consensusScore', 0) or 0),
            ),
            reverse=True,
        )[0]

    active_signal_wallets = []
    for signal in active_buy_signals:
        active_signal_wallets.extend(signal.get('wallets', []) or [])
    unique_active_wallets = sorted(set(active_signal_wallets))
    active_wallet_pnls = [wallet_pnl_map[w] for w in unique_active_wallets if w in wallet_pnl_map]

    executable_consensus = [float(s.get('consensusScore', 0) or 0) for s in executable_buy_signals]
    preferred_hold_minutes = None
    if top_signal and top_signal.get('preferredHoldMs'):
        preferred_hold_minutes = round(float(top_signal.get('preferredHoldMs')) / 60000, 2)

    position_boost = 1.0
    if top_signal:
        if top_signal.get('priority') == 'VERY_HIGH' or top_signal.get('sizeUp'):
            position_boost = 1.25
        elif top_signal.get('priority') == 'SCALP':
            position_boost = 1.10
        elif top_signal.get('priority') == 'HIGH':
            position_boost = 1.05
        if top_signal.get('kolConfirmed'):
            position_boost = min(1.35, position_boost + 0.05)
        wallet_pnl_score = try_float(top_signal.get('walletPnlScore'), 0) or 0
        avg_wallet_win_rate = try_float(top_signal.get('avgWalletWinRate'), 0) or 0
        if wallet_pnl_score >= 0.75:
            position_boost = min(1.45, position_boost + 0.08)
        elif wallet_pnl_score >= 0.6:
            position_boost = min(1.4, position_boost + 0.04)
        if avg_wallet_win_rate >= 0.6:
            position_boost = min(1.45, position_boost + 0.03)

    avg_active_wallet_profitability = round(sum(try_float(w.get('profitabilityScore'), 0) or 0 for w in active_wallet_pnls) / len(active_wallet_pnls), 4) if active_wallet_pnls else 0
    avg_active_wallet_win_rate = round(sum(try_float(w.get('winRate'), 0) or 0 for w in active_wallet_pnls) / len(active_wallet_pnls), 4) if active_wallet_pnls else 0
    avg_active_wallet_realized_profit = round(sum(try_float(w.get('realizedProfitUsd'), 0) or 0 for w in active_wallet_pnls) / len(active_wallet_pnls), 2) if active_wallet_pnls else 0
    top_wallet_pnl = None
    if wallet_pnl_rows:
        top_wallet_pnl = sorted(
            wallet_pnl_rows,
            key=lambda row: (
                try_float(row.get('profitabilityScore'), 0) or 0,
                try_float(row.get('realizedProfitUsd'), 0) or 0,
                try_float(row.get('winRate'), 0) or 0,
            ),
            reverse=True,
        )[0]

    return {
        'tracked_wallet_count': len(tracked_wallets),
        'active_buy_count': len(active_buy_signals),
        'executable_buy_count': len(executable_buy_signals),
        'info_only_buy_count': len(info_only_buy_signals),
        'kol_signal_count': len(kol_signals),
        'kol_confirmed_buy_count': len([s for s in executable_buy_signals if s.get('kolConfirmed')]),
        'active_sell_count': len([s for s in sell_signals if not s.get('expired')]),
        'top_signal': top_signal,
        'avg_executable_consensus': round(sum(executable_consensus) / len(executable_consensus), 4) if executable_consensus else 0,
        'preferred_hold_minutes': preferred_hold_minutes,
        'position_boost': position_boost,
        'avg_active_wallet_profitability': avg_active_wallet_profitability,
        'avg_active_wallet_win_rate': avg_active_wallet_win_rate,
        'avg_active_wallet_realized_profit_usd': avg_active_wallet_realized_profit,
        'active_wallet_pnl_count': len(active_wallet_pnls),
        'top_wallet_pnl': top_wallet_pnl,
        'hot_sector': wallet_data.get('hot_sector'),
        'signal_updated_at': wallet_data.get('updated_at'),
        'wallet_pnl_updated_at': wallet_pnl_data.get('updated_at'),
        'realized_profit_summary': {
            'total_realized_pnl_sol': round(try_float(realized_profit_data.get('totalRealizedPnlSol'), 0) or 0, 6),
            'total_profit_seeking_score': round(try_float(realized_profit_data.get('totalProfitSeekingScore'), 0) or 0, 6),
            'profit_seeking_ratio': round(try_float(realized_profit_data.get('profitSeekingRatio'), 0) or 0, 6),
            'reward_asymmetry_factor': round(try_float(realized_profit_data.get('rewardAsymmetryFactor'), 0) or 0, 6),
            'closed_sell_count': int(try_float(realized_profit_data.get('closedSellCount'), 0) or 0),
        },
    }

def analyze_trades(trades):
    buys, sells = collapse_trade_lifecycles(trades)
    buy_by_trade_id = {b.get('tradeId'): b for b in buys if b.get('tradeId')}

    pairs = []
    for sell in sells:
        buy = buy_by_trade_id.get(sell.get('parentBuyId'))
        if buy is None:
            buy = next((b for b in buys if b.get('mint') == sell.get('mint')), None)
        if buy:
            buy_in = buy.get('amountSol', 0) or 0
            pnl = try_float(sell.get('lifecyclePnlSol'), None)
            if pnl is None:
                pnl = try_float(sell.get('pnlSol'), None)
            if pnl is None:
                sell_out = sell.get('amountSol', 0) or 0
                pnl = sell_out - buy_in
            parsed_entry = parse_entry_reason_snapshot(buy.get('reason'))
            signal_source = infer_signal_source(buy, sell)
            pairs.append({
                'pnl': pnl,
                'pnl_pct': ((pnl / buy_in) * 100) if buy_in else 0,
                'exit': sell.get('reason', ''),
                'hold_s': sell.get('holdMs', 0) / 1000,
                'success': True if 'sig' in sell else False,
                'signal_source': signal_source,
                'entry_momentum5m': try_float(buy.get('momentum5m'), 0) or 0,
                'entry_volume5m': try_float(buy.get('volume5m'), 0) or 0,
                'entry_price_chg_1h': try_float(parsed_entry.get('price_chg_1h'), 0) or 0,
                'entry_buys': int(parsed_entry.get('buys', 0) or 0),
                'entry_buy_ratio': try_float(parsed_entry.get('buy_ratio'), 0) or 0,
                'peak_pnl_pct': try_float(sell.get('rsi'), 0) or 0,
                'slopfest_id': buy.get('slopfestParamsSetId') or sell.get('slopfestParamsSetId'),
                'slopfest_raw': buy.get('slopfestParamsRaw') or sell.get('slopfestParamsRaw'),
                'mint': buy.get('mint') or sell.get('mint'),
                'symbol': buy.get('symbol') or sell.get('symbol'),
                'event_count': 1,
            })
    return pairs

def analyze_entry_quality(trades):
    """Analyze WHERE in the pump we're entering based on momentum5m at buy time."""
    pairs = analyze_trades(trades)
    entry_data = []
    for pair in pairs:
        mom5m = try_float(pair.get('entry_momentum5m'), None)
        if mom5m is not None:
            entry_data.append({
                'mom5m': mom5m,
                'pnl_pct': try_float(pair.get('pnl_pct'), 0) or 0,
                'win': (try_float(pair.get('pnl'), 0) or 0) > 0,
                'sell_ok': bool(pair.get('success', False)),
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

def generate_recommendations(pairs, missed, wallet_ctx=None, signal_profile=None, live_signal_context=None):
    wins = [p for p in pairs if p['pnl'] > 0]
    losses = [p for p in pairs if p['pnl'] <= 0]
    failed = [p for p in pairs if not p.get('success')]

    total = max(len(pairs), 1)
    win_rate = len(wins) / total * 100
    failed_ratio = len(failed) / total
    avg_loss = sum(p['pnl_pct'] for p in losses) / max(len(losses), 1) if losses else 0
    avg_win = sum(p['pnl_pct'] for p in wins) / max(len(wins), 1) if wins else 0
    profit_objective = summarize_profit_seeking_pairs(pairs)

    # Count missed target reasons
    miss_reasons = {}
    for m in missed:
        r = m.get('reason', 'unknown')
        miss_reasons[r] = miss_reasons.get(r, 0) + 1

    # Current defaults
    recs = {
        'min_5m_change': 3,
        'min_liquidity_usd': 20000,
        'min_volume_5m': 0,
        'max_top10_holder_pct': 40,
        'tp1_pct': 20,
        'stop_loss_pct': 15,
        'max_hold_minutes': 5,
    }

    analysis = f"Win rate: {win_rate:.0f}% ({len(wins)}/{total}). "
    analysis += f"Avg win: {avg_win:+.1f}%, avg loss: {avg_loss:+.1f}%. "
    analysis += (
        f"Failed sells: {failed_ratio*100:.0f}%. "
        f"Profit-seeking score: {profit_objective['total_score']:+.2f}, PSR: {profit_objective['psr']:.2f}."
    )

    insight = ""
    confidence = 50
    wallet_ctx = wallet_ctx or {}
    signal_profile = signal_profile or {}
    live_signal_context = live_signal_context or {}
    source_performance = summarize_source_performance(pairs)
    source_policy = build_source_policy(source_performance)
    bayesian_data = load_json(BAYESIAN_FILE, {})
    recs['hunterModeMultiplier'] = bayesian_data.get('params', {}).get('hunter_mode_multiplier', 0.5)
    realized_summary = wallet_ctx.get('realized_profit_summary', {}) or {}
    realized_psr = try_float(realized_summary.get('profit_seeking_ratio'), 0) or 0
    realized_score = try_float(realized_summary.get('total_profit_seeking_score'), 0) or 0

    # Decision logic based on data patterns
    if total < 10:
        insight = f"Grace period active ({total}/10 trades). Insufficient data for refinement."
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

    if total >= 10 and (profit_objective['psr'] < 1 or profit_objective['total_score'] < 0):
        recs['min_5m_change'] = clamp(recs['min_5m_change'] + 0.5, *BOUNDS['min_5m_change'])
        recs['min_liquidity_usd'] = clamp(recs['min_liquidity_usd'] + 2500, *BOUNDS['min_liquidity_usd'])
        recs['max_hold_minutes'] = clamp(min(recs['max_hold_minutes'], 4), *BOUNDS['max_hold_minutes'])
        recs['hunterModeMultiplier'] = min(recs.get('hunterModeMultiplier', 0.5), 0.35)
        confidence = max(35, confidence - 6)
        insight += (
            f" PROFIT OBJECTIVE: recent score {profit_objective['total_score']:+.2f} and PSR {profit_objective['psr']:.2f} are loss-skewed, "
            "so Gemma is tightening entries and shortening exposure."
        )
    elif total >= 10 and profit_objective['psr'] >= 1.25 and profit_objective['total_score'] > 0:
        confidence = min(confidence + 4, 95)
        insight += (
            f" PROFIT OBJECTIVE: recent score {profit_objective['total_score']:+.2f} and PSR {profit_objective['psr']:.2f} favor asymmetric upside."
        )

    if realized_psr >= 1.15 and realized_score > 0:
        confidence = min(confidence + 3, 95)
        insight += (
            f" REALIZED OBJECTIVE: cumulative score {realized_score:+.2f} and PSR {realized_psr:.2f} confirm the broader book is still profit-seeking."
        )
    elif realized_score < 0 and realized_psr > 0:
        recs['hunterModeMultiplier'] = min(recs.get('hunterModeMultiplier', 0.5), 0.3)
        confidence = max(30, confidence - 4)
        insight += (
            f" REALIZED OBJECTIVE: cumulative score {realized_score:+.2f} with PSR {realized_psr:.2f} argues for more conservative hunter deployment."
        )

    weak_bridge = source_performance.get('bridge', {})
    strong_hybrid = source_performance.get('hybrid', {})
    strong_follow = source_performance.get('follow-monitor', {})
    weak_market = source_performance.get('market', {})
    if weak_bridge.get('count', 0) >= 5 and (weak_bridge.get('win_rate', 0) < 22 or weak_bridge.get('total_pnl_sol', 0) < 0):
        recs['min_liquidity_usd'] = clamp(recs['min_liquidity_usd'] + 3000, *BOUNDS['min_liquidity_usd'])
        recs['min_volume_5m'] = clamp(recs['min_volume_5m'] + 150, *BOUNDS['min_volume_5m'])
        insight += " SOURCE LEARNING: Bridge-only flow is underperforming, so liquidity and 5m volume floors were raised."
    if weak_market.get('count', 0) >= 5 and weak_market.get('total_pnl_sol', 0) < 0:
        recs['min_5m_change'] = clamp(recs['min_5m_change'] + 0.5, *BOUNDS['min_5m_change'])
        insight += " Market-only flow remains weak, so pure momentum entries now need stronger recent move confirmation."
    if strong_follow.get('count', 0) >= 3 and strong_follow.get('win_rate', 0) >= 40 and strong_follow.get('total_pnl_sol', 0) >= 0:
        recs['min_liquidity_usd'] = clamp(min(recs['min_liquidity_usd'], 12000), *BOUNDS['min_liquidity_usd'])
        recs['min_volume_5m'] = clamp(min(recs['min_volume_5m'], 500), *BOUNDS['min_volume_5m'])
        confidence = min(confidence + 3, 95)
        insight += " Follow-monitor flow is outperforming baseline, so Gemma is allowing earlier confirmations there."
    if strong_hybrid.get('count', 0) >= 3 and strong_hybrid.get('win_rate', 0) >= 45 and strong_hybrid.get('total_pnl_sol', 0) >= 0:
        recs['min_5m_change'] = clamp(min(recs['min_5m_change'], 2), *BOUNDS['min_5m_change'])
        recs['max_hold_minutes'] = clamp(min(recs['max_hold_minutes'], 4), *BOUNDS['max_hold_minutes'])
        confidence = min(confidence + 4, 95)
        insight += " Multi-source agreement is the healthiest lane, so Gemma is favoring earlier but shorter hybrid entries."

    # ── PROFITABLE PROFILE TP/SL ADAPTATION ──────────────────────────────
    # Analyze winning trades to determine optimal TP/SL from actual outcomes
    if wins:
        avg_win_pnl_pct = sum(p.get('pnl_pct', 0) for p in wins) / len(wins)
        max_win_pnl_pct = max(p.get('pnl_pct', 0) for p in wins)
        avg_win_hold = sum(p.get('hold_s', 0) for p in wins) / len(wins)
        # If best winners consistently hit >10%, raise TP to let them run
        if max_win_pnl_pct > 12 and avg_win_pnl_pct > 6:
            recs['tp1_pct'] = clamp(round(max_win_pnl_pct * 1.2), *BOUNDS['tp1_pct'])
            insight += f" PROFIT PROFILE: Winners avg +{avg_win_pnl_pct:.1f}% (best +{max_win_pnl_pct:.1f}%) — raised TP to {recs['tp1_pct']}%."
        elif avg_win_pnl_pct > 3:
            recs['tp1_pct'] = clamp(round(avg_win_pnl_pct * 1.5), *BOUNDS['tp1_pct'])
            insight += f" PROFIT PROFILE: Winners avg +{avg_win_pnl_pct:.1f}% — set TP to {recs['tp1_pct']}%."
        # If winners need more time, widen hold
        if avg_win_hold > 180:
            recs['max_hold_minutes'] = clamp(round(avg_win_hold / 60 * 1.2), *BOUNDS['max_hold_minutes'])
            insight += f" Winners avg hold {avg_win_hold:.0f}s — widened max hold to {recs['max_hold_minutes']}min."

    # Wallet SCALP alpha with high PnL → widen SL to absorb entry slippage
    if wallet_ctx.get('executable_buy_count', 0) > 0 and (float(wallet_ctx.get('avg_active_wallet_profitability', 0) or 0)) >= 0.3:
        recs['stop_loss_pct'] = clamp(max(recs['stop_loss_pct'], 12), *BOUNDS['stop_loss_pct'])
        insight += f" WALLET ALPHA: High-profit wallets active — widened SL to absorb slippage."

    # If avg loss is huge (>30%), tighten SL
    # if avg_loss < -30:
    #     recs['stop_loss_pct'] = clamp(recs['stop_loss_pct'] - 2, *BOUNDS['stop_loss_pct'])
    #     insight += " Large avg losses detected — tightening stop loss."

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

    executable_buy_count = wallet_ctx.get('executable_buy_count', 0)
    kol_signal_count = wallet_ctx.get('kol_signal_count', 0)
    info_only_buy_count = wallet_ctx.get('info_only_buy_count', 0)
    active_wallet_pnl_count = wallet_ctx.get('active_wallet_pnl_count', 0)
    avg_active_wallet_profitability = try_float(wallet_ctx.get('avg_active_wallet_profitability'), 0) or 0
    avg_active_wallet_win_rate = try_float(wallet_ctx.get('avg_active_wallet_win_rate'), 0) or 0
    top_signal = wallet_ctx.get('top_signal') or {}
    if executable_buy_count > 0 and top_signal:
        signal_priority = top_signal.get('priority', 'INFO')
        consensus = float(top_signal.get('consensusScore', 0) or 0)
        wallet_pnl_score = try_float(top_signal.get('walletPnlScore'), 0) or 0
        wallet_win_rate = try_float(top_signal.get('avgWalletWinRate'), 0) or 0
        hold_minutes = wallet_ctx.get('preferred_hold_minutes')
        kol_confirmed = bool(top_signal.get('kolConfirmed'))
        alpha_liquidity_floor = 12000 if signal_priority == 'VERY_HIGH' else 9000 if signal_priority == 'SCALP' else 15000
        if kol_confirmed:
            alpha_liquidity_floor = min(alpha_liquidity_floor, 8000 if signal_priority in ('SCALP', 'VERY_HIGH') else 12000)
        recs['min_liquidity_usd'] = clamp(min(recs['min_liquidity_usd'], alpha_liquidity_floor), *BOUNDS['min_liquidity_usd'])
        if hold_minutes:
            recs['max_hold_minutes'] = clamp(round(min(recs['max_hold_minutes'], hold_minutes)), *BOUNDS['max_hold_minutes'])
        if signal_priority in ('SCALP', 'VERY_HIGH'):
            recs['min_5m_change'] = clamp(min(recs['min_5m_change'], 2 if signal_priority == 'SCALP' else 1), *BOUNDS['min_5m_change'])
            recs['min_volume_5m'] = clamp(min(recs['min_volume_5m'], 750), *BOUNDS['min_volume_5m'])
        if kol_confirmed:
            recs['overbought_ceiling'] = clamp(max(recs.get('overbought_ceiling', 10), 15), 10, 50)
        if wallet_pnl_score >= 0.3:
            recs['min_liquidity_usd'] = clamp(min(recs['min_liquidity_usd'], 8000), *BOUNDS['min_liquidity_usd'])
            recs['min_volume_5m'] = clamp(min(recs['min_volume_5m'], 600), *BOUNDS['min_volume_5m'])
            confidence = min(confidence + 4, 95)
        if wallet_win_rate >= 0.4:
            confidence = min(confidence + 3, 95)
        confidence = min(confidence + 10, 95)
        insight += f" WALLET INTEL: {executable_buy_count} executable alpha signal(s), top={signal_priority}, consensus={consensus:.2f}, pnlScore={wallet_pnl_score:.2f}."
        if kol_confirmed:
            confidence = min(confidence + 5, 95)
            insight += f" KOL FLOW: {kol_signal_count} KOL-linked signal(s) confirm inflow momentum."
    elif info_only_buy_count > 0:
        insight += f" WALLET INTEL: {info_only_buy_count} info-only alpha signal(s) observed."
        if kol_signal_count > 0:
            recs['min_liquidity_usd'] = clamp(min(recs['min_liquidity_usd'], 12000), *BOUNDS['min_liquidity_usd'])
            recs['min_5m_change'] = clamp(min(recs['min_5m_change'], 2), *BOUNDS['min_5m_change'])
            recs['min_volume_5m'] = clamp(min(recs['min_volume_5m'], 750), *BOUNDS['min_volume_5m'])
            recs['overbought_ceiling'] = clamp(max(recs.get('overbought_ceiling', 10), 12), 10, 50)
            insight += f" KOL FLOW: {kol_signal_count} KOL-linked watch signal(s) detected."
    elif active_wallet_pnl_count > 0 and avg_active_wallet_profitability >= 0.65 and avg_active_wallet_win_rate >= 0.55:
        recs['min_liquidity_usd'] = clamp(min(recs['min_liquidity_usd'], 10000), *BOUNDS['min_liquidity_usd'])
        recs['min_volume_5m'] = clamp(min(recs['min_volume_5m'], 700), *BOUNDS['min_volume_5m'])
        confidence = min(confidence + 4, 95)
        insight += f" WALLET PNL: active tracked wallets remain profitable (score={avg_active_wallet_profitability:.2f}, win={avg_active_wallet_win_rate:.2f})."

    if executable_buy_count == 0 and info_only_buy_count == 0 and win_rate >= 35 and sum(p['pnl'] for p in pairs) >= 0:
        recs['min_liquidity_usd'] = clamp(min(recs['min_liquidity_usd'], 12000), *BOUNDS['min_liquidity_usd'])
        recs['min_volume_5m'] = clamp(min(recs['min_volume_5m'], 500), *BOUNDS['min_volume_5m'])
        recs['overbought_ceiling'] = clamp(max(recs.get('overbought_ceiling', 10), 20), 10, 50)
        recs['hunterModeMultiplier'] = min(recs.get('hunterModeMultiplier', 0.5), 0.2)
        insight += " TRADE DROUGHT: no active wallet flow, so relaxing 5m volume, liquidity, overbought ceiling, and enforcing 0.2 Hunter Multiplier to restore live throughput."

    preferred_profile = signal_profile.get('preferred_profile') or {}
    if preferred_profile:
        insight += (
            f" WINNING SIGNAL PROFILE: recent winners cluster around "
            f"{preferred_profile.get('momentum5m_floor', 0):.1f}%+ 5m momentum, "
            f"{preferred_profile.get('buy_ratio_floor', 1.0):.2f}+ buy ratio, "
            f"and {preferred_profile.get('buys_floor', 0)}+ recent buys."
        )

    live_match_count = int(live_signal_context.get('profile_match_count', 0) or 0)
    if live_match_count > 0:
        recs['min_liquidity_usd'] = clamp(min(recs['min_liquidity_usd'], 10000), *BOUNDS['min_liquidity_usd'])
        recs['min_volume_5m'] = clamp(min(recs['min_volume_5m'], 350), *BOUNDS['min_volume_5m'])
        recs['overbought_ceiling'] = clamp(max(recs.get('overbought_ceiling', 20), 18), 10, 50)
        confidence = min(confidence + 5, 95)
        insight += f" LIVE MATCH: {live_match_count} current inflow candidate(s) resemble recent winning entries."

    return {
        'analysis': analysis,
        'key_insight': insight,
        'confidence': confidence,
        'recommended_filters': recs,
        'wallet_context': wallet_ctx,
        'signal_profile': {**signal_profile, 'source_performance': source_performance},
        'source_performance': source_performance,
        'source_policy': source_policy,
        'live_signal_context': live_signal_context,
        'trade_count': total,
        'win_rate': win_rate,
        'total_pnl_sol': sum(p['pnl'] for p in pairs),
        'profit_objective': profit_objective,
        'generated_at': datetime.now(timezone.utc).isoformat(),
    }


def update_env(filters):
    """Persist Gemma4 recommendations to .env so they survive restart."""
    env_path = os.path.join(PROJECT_ROOT, '.env')
    try:
        with open(env_path, encoding='utf-8') as f:
            env = f.read()

        mappings = {
            'MAX_TP_PERCENT': str(filters.get('tp1_pct', 20)),
            'STOP_LOSS_PERCENT': str(filters.get('stop_loss_pct', 15)),
            'MAX_HOLD_MINUTES': str(filters.get('max_hold_minutes', 5)),
            'SNIPER_MIN_VOL_5M': str(filters.get('min_volume_5m', 1000)),
        }

        for key, val in mappings.items():
            import re
            pattern = f'^{key}=.*$'
            replacement = f'{key}={val}'
            env = re.sub(pattern, replacement, env, flags=re.MULTILINE)

        with open(env_path, 'w', encoding='utf-8') as f:
            f.write(env)
        print(f'[G4] JSON_CONFIG_UPDATE written to .env.live.tmp -> atomic rename successful. {mappings}')
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
        'maxTPpct': filters.get('tp1_pct', 20) / 100,
        'stopLossPct': filters.get('stop_loss_pct', 15) / 100,
        'maxHoldMinutes': filters.get('max_hold_minutes', 5),
        'dynamicMinMom1m': filters.get('min_5m_change', 3),
        'overboughtCeiling': filters.get('overbought_ceiling', 30),
        'minLiquidityUsd': filters.get('min_liquidity_usd', 5000),
        'minVolume5m': filters.get('min_volume_5m', 1000),
        'maxTop10HolderPct': filters.get('max_top10_holder_pct', 40),
        'hunterModeMultiplier': filters.get('hunterModeMultiplier', 0.5),
    }
    wallet_ctx = recs.get('wallet_context', {}) or {}
    top_signal = wallet_ctx.get('top_signal') or {}
    params.update({
        'alphaSignalActive': bool(wallet_ctx.get('executable_buy_count', 0)),
        'alphaSignalCount': wallet_ctx.get('executable_buy_count', 0),
        'alphaPriority': top_signal.get('priority', 'INFO'),
        'alphaConsensus': wallet_ctx.get('avg_executable_consensus', 0),
        'alphaPreferredHoldMinutes': wallet_ctx.get('preferred_hold_minutes'),
        'alphaPositionBoost': wallet_ctx.get('position_boost', 1.0),
        'alphaKolCount': wallet_ctx.get('kol_signal_count', 0),
        'alphaKolConfirmed': bool(top_signal.get('kolConfirmed')),
        'sourcePolicy': recs.get('source_policy', {}),
    })

    payload = json.dumps(params)

    # ── FIX: Update .env file FIRST before trying redis (incase redis relies on droplet) ──
    try:
        update_env(filters)
    except Exception as e:
        print(f'  [Failed to update .env]: {e}')

    try:
        import redis
        host = os.environ.get('REDIS_HOST', '127.0.0.1')
        port = int(os.environ.get('REDIS_PORT', 6379))
        client = redis.Redis(host=host, port=port, db=0, decode_responses=True)
        subscribers = client.publish('config:slopfest', payload)
        print(f'  Redis PUBLISH config:slopfest -> {subscribers} subscriber(s)')

        # --- PUSH TO VPS REDIS VIA SSH ---
        try:
            import paramiko
            if not has_vps_ssh_config():
                print('  [VPS] Redis publish skipped; using local runtime only')
                print(f'  Params: {json.dumps(params, indent=4)}')
                return True
            host, username, password = get_vps_ssh_config()
            ssh = paramiko.SSHClient()
            ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
            ssh.connect(host, username=username, password=password, timeout=10)
            payload_escaped = payload.replace("'", "'\\''")
            cmd = f"redis-cli publish config:slopfest '{payload_escaped}'"
            stdin, stdout, stderr = ssh.exec_command(cmd)
            vps_subs = stdout.read().decode('utf-8').strip()
            print(f'  [VPS] Redis PUBLISH config:slopfest -> {vps_subs} subscriber(s)')
            ssh.close()
        except Exception as ve:
            print(f'  [VPS] Redis publish error: {ve}')
        print(f'  Params: {json.dumps(params, indent=4)}')
        return True
    except Exception as e:
        print(f'  Redis publish error: {e}. Applied strictly to .env (Restart sniper for instant reflection)')
        return True # still true because .env got updated

def run_cycle():
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    print(f'\n{"="*60}')
    print(f'[GEMMA4] Refinement cycle at {now}')
    print(f'{"="*60}')
    sync_history_store()
    history_stats = {}
    print(
        '  History DB: '
        f'{history_stats.get("db_path")} | '
        f'{history_stats.get("file_size_mb")} MB / {history_stats.get("limit_gb")} GB | '
        f'events+{history_stats.get("trade_inserted", 0)} missed+{history_stats.get("missed_inserted", 0)}'
    )

    trades = load_trades()
    missed = load_missed()
    wallet_ctx = load_wallet_context()
    signal_profile = analyze_signal_patterns(trades)
    live_signal_context = load_live_signal_context(signal_profile)
    print(f'  Journal: {len(trades)} entries')
    print(f'  Missed targets: {len(missed)} entries')
    print(f'  Wallet signals: {wallet_ctx.get("active_buy_count", 0)} active buys / {wallet_ctx.get("executable_buy_count", 0)} executable')
    print(
        '  Live signals: '
        f'follow={live_signal_context.get("follow_monitor", {}).get("count", 0)} | '
        f'bridge={live_signal_context.get("trending", {}).get("count", 0)} | '
        f'velocity={live_signal_context.get("velocity", {}).get("count", 0)} | '
        f'profile-matches={live_signal_context.get("profile_match_count", 0)}'
    )

    if len(trades) == 0:
        print('  No trade data yet. Skipping analysis.')
        return

    pairs = analyze_trades(trades)
    print(f'  Paired trades: {len(pairs)}')
    entry_analysis = analyze_entry_quality(trades)

    recs = generate_recommendations(pairs, missed, wallet_ctx, signal_profile, live_signal_context)
    recs['paper_mode'] = PAPER_MODE
    recs['history_db'] = None # get_history_stats(SIGNAL_DB_PATH)

    backtest_payload = persist_swarm_backtest_results(pairs, recs)
    memory_result = run_swarm_memory_cycle()
    if backtest_payload.get('results'):
        best_backtest = backtest_payload['results'][0]
        print(
            '[GEMMA4] Backtest replay: '
            f'scope={backtest_payload.get("replay_scope")} '
            f'pairs={backtest_payload.get("replay_pair_count", backtest_payload.get("pair_count", 0))} | '
            f'{len(backtest_payload.get("results", []))} candidate(s) | '
            f'best={best_backtest.get("param_hash")} '
            f'fitness={best_backtest.get("fitness", 0):.4f} '
            f'pnl={best_backtest.get("total_pnl_sol", 0):+.4f} SOL'
        )
    else:
        print(
            '[GEMMA4] Backtest replay: '
            f'no eligible {backtest_payload.get("replay_scope", "replay")} candidates this cycle '
            f'from {backtest_payload.get("replay_pair_count", backtest_payload.get("pair_count", 0))} replay pair(s)'
        )
    if memory_result:
        print(
            '[GEMMA4] Swarm memory: '
            f'promoted={memory_result.get("promoted", False)} '
            f'best_fitness={memory_result.get("best_fitness", 0):.4f}'
        )

    recs = apply_live_inference(recs, pairs, missed, wallet_ctx, entry_analysis, signal_profile, live_signal_context)

    # Save recommendations
    with open(RECS, 'w', encoding='utf-8') as f:
        json.dump(recs, f, indent=2)
    if 'store_gemma_cycle' in globals():
        try:
            store_gemma_cycle(recs, len(trades), len(pairs), len(missed), db_path=SIGNAL_DB_PATH)
        except Exception as exc:
            print(f'[GEMMA4] store_gemma_cycle skipped: {exc}')
    else:
        print('[GEMMA4] store_gemma_cycle unavailable; skipping cycle persistence')

    print(f'[G4] --- Analysis Cycle {now} ---')
    print(f'[G4] Executing CoT: {recs["analysis"]}')
    print(f'[G4] Key Insight: {recs["key_insight"]}')
    print(f'[G4] Proposed Config Diff: {json.dumps(recs["recommended_filters"])}')

    inference = recs.get('inference') or {}
    print(f'[G4] Inference Engine: {inference.get("status", "n/a")} | model={inference.get("model", OLLAMA_MODEL)}')
    if recs.get('wallet_context'):
        wc = recs['wallet_context']
        top_signal = wc.get('top_signal') or {}
        if top_signal:
            print(f'  Wallet bias: {wc.get("executable_buy_count", 0)} executable | top={top_signal.get("priority")} | hold≈{wc.get("preferred_hold_minutes")}m | boost={wc.get("position_boost", 1.0)}x')
    live_ctx = recs.get('live_signal_context') or {}
    if live_ctx:
        print(
            '  Live context: '
            f'matches={live_ctx.get("profile_match_count", 0)} | '
            f'follow={live_ctx.get("follow_monitor", {}).get("count", 0)} | '
            f'bridge={live_ctx.get("trending", {}).get("count", 0)} | '
            f'velocity={live_ctx.get("velocity", {}).get("count", 0)}'
        )
    if 'overbought_ceiling' in recs.get('recommended_filters', {}):
        print(f'  Entry window: +{recs["recommended_filters"].get("min_5m_change",1)}% to +{recs["recommended_filters"].get("overbought_ceiling",30)}% (5m)')

    # Auto-apply if confident
    print(f'\n  Applying recommendations...')
    applied = apply_recommendations(recs)
    if applied:
        print(f'  Parameters pushed to live sniper')
    else:
        print(f'  Not applied (low confidence or error)')

    print(f'  Saved to {RECS}')



# ── LOSS-STREAK TRIGGERED REFINEMENT ──────────────────────────────────────────
import threading, subprocess as _sp, shutil

def redis_listener():
    """Listen for gemma4:refine events from the sniper."""
    import time as _time
    import redis
    while True:
        try:
            host = os.environ.get('REDIS_HOST', '127.0.0.1')
            port = int(os.environ.get('REDIS_PORT', 6379))
            client = redis.Redis(host=host, port=port, db=0, decode_responses=True)
            pubsub = client.pubsub()
            pubsub.subscribe('gemma4:refine')
            for message in pubsub.listen():
                if message['type'] == 'message':
                    line = message['data']
                    if isinstance(line, str) and line.startswith('{'):
                        print(f'\n[GEMMA4] LOSS STREAK TRIGGER received: {line[:80]}')
                        print('[GEMMA4] Running emergency refinement cycle...')
                        run_cycle()
        except Exception as e:
            print(f'[GEMMA4] Redis listener error: {e}')
            _time.sleep(5)

# Start listener thread
listener_thread = threading.Thread(target=redis_listener, daemon=True)
listener_thread.start()
print('[GEMMA4] Loss-streak listener initialized')

# ─── Main loop ────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    os.makedirs(SIGNALS_DIR, exist_ok=True)
    print('[GEMMA4] Auto-Refiner started')
    print(f'[GEMMA4] Mode: {"PAPER" if PAPER_MODE else "LIVE"}')
    print(f'[GEMMA4] Journal: {JOURNAL}')
    print(f'[GEMMA4] Project root: {PROJECT_ROOT}')
    print(f'[GEMMA4] Data root: {DATA_ROOT}')
    print(f'[GEMMA4] Signal DB: {SIGNAL_DB_PATH}')
    print(f'[GEMMA4] Interval: {INTERVAL_SECONDS}s ({INTERVAL_SECONDS/60:.0f}min)')
    print(f'[GEMMA4] Safety bounds: {json.dumps(BOUNDS, indent=2)}')

    # Run immediately on start
    run_cycle()

    if '--run-once' in sys.argv:
        sys.exit(0)

    # Then loop
    while True:
        print(f'\n[GEMMA4] Next cycle in {INTERVAL_SECONDS/60:.0f} minutes...')
        time.sleep(INTERVAL_SECONDS)
        run_cycle()
