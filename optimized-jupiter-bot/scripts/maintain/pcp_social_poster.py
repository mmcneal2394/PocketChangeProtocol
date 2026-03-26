#!/usr/bin/env python3
"""
pcp_social_poster.py — Autonomous X/Twitter Social Media Daemon
================================================================
Reads live trade stats from the PCP engine and posts on schedule:
  • Every 6 hours  — routine recap post
  • Profit milestone — every 0.1 SOL cumulative profit crossed
  • On start       — engine live announcement

Configure via .env (same file as bot):
  TWITTER_API_KEY, TWITTER_API_SECRET,
  TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_TOKEN_SECRET
"""
from __future__ import annotations
import json, os, time, random, logging
from pathlib import Path
from datetime import datetime, timezone
from dotenv import load_dotenv
import tweepy

# ── Paths ──────────────────────────────────────────────────────────────────────
BOT_ROOT  = Path(__file__).parents[2]          # optimized-jupiter-bot/
load_dotenv(BOT_ROOT / '.env')

JOURNAL   = BOT_ROOT / 'signals' / 'trade_journal.jsonl'
ALLOC     = BOT_ROOT / 'signals' / 'allocation.json'
STATE_F   = BOT_ROOT / 'signals' / 'social_state.json'

CA        = os.getenv('PCP_CA', '4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS')
SOL_PRICE = 140.0   # rough fallback; updated from env if available

TAGS      = '#Solana #DeFi #NFA'
INTERVAL  = 6 * 3600   # 6h between routine posts
MILESTONE = 0.10       # SOL profit milestone step

logging.basicConfig(level=logging.INFO, format='[SOCIAL] %(message)s')
log = logging.getLogger('pcp-social')

# ── Twitter client ─────────────────────────────────────────────────────────────
def make_client() -> tweepy.Client | None:
    api_key    = os.getenv('TWITTER_API_KEY')
    api_secret = os.getenv('TWITTER_API_SECRET')
    acc_token  = os.getenv('TWITTER_ACCESS_TOKEN')
    acc_secret = os.getenv('TWITTER_ACCESS_TOKEN_SECRET')
    if not all([api_key, api_secret, acc_token, acc_secret]):
        log.error('Twitter credentials not set — check .env')
        return None
    return tweepy.Client(
        consumer_key=api_key, consumer_secret=api_secret,
        access_token=acc_token, access_token_secret=acc_secret,
        wait_on_rate_limit=True
    )

# ── Stats ──────────────────────────────────────────────────────────────────────
def get_stats() -> dict:
    if not JOURNAL.exists():
        return {}
    trades = [json.loads(l) for l in JOURNAL.read_text().splitlines() if l.strip()]
    sells  = [t for t in trades if t.get('action') == 'SELL' and t.get('agent') == 'pcp-sniper']
    today  = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    today_sells = [t for t in sells if datetime.fromtimestamp(t.get('ts',0)/1000,tz=timezone.utc).strftime('%Y-%m-%d') == today]

    wins   = [t for t in today_sells if (t.get('pnlSol') or 0) > 0]
    losses = [t for t in today_sells if (t.get('pnlSol') or 0) <= 0]
    total_pnl = sum(t.get('pnlSol', 0) for t in today_sells)
    best  = max((t.get('pnlSol', 0) for t in today_sells), default=0)
    wr    = round(len(wins) / len(today_sells) * 100, 1) if today_sells else 0

    # Top token by profit
    by_token: dict[str, float] = {}
    for t in wins:
        sym = t.get('symbol', '?')
        by_token[sym] = by_token.get(sym, 0) + (t.get('pnlSol') or 0)
    top = max(by_token, key=by_token.get, default='—') if by_token else '—'

    # Exit mix
    exits = {}
    for t in today_sells:
        cause = (t.get('reason') or 'UNK').split()[0]
        exits[cause] = exits.get(cause, 0) + 1

    return {
        'trades': len(today_sells), 'wins': len(wins), 'losses': len(losses),
        'wr': wr, 'total_pnl': round(total_pnl, 5),
        'best': round(best, 5), 'top': top, 'exits': exits,
        'total_pnl_usd': round(total_pnl * SOL_PRICE, 2),
    }

def get_session_total() -> float:
    """Total pnl across all journal SELL entries this session."""
    if not JOURNAL.exists():
        return 0.0
    trades = [json.loads(l) for l in JOURNAL.read_text().splitlines() if l.strip()]
    return sum(t.get('pnlSol', 0) for t in trades if t.get('action') == 'SELL')

