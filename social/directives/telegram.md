# Telegram Bot Directive — PCP

## Purpose
Broadcast channel alerts for significant arb events to PCP Telegram channel.

## Broadcast triggers
| Trigger | Message |
|---------|---------|
| Engine boot | "🟢 PCP Engine Online — watching 20 tokens" |
| Profit milestone (0.1 SOL each) | Mini stat recap |
| Daily recap (18:00 UTC) | Full daily summary |
| Engine error | "🔴 PCP Engine Alert: {error}" |

## Commands (in group/private chat)
| Command | Response |
|---------|----------|
| `/stats` | Live trade stats |
| `/status` | Engine online/offline |
| `/sol` | Current SOL price |

## Message format
Plain text (Telegram MarkdownV2):
```
⚡ *PCP Arb Update*
Trades: {trades} \| Profit: {sol} SOL \(${usd}\)
Best: {best} SOL
\#Solana \#PCP
```

## Edge cases
- If TELEGRAM_BOT_TOKEN not set → log warning, skip silently
- Flood control: max 1 broadcast per 30s to avoid Telegram 429
