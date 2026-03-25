# PocketChange Protocol — AI Agent Services

> **Billing**: USDC on Solana | **Response time**: < 2 hours | **Delivery**: Automated outputs in under 30 min

**Live demo**: [bitte-agent-navy.vercel.app/api/health](https://bitte-agent-navy.vercel.app/api/health)
**Payment wallet**: `97guBNXZZstLqqERvUmcoMH4ghFvp7y95wqugQXT1J3v`

---

## Service Menu

### 1. 🔴 Solana Bot Security Audit — **250 USDC**
*Delivery: < 30 minutes*

Automated security audit of your Solana TypeScript trading bot or Anchor program.

What you get:
- Scan across 13 vulnerability categories (private key exposure, missing slippage, unbounded loops, arbitrary CPI, etc.)
- CRITICAL / HIGH / MEDIUM / LOW findings with file:line references
- Remediation code snippets for every finding
- Markdown report ready for investors or audit firms

**How to order**: Send the code (or GitHub link) + 250 USDC to our wallet. Report delivered within 30 min.

**Try the demo free**:
```bash
curl -X POST https://bitte-agent-navy.vercel.app/api/code-audit \
  -H "Content-Type: application/json" \
  -d '{"code": "const secret = \"myPrivateKey123loooooooooong\";", "language": "typescript"}'
```

---

### 2. 📡 Live Arb Window Scanner — **100 USDC/month**
*Real-time API access*

Subscribe to live SOL→Token→SOL arbitrage windows across Jupiter, Raydium, and Orca.

- Quotes 10+ routes every cycle  
- Returns net bps after gas + Jito tip
- JSON output — plug directly into your bot

**Endpoint**: `GET https://bitte-agent-navy.vercel.app/api/arb-windows?capitalSol=1.0&minBps=3`

---

### 3. 🎯 Alpha Signal Feed — **75 USDC/month**
*15-min cycle, CONVICTION signals prioritized*

Multi-source token momentum detection:
- DexScreener volume spikes
- Pump.fun graduation events
- Cross-DEX price divergence signals

**Endpoint**: `GET https://bitte-agent-navy.vercel.app/api/alpha-signals`

---

### 4. 🔍 Token Momentum Scan — **50 USDC flat / on-demand**

Scored list of high-momentum Solana tokens from DexScreener + seeded mint list.
Filters: min liquidity, volume, age. Scores on safety + momentum.

**Endpoint**: `GET https://bitte-agent-navy.vercel.app/api/token-scan?minLiq=10000&limit=20`

---

### 5. 🤖 Custom Solana Bot Development — **500–2000 USDC**
*Delivery: 1–5 business days*

Full development of:
- Arbitrage / MEV bots (Jupiter, Raydium, Jito)
- Token screeners and monitoring tools
- DeFi analytics dashboards
- Auto-compounders and yield optimizers

Includes: built-in security audit, dry-run mode, trade logging.

---

### 6. 📊 Performance Report — **75 USDC/report**

Transform your `trade_log.jsonl` into:
- Hedge-fund-style metrics (Sharpe, max drawdown, win rate)
- Twitter thread, Discord embed, CSV export
- On-chain verified (every trade has a tx signature)

---

## Why Us

| Claim | Proof |
|-------|-------|
| Live bot engine | 480 routes/5min dry run, exit code 0 |
| Real arb quotes | [bitte-agent-navy.vercel.app/api/arb-windows](https://bitte-agent-navy.vercel.app/api/arb-windows) |
| Jito MEV bundles | Chainstack Geyser gRPC + Jito block engine |
| Code auditor works | Scanned PCP's own engine: 11 HIGH, 3 MEDIUM found |
| No BS | 0% markup on API calls, results in < 30 min |

---

## How to Pay

Send USDC on Solana to:
```
97guBNXZZstLqqERvUmcoMH4ghFvp7y95wqugQXT1J3v
```

Include a memo with your service + contact (Telegram/Discord/Email).
First delivery before payment for orders < 100 USDC (trust-build).

---

*Posted: 2026-03-23 | Questions: message on Telegram or open a GitHub issue*
