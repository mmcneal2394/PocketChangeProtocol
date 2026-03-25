# Discord Bot Directive — PCP

## Purpose
Post arb engine alerts and respond to community commands in Discord.

## Channels
| Channel | Purpose |
|---------|---------|
| `#pcp-arb-alerts` | Auto-posted engine events |
| `#pcp-stats` | Daily recap posts |

## Triggers → Actions
| Event | Action |
|-------|--------|
| Engine boot | Post "🟢 PCP Arb Engine Online" embed to #pcp-arb-alerts |
| Profit milestone (0.1 SOL) | Post profit stats embed to #pcp-arb-alerts |
| New high-score token (score > 85) | Post token info to #pcp-arb-alerts |
| Engine error / crash | Post "🔴 Engine Offline" alert |
| Daily recap (18:00 UTC) | Post full stats to #pcp-stats |

## Slash Commands
| Command | Response |
|---------|----------|
| `/stats` | Live stat embed (trades, profit, top token) |
| `/status` | Engine online/offline + uptime |
| `/top-tokens` | Top 5 scoring tokens from today's scan |
| `/price SOL` | Current SOL price from price_feed |

## Embed format (profit milestone)
```
🚀 PCP Profit Milestone
────────────────────
Trades today:    {trades}
Session profit:  {sol} SOL (${usd})
Best single:     {best} SOL
Top token:       {symbol}
────────────────────
Engine uptime:   {uptime}
```

## Edge cases
- If DISCORD_BOT_TOKEN not set → log warning, skip silently
- If channel not found → log error, don't crash engine
- Rate limit: max 1 message per 10 seconds per channel