# ── Post templates ────────────────────────────────────────────────────────────
ROUTINES = [
    """⚡ PocketChange running non-stop

{trades} trades today | WR: {wr}% | {pnl_sign}{total_pnl} SOL
AI swarm self-tuned mid-session 🧠

Bags don't sleep. Neither does PCP 👜

CA: {ca}
{tags}""",

    """📊 PCP daily snapshot

{trades} trades | {wins}W / {losses}L | Best: +{best} SOL
HarmonyAgent rebalancing capital across 3 strategies

While you sleep, the bot works 💤→💰

CA: {ca}
{tags}""",

    """🔄 PCP engine cycle complete

Top performer today: {top}
Win rate: {wr}% | Capital rotating into strongest edge

This is what systematic trading looks like

CA: {ca}
{tags}""",
]

MILESTONES = [
    """🔥 PCP just crossed another profit milestone

Multi-strategy AI. Real edge. Compounding gains.
3 engines running in parallel — Sniper, Arb, PumpFun

Your pocket change working harder than you are 💼

CA: {ca}
{tags}""",

    """💰 Milestone hit. Bags growing.

PocketChange Protocol doing what it was built for
AI swarm adapting. Capital deploying where the edge is.

Still early. Still running. 🚀

CA: {ca}
{tags}""",
]

BOOT_POST = """⚡ PocketChange Protocol is live

3 strategies. 9 AI agents. Fully autonomous.
Momentum sniper + Arb + PumpFun all active 🎯

Capital allocation self-optimizing every 10 min
Competitor bots don't have this 👀

CA: {ca}
{tags}"""

# ── State ──────────────────────────────────────────────────────────────────────
def load_state() -> dict:
    if STATE_F.exists():
        try: return json.loads(STATE_F.read_text())
        except: pass
    return {'last_post_ts': 0, 'last_milestone': 0.0, 'boot_posted': False}

def save_state(s: dict):
    STATE_F.parent.mkdir(parents=True, exist_ok=True)
    STATE_F.write_text(json.dumps(s, indent=2))

# ── Post ───────────────────────────────────────────────────────────────────────
def post(client: tweepy.Client, text: str) -> bool:
    text = text[:280]  # hard cap
    try:
        resp = client.create_tweet(text=text)
        log.info(f'Posted: {text[:60]}...')
        return True
    except tweepy.TweepyException as e:
        log.error(f'Post failed: {e}')
        if '429' in str(e):
            log.info('Rate limited — backing off 15min')
            time.sleep(900)
        return False

def format_routine(template: str, s: dict) -> str:
    sign = '+' if s.get('total_pnl', 0) >= 0 else ''
    return template.format(
        trades=s.get('trades', 0), wins=s.get('wins', 0),
        losses=s.get('losses', 0), wr=s.get('wr', 0),
        total_pnl=abs(s.get('total_pnl', 0)), pnl_sign=sign,
        best=s.get('best', 0), top=s.get('top', '—'),
        ca=CA, tags=TAGS
    )

# ── Main loop ──────────────────────────────────────────────────────────────────
def main():
    log.info('PCP Social Poster starting...')
    client = make_client()
    if not client:
        log.error('No Twitter client — set TWITTER_API_KEY etc. in .env')
        return

    state = load_state()
    now   = time.time()

    # Boot post (once per session)
    if not state.get('boot_posted'):
        text = BOOT_POST.format(ca=CA, tags=TAGS)
        if post(client, text):
            state['boot_posted'] = True
            state['last_post_ts'] = now
            save_state(state)
            time.sleep(5)

    while True:
        now   = time.time()
        stats = get_stats()
        total = get_session_total()

        # Milestone check
        last_milestone = state.get('last_milestone', 0.0)
        if total >= last_milestone + MILESTONE:
            crossed = int(total / MILESTONE) * MILESTONE
            text = random.choice(MILESTONES).format(
                pnl=round(total, 4), ca=CA, tags=TAGS
            )
            if post(client, text):
                state['last_milestone'] = crossed
                state['last_post_ts']   = now
                save_state(state)
            time.sleep(10)

        # Routine 6h post
        elif now - state.get('last_post_ts', 0) >= INTERVAL:
            if stats.get('trades', 0) > 0:
                text = format_routine(random.choice(ROUTINES), stats)
            else:
                text = BOOT_POST.format(ca=CA, tags=TAGS)  # fallback
            if post(client, text):
                state['last_post_ts'] = now
                save_state(state)

        time.sleep(300)  # check every 5min

if __name__ == '__main__':
    main()
