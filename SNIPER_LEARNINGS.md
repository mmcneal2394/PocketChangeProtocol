# PCP Momentum Sniper — Learnings & Rules

**Last updated:** 2026-03-28
**Data source:** 26 live trades + 72 Artemis paper trades + 17 backtest trades
**Wallet PnL:** -0.0127 SOL (-1.3%) across ~60 trades (fees eating gross profit)

---

## Hard Rules (data-proven, always enforce)

### Entry Filters
| Rule | Data | Trades |
|------|------|--------|
| **mcap < $20k** | Every trade >$20k lost. Winners avg $10.9k, losers avg $25.4k | 26 live |
| **velocity < 6** | vel >6 = 100% loss rate. Shoebill (8.1), Clawicular (7.4), NPC loss (6.1) | 26 live |
| **buy ratio < 5x** | ratio >5x = trap. Shoebill (8.9x), NPC (6.9x). Only exception: gary (5.0x) | 26 live |
| **top holder < 80%** for <5min, **< 50%** for older | Fresh pump.fun tokens start with 70-80% creator concentration | 26 live |
| **No honeypots** | Birdeye security scan on entry | Birdeye API |
| **No freeze authority** | Can lock your tokens | Birdeye API |
| **Never re-enter same token** | SWING 0/5, FREEDOM 1/7, Greg 0/3 in Artemis data | 72 Artemis |

### Entry Preferences (scorer features, not hard gates)
| Signal | Win Rate | Source |
|--------|----------|--------|
| Buy ratio 1.3-1.5x (sweet spot) | 83% WR | 17 PCP backtest |
| Dip + buy pressure (chg1h < 0, ratio > 1.3x) | 71% WR | 17 PCP backtest |
| Low liquidity (< $10k) | 67% WR | 17 PCP backtest |
| Token age < 120s | Higher WR | 26 live |
| Price NOT already pumped | 52% WR at 0-10% vs 17% at 10-50% | 72 Artemis |

### Overconfidence Trap
- Artemis "strong" signals: **0% WR** (0/5). When the scorer is most confident, it's stacking momentum signals that are traps.
- Score > 0.75 gets -10% penalty.

---

## Exit Strategy (validated by post-exit analysis)

### Exit Types — Performance
| Exit Type | Win Rate | Avg PnL | Verdict |
|-----------|----------|---------|---------|
| STALE (momentum died) | **90%** (9/10) | +15.2% | Best exit — hold until token dies |
| TRAIL (trailing stop) | **100%** (5/5) | +12.6% | Perfect — catches peaks |
| P2-BE (breakeven) | **0%** (0/4) | -4.2% | 3/4 were correct exits (tokens died) |
| P1-SL (hard stop) | **0%** (0/7) | -15.6% | 6/7 were correct exits (true dumps) |

### Exit Parameters (live-tunable via live_tuner.ts)
- Hard SL: -12.5%
- Catastrophic SL: -12.5% (overrides 15s breathing room)
- Breakeven trigger: +12% (SL moves to 0%)
- Trail trigger: +20% (trailing stop activates)
- Trail distance: 12% below peak
- Full TP: +60%
- Min hold: 15s (only blocks downside SL, TP/trail always fire)

### Post-Exit Validation (19 exits checked)
- **16/19 exits were correct** (84% accuracy)
- Only 1 token (NPC) pumped significantly after we sold (+160%)
- Every P1-SL token went to -64% to -95% from entry — SL saves capital

---

## Trap Signals (confirmed across both Artemis and PCP)

| Signal | Looks like | Actually means |
|--------|-----------|---------------|
| Holder growth detected | "Organic growth" | You're LATE — crowd already there (16% WR) |
| Active volume | "High interest" | Same — crowd signal (17% WR) |
| Price already up >30% | "Momentum" | Buying the top — worst entries |
| Very high velocity (>6 tx/min) | "Explosive demand" | Creator self-buying to attract bots |
| Very high buy ratio (>5x) | "All buyers" | Single whale or bot, not organic |
| "Strong" confidence score | "Sure thing" | Stacked traps, 0/5 in Artemis |

---

## Architecture

### Detection Pipeline
1. **Velocity tracker** (WebSocket logsSubscribe) — detects fresh pump.fun mints in <5s
2. **DexScreener poll** (every 5s) — catches tokens already trading with momentum
3. Pump.fun mints (`*pump`) fire callback instantly — no API validation delay

### Enrichment (before scoring)
- **Helius RPC**: `getTokenLargestAccounts` — holder distribution, top holder %
- **Birdeye paid API** (7 rps): token overview (mcap, liq, holders) + security scan (honeypot, freeze auth)
- **Geyser** (Yellowstone): real-time pool reserves via Redis

### Learning System
- **Market observer**: tracks ALL velocity-detected tokens at 30s/1m/3m/5m (500+/day)
- **Post-exit monitor**: checks sold tokens at 30s/1m/3m/5m after exit
- **Post-mortem**: checks at 1h/6h/24h via Birdeye + Helius
- **Auto-tuner**: every 10 post-mortems, recomputes feature importance and updates scorer weights in Postgres
- **Live tuner**: exit params auto-adjust based on missed gains vs correct exits

### Data Storage
- **Postgres**: `sniper_trades` (entry metrics + outcomes), `scorer_state` (weights), `trade_postmortems`, `feature_importance`
- **Redis**: position sharing (cross-bot deconfliction), pool state subscriber, velocity data

---

## Key Metrics (update as data grows)

**Current**: 26 live trades, 54% WR, -1.3% wallet PnL (fees eating profit)

**What works**: catching fresh (<$20k mcap) pump.fun tokens with moderate velocity (2-5), holding 30-60s, exiting via STALE or TRAIL.

**What doesn't**: high velocity tokens (>6 = creator bots), high mcap (>$20k = late), high ratio (>5x = whale trap), P2-BE breakeven exits on volatile tokens.

**Next steps**: lower fees (compute unit price already reduced 500k→100k), widen winning edge to overcome tx costs.
