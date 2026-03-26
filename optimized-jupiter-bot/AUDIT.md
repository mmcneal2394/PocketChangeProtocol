# PocketChange Protocol — Engine Audit Guide

## Scope

This branch (`audit/engine-v1`) contains the full source of the PCP autonomous trading swarm for external security and code review.

**What auditors should focus on:**
1. Trade execution logic — `scripts/maintain/momentum_sniper.ts`
2. Fund safety — wallet/ATA handling, WSOL manager
3. Exit logic — stop-loss, trailing TP, order flow reversal
4. Optimizer integrity — can it corrupt live params?
5. Signal freshness — stale data attack surface

---

## Architecture Overview

```
signals/          ← shared memory bus (JSON files, written by feed agents)
scripts/maintain/ ← all active agent scripts
src/utils/        ← shared utilities (wsol_manager.ts, price_feed.ts)
src/security/     ← contract_screener.ts (rug detection)
```

---

## Key Files

| File | Purpose |
|---|---|
| `scripts/maintain/momentum_sniper.ts` | Primary trading agent — entry, exit, position mgmt |
| `scripts/maintain/pumpfun_sniper.ts` | PumpFun launchpad trading agent |
| `scripts/maintain/velocity_stream.ts` | Real-time on-chain swap stream (Chainstack gRPC) |
| `scripts/maintain/trending_injector.ts` | DexScreener signal ingestion |
| `scripts/maintain/trading_optimizer.py` | 6-stage genetic optimizer — reads journal, evolves params |
| `scripts/maintain/chart_strategist.ts` | TA signal generation |
| `src/utils/wsol_manager.ts` | WSOL ATA management — persistent capital storage |
| `src/security/contract_screener.ts` | Token rug/exploit detection (8 checks) |

---

## Security Considerations for Auditors

### 1. Slippage
- Buy slippage: `500 bps` (5%) — review if acceptable for micro-caps
- Sell slippage: `500 bps` (5%) — same

### 2. Priority Fees
- Buy: `30,000 lamports` — verify not over-paying
- TP exit: `5,000 lamports`
- SL exit: `25,000 lamports` (aggressive for fast exit)
- Trail exit: `10,000 lamports`

### 3. WSOL ATA
- Native SOL reserve maintained at `0.02 SOL` for tx fees
- WSOL ATA auto-refills from native SOL — review `autoRefillWsol()`

### 4. Position Sizing
- Default: 10% of WSOL balance per trade
- Floor: `0.005 SOL`
- Ceiling: `0.03 SOL`
- Kelly fractioned and harmony-weighted

### 5. Optimizer Safety
- Parameters only promoted when fitness > 110% of current champion
- LLM proposals validated by backtester before promotion
- Memory isolated in `signals/swarm/memory.json`

### 6. Orphan Recovery
- Scans for token balances not in positions store
- WSOL and native SOL explicitly excluded from orphan recovery
- Review: `recoverOrphans()` in `momentum_sniper.ts`

---

## What is NOT in this branch

- `.env` — API keys, RPC endpoints, wallet paths
- Wallet keypair files (`*.json` in root/bot dir)
- `signals/` directory — live trade journal, positions (runtime data)
- `scripts/_archive/` — deprecated legacy scripts

---

## Running Locally (dry run)

```bash
cd optimized-jupiter-bot
npm install
cp .env.example .env  # fill in your own keys
npx ts-node scripts/maintain/momentum_sniper.ts --dry-run
```

> No `.env.example` yet — contact repo owner for required keys list.

---

## Contact

**X:** [@PocketChangePCP](https://twitter.com/PocketChangePCP)
**CA:** `4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS`
