# Arbitrage Engine Implementation Design

**Date:** 2026-03-22
**Status:** Approved
**Approach:** Complete existing Rust engine (Approach 2)

## Overview

Complete the scaffolded Rust arbitrage engine into a tri-mode (paper/devnet/mainnet) system that detects and executes arbitrage opportunities across 5 strategies, with a multi-channel approval flow and production-grade safety controls.

The engine is a single Rust binary using Tokio async runtime. Internal modules communicate via Tokio mpsc/broadcast channels. No external message bus (NATS) for v1.

## Migration from Existing Scaffold

The existing `engine-worker/` codebase is a multi-tenant scaffold. This implementation converts to single-operator mode.

**Keep and extend:**
- `VaultExecutor` instruction builders (`build_vault_ptb`)
- `JupiterProvider` HTTP pattern in `engine/providers.rs`
- `DbClient` JSONL telemetry writer in `db/mod.rs`
- `KMSClient` AES-GCM cipher initialization in `kms/mod.rs`
- Cargo.toml dependency structure

**Remove:**
- All `tenant_id` / `TenantConfig` references
- `SandboxManager` multi-tenant sandbox management
- NATS connection and subscription code in `main.rs`
- `check_wallets.rs` (dead code referencing external path)
- Hardcoded keypair return in `kms/mod.rs`

**Rewrite:**
- `main.rs` — new startup sequence with task spawning
- `config/mod.rs` — TOML + env var loading (replace empty `sync_from_postgres`)
- `engine/mod.rs` — replace `VaultExecutor` process_loop with strategy-driven architecture

## Engine Modes & Configuration

Three modes controlled by a single config enum:

- **Paper** — Connects to mainnet RPC for real price data. Detects opportunities, logs to telemetry, sends to approval pipeline. Never submits transactions. Tracks virtual balance for P&L simulation.
- **Devnet** — Full execution against devnet. Real transactions via Jito (devnet endpoint). Uses devnet-deployed vault contract.
- **Mainnet** — Production. Real funds, real Jito bundles, real vault contract. Circuit breakers and hard stop-loss limits active.

Configuration lives in `engine.toml` (non-secret values only):

```toml
mode = "paper"                    # paper | devnet | mainnet
jito_endpoint = "https://mainnet.block-engine.jito.wtf"
auto_execute_threshold_default = 0.5  # % — default for atomic strategies
approval_timeout_secs = 300       # wait 5min for manual approval, then skip
max_loss_24h = 50.0               # SOL — hard stop-loss circuit breaker
max_trade_size = 10.0             # SOL per trade

# Per-strategy threshold overrides
[strategy.triangular]
auto_execute_threshold = 0.3      # % profit

[strategy.cex_dex]
auto_execute_threshold = 1.0      # % — higher bar for non-atomic

[strategy.flash_loan]
auto_execute_threshold = 0.3      # %

[strategy.funding_rate]
auto_execute_threshold = 0.08     # % funding rate differential

[strategy.statistical]
auto_execute_threshold = 2.0      # z-score threshold
```

**All secrets via env vars (never in config files):**
- `SOLANA_RPC_URL` — Solana RPC endpoint
- `KMS_MASTER_KEY` — AES master key for wallet decryption
- `KMS_MASTER_KEY_PREVIOUS` — Previous master key for rotation
- `TELEGRAM_BOT_TOKEN` — Telegram bot API token
- `TELEGRAM_CHAT_ID` — Telegram chat for notifications
- `BITGET_API_KEY` / `BITGET_API_SECRET` / `BITGET_PASSPHRASE` — CEX API
- `ENGINE_API_SECRET` — Bearer token for engine HTTP API authentication
- `SOLANA_PRIVATE_KEY` — Engine wallet (Base58, or use KMS-encrypted path)

## Core Architecture & Data Flow

```
+-------------------------------------------------------+
|                    Engine Binary                        |
|                                                         |
|  +--------------+    +----------------------+          |
|  | Price Feeds  |--->| Opportunity Detector  |          |
|  | (polling)    |    | (per-strategy)        |          |
|  +--------------+    +----------+-----------+          |
|                                 |                       |
|                        Opportunity                      |
|                                 v                       |
|                      +------------------+              |
|                      | Approval Router   |              |
|                      | (threshold check) |              |
|                      +---+----------+---+              |
|                   auto   |          |  needs approval   |
|                          v          v                   |
|               +----------+  +-------------+            |
|               | Executor  |  | Approval Q   |            |
|               | (Jito/RPC)|  | (Telegram +  |            |
|               +-----+----+  |  Dashboard)  |            |
|                     |        +------+------+            |
|                     |               | approved          |
|                     |               v                   |
|                     |        +----------+              |
|                     |        | Executor  |              |
|                     |        +-----+----+              |
|                     v              v                    |
|               +------------------------+               |
|               | Telemetry Writer        |               |
|               | (JSONL + Dashboard API) |               |
|               +------------------------+               |
+-------------------------------------------------------+
```

### Module Breakdown

1. **Price Feeds** — Polls Jupiter quote API (500ms) and CEX REST APIs (2s). Maintains in-memory price cache. Emits price snapshots to a Tokio broadcast channel that all strategy detectors subscribe to. On 429/timeout, applies exponential backoff (1s, 2s, 4s, max 30s). If a feed has not responded in 5s, marks its prices as stale — strategies skip detection for stale data.

2. **Opportunity Detector** — One async task per strategy. Each subscribes to the price feed channel, runs detection logic, emits `Opportunity` structs to the approval router channel. Each strategy has its own `auto_execute_threshold` (configurable per-strategy). Strategies normalize their signal to a common profit percentage via `normalized_profit_pct()`.

3. **Approval Router** — If normalized profit >= strategy's threshold and mode is not Paper, sends to executor. If below threshold or Paper mode, queues for manual approval. In Paper mode, all opportunities are logged but never executed. Uses atomic compare-and-swap on opportunity status to prevent double-approval from Telegram + Dashboard race condition.

4. **Approval Queue** — Sends Telegram message with opportunity details. Exposes authenticated HTTP endpoints for dashboard to query pending opportunities and submit approve/reject. Waits up to `approval_timeout_secs`, then drops the opportunity.

5. **Executor** — Receives `Vec<Instruction>` from strategies, composes final transaction with Jito tip, signs and submits. In Devnet/Mainnet mode, submits via Jito bundle API. In Paper mode, simulates via `simulateTransaction` RPC. Records result to telemetry.

6. **Telemetry Writer** — Appends trade results to `telemetry.jsonl` and pushes to Next.js API via HTTP POST for real-time dashboard updates.

### Key Design Decisions

- All inter-module communication via Tokio mpsc/broadcast channels
- Price cache is in-memory, shared via `Arc<RwLock<PriceCache>>`
- Each strategy runs as an independent async task — one crashing doesn't take down others
- Circuit breaker lives in the Executor: tracks cumulative 24h P&L, halts if `max_loss_24h` is breached
- Profit calculations and P&L tracking use `rust_decimal::Decimal` for precision. Price feed data uses `f64`.

## Strategy Implementations

Each strategy implements a common trait:

```rust
#[async_trait]
trait Strategy {
    fn name(&self) -> &str;
    async fn evaluate(&self, prices: &PriceCache) -> Vec<Opportunity>;
    fn build_instructions(&self, opp: &Opportunity, wallet: &Keypair) -> Result<Vec<Instruction>>;
    fn min_profit_threshold(&self) -> Decimal;
    fn normalized_profit_pct(&self, opp: &Opportunity) -> Decimal;
}
```

Note: Strategies return `Vec<Instruction>`, not `Transaction`. The executor composes the final transaction with Jito tip instructions.

### 1. Triangular DEX Arbitrage

- **Detection:** Maintains predefined 3-hop routes (e.g., SOL -> RAY -> USDC -> SOL). On each price update, calculates round-trip return using Jupiter quotes. Flags routes where return > fees + slippage.
- **Execution:** Single atomic transaction — 3 Jupiter swap instructions chained. If any leg fails, entire TX reverts. Zero capital risk.
- **Normalization:** `normalized_profit_pct = round_trip_return - estimated_fees`
- **Polling:** 500ms

### 2. CEX-DEX Arbitrage

- **Detection:** Compares Bitget orderbook prices (REST API) against Jupiter DEX quotes. Flags when spread > withdrawal fee + gas + slippage.
- **Execution:** Two-phase, NOT atomic. Has execution risk.
- **Order of operations:** DEX leg first (on-chain, faster finality), then CEX leg. Rationale: on-chain state is verifiable; if DEX leg fails, we haven't touched the CEX.
- **Normalization:** `normalized_profit_pct = spread - total_fees`
- **Risk management:** Only executes when spread is >2x estimated fees. Position size capped lower than atomic strategies. Tracks open exposure and won't open new position until previous settles.
- **Settlement & Error Recovery:**
  - **DEX leg fails:** No CEX order placed. Opportunity dropped, logged as failed. No exposure.
  - **DEX succeeds, CEX order fails:** Engine has on-chain inventory. Opens a "stuck position" record. Retries CEX order 3x with backoff. If still failing, alerts Telegram with "MANUAL INTERVENTION REQUIRED" and the position details. Position auto-expires after `max_cex_exposure_secs` (default 300s) — at which point the engine reverses the DEX leg at market.
  - **CEX partial fill:** Treats unfilled portion as a stuck position (same recovery as above).
  - **CEX fills at worse price:** If net profit turns negative, still completes (already committed). Logs the slippage. Circuit breaker tracks the loss.
  - **Maximum open exposure:** One CEX-DEX position at a time. Configurable `max_cex_exposure_secs`.
- **Polling:** 2s (CEX rate limits)

### 3. Flash Loan Routing

- **Detection:** Uses vault contract's `borrow_for_arbitrage` instruction. Scans for profitable Jupiter routes where borrowed capital -> swap -> repay principal + profit happens in a single transaction.
- **Execution:** Single PTB: vault borrow -> Jupiter swap(s) -> vault repay with profit. All instructions in one transaction — if any instruction fails, the entire transaction reverts and no funds move.
- **Trust model:** Atomicity is enforced at the Solana runtime level (transaction-level rollback), not by the vault program itself. The vault program trusts the admin signer. The security boundary is the engine wallet's signing key. This is trust-minimized (admin can only profit, not steal — borrow and repay are in the same TX), but not trustless. See "Smart Contract Hardening" section for on-chain enforcement improvements.
- **Dependency:** Requires deployed vault contract. If vault not found at startup, this strategy is disabled with a warning — other strategies continue.
- **Normalization:** `normalized_profit_pct = (repay_amount - borrow_amount) / borrow_amount`
- **Polling:** 500ms

### 4. Funding Rate Arbitrage

- **Detection:** Fetches Drift Protocol funding rates. When perp funding rate diverges significantly from spot yield, flags opportunity.
- **Execution:** Opens hedged position — long spot + short perp (or vice versa) to capture funding rate differential. Positions held hours/days.
- **Normalization:** `normalized_profit_pct = abs(funding_rate_differential)` (annualized to match other strategies)
- **Risk management:** Not atomic. Requires position tracking, periodic funding collection, exit logic. Engine maintains `ActivePosition` record and monitors exit conditions (rate convergence, max hold time, stop-loss).
- **Polling:** 60s

### 5. Statistical Arbitrage

- **Detection:** Tracks price ratios of correlated token pairs (e.g., SOL/JitoSOL, mSOL/SOL). Calculates z-score of current ratio vs rolling mean. Flags when z-score exceeds threshold.
- **Execution:** Opens pair trade — long underperformer, short outperformer. Closes when ratio reverts to mean.
- **Normalization:** `normalized_profit_pct = abs(z_score) * historical_pct_per_z` (converts z-score to expected % return based on backtested data)
- **Risk management:** Held positions tracked as `ActivePosition` with entry ratio, target ratio, stop-loss, max hold time.
- **Polling:** 5s

**Implementation priority:** Triangular (#1) and Flash Loan (#3) first (atomic/zero-risk), then CEX-DEX (#2), then Funding Rate (#4) and Statistical (#5) (require position management).

## Approval Flow & Notifications

### Telegram Bot

Engine sends formatted opportunity messages:

```
Arb Opportunity Detected
Strategy: Triangular DEX
Route: SOL -> RAY -> USDC -> SOL
Expected Profit: 0.34% ($17.20)
Trade Size: 5,000 USDC
Mode: Mainnet

Reply: /approve_<id> or /reject_<id>
```

Lightweight HTTP polling loop checks Telegram bot updates (getUpdates API). Also sends execution results, circuit breaker alerts, and daily P&L summaries.

### Dashboard Notifications

Engine exposes an authenticated HTTP server (port 3002) with endpoints:

- `GET /api/status` — engine health, mode, active strategies, circuit breaker state
- `GET /api/opportunities` — pending opportunities awaiting approval
- `POST /api/opportunities/:id/approve` — approve an opportunity
- `POST /api/opportunities/:id/reject` — reject an opportunity
- `GET /api/positions` — active held positions (funding rate, stat arb)

**Authentication:** All endpoints require `Authorization: Bearer <ENGINE_API_SECRET>` header. The secret is shared between engine and Next.js via env var. Port 3002 must not be publicly exposed — only accessible within the Docker network or via the Next.js proxy.

**Status endpoint response schema:**
```json
{
  "mode": "mainnet",
  "uptime_secs": 3600,
  "active_strategies": ["triangular", "flash_loan", "cex_dex"],
  "disabled_strategies": ["funding_rate"],
  "circuit_breaker": { "active": false, "reason": null },
  "pnl_24h": "1.42",
  "total_opportunities_detected": 847,
  "total_trades_executed": 23,
  "price_feeds": {
    "jupiter": { "status": "ok", "last_update_ms": 142 },
    "bitget": { "status": "stale", "last_update_ms": 8200 }
  }
}
```

Next.js dashboard polls these. Existing `/api/engine` route already proxies to port 3002.

### Auto-Execute Logic

```
Opportunity detected
  |
  +- Mode == Paper?
  |   -> Log to telemetry + Telegram alert. Never execute.
  |
  +- Profit >= strategy's auto_execute_threshold?
  |   +- Circuit breaker OK?
  |   |   -> Execute immediately. Notify Telegram after.
  |   +- Circuit breaker tripped
  |       -> Reject. Alert: "Circuit breaker active"
  |
  +- Profit < strategy's auto_execute_threshold
      -> Queue for approval (Telegram + Dashboard)
          +- Approved within timeout -> Execute (atomic CAS on status prevents double-approval)
          +- Rejected -> Drop, log reason
          +- Timeout -> Drop, log as "expired"
```

### Circuit Breaker Rules

- Cumulative 24h realized loss exceeds `max_loss_24h` -> halt all execution, alert Telegram
- Single trade loss exceeds 2x `max_trade_size` -> halt, alert
- 5 consecutive failed transactions -> pause 5 minutes, alert
- Manual resume via Telegram `/resume` command or dashboard button

## KMS & Wallet Management

### AES-256-GCM Implementation

Complete the existing `kms/mod.rs`:

- **Encryption:** When wallet registered, private key encrypted with `AES-256-GCM(master_key, nonce, plaintext_key)`, stored with nonce and salt. Already works in `/api/wallets` POST.
- **Decryption:** At engine startup, `KMSClient::decrypt()` performs real AES-GCM decryption using master key from `KMS_MASTER_KEY` env var. Decrypted keys live only in memory. Never written to disk.
- **Key rotation:** `KMS_MASTER_KEY_PREVIOUS` env var. On startup, if decryption with current key fails, try previous key and re-encrypt with new one.

### Wallet Architecture

- **Engine Wallet (hot)** — Gas fees, Jito tips, signing. Funded with small SOL balance (1-2 SOL). KMS-decrypted from config.
- **Vault PDA (program-controlled)** — Pooled USDC from depositors. Flash loan borrows. Only accessible via vault program instructions (non-custodial).
- **CEX Subaccount** — API key/secret encrypted via KMS. Trade-only permissions (no withdrawal via API).

### Security Boundaries

- Engine wallet only holds enough SOL for gas
- Vault capital is program-controlled, engine can only borrow and repay atomically
- CEX API keys are trade-only
- Master key only in env var and memory, never in config files or logs
- Engine HTTP API requires Bearer token authentication

## Database & Telemetry

### Migration to PostgreSQL

**Migration steps:**
1. Change `prisma/schema.prisma` provider from `sqlite` to `postgresql`
2. Add `Opportunity` model (see below)
3. Set `DATABASE_URL` env var to PostgreSQL connection string
4. Run `npx prisma migrate dev` to create migration
5. No data migration needed — SQLite had no production data (all mock)

**Moves to PostgreSQL (via Prisma):**
- `TradeLog` — executed/simulated trades
- `ActivePosition` — held positions for funding rate and stat arb
- `Opportunity` (new model) — pending/approved/rejected/expired opportunities
- `User`, `Wallet`, `TradingConfig` — already defined

**Stays as JSONL:**
- `telemetry.jsonl` — high-frequency engine logs (too noisy for DB)

### New Telemetry JSONL Schema

Each line in `telemetry.jsonl`:
```json
{
  "timestamp": "2026-03-22T14:30:00.123Z",
  "event": "opportunity_detected|trade_executed|trade_failed|circuit_breaker|price_update",
  "strategy": "triangular",
  "route": "SOL -> RAY -> USDC -> SOL",
  "expected_profit_pct": 0.34,
  "actual_profit_sol": 0.17,
  "tx_hash": "5Kj2...",
  "mode": "mainnet",
  "execution_time_ms": 142,
  "status": "success|failed|simulated",
  "error": null
}
```

The Next.js API routes that read `telemetry.jsonl` will be updated to handle this schema.

### New Prisma Model

```prisma
model Opportunity {
  id              String    @id @default(uuid())
  strategy        String    // TRIANGULAR, CEX_DEX, FLASH_LOAN, FUNDING_RATE, STATISTICAL
  route           String
  expectedProfit  Float
  tradeSize       Float
  status          String    // PENDING, APPROVED, REJECTED, EXPIRED, EXECUTED
  mode            String    // PAPER, DEVNET, MAINNET
  detectedAt      DateTime  @default(now())
  resolvedAt      DateTime?
  resolvedBy      String?   // "auto", "telegram", "dashboard"
  executionTxHash String?
  executionProfit Float?
  createdAt       DateTime  @default(now())
}
```

### Engine-to-DB Communication

Engine calls Next.js API via HTTP (not direct DB access). Prisma stays in Next.js only — avoids schema drift from two DB clients. Latency (~1-5ms local HTTP) is negligible for DB writes; the hot path doesn't touch the DB.

Flow:
1. Engine detects opportunity -> `POST /api/opportunities`
2. Sends Telegram alert
3. Approval comes in -> `PATCH /api/opportunities/:id`
4. Engine polls `GET /api/opportunities?status=APPROVED`
5. Executes, then `PATCH` with result

## Smart Contract Audit & Deployment

### Smart Contract Hardening

Before deployment, add these safety improvements to the vault program:

1. **Balance assertion in `process_arbitrage`:** Read vault USDC balance before borrow (stored in vault state as `pre_borrow_balance`), verify balance increased by at least borrow amount after repayment: `require!(vault_usdc.amount >= vault_state.pre_borrow_balance, VaultError::InsufficientRepayment)`.

2. **Borrow state tracking:** Add `is_borrowing: bool` and `borrow_amount: u64` fields to `VaultState`. Set in `borrow_for_arbitrage`, cleared in `process_arbitrage`. Prevents calling borrow twice without repaying.

3. **Replace `unwrap()` on checked arithmetic:** Convert all `checked_mul(...).unwrap()` to `checked_mul(...).ok_or(VaultError::MathOverflow)?` for clean error handling instead of panic.

### Audit Process

1. `anchor build` — verify clean compilation
2. `anchor test` — test suite for all 5 instructions (initialize, deposit, withdraw, borrow_for_arbitrage, process_arbitrage)
3. `anchor verify` — verify on-chain bytecode matches source
4. Manual review checklist:
   - Integer overflow/underflow in share calculations
   - PDA seed collisions
   - Missing signer/authority checks
   - Reentrancy on token transfers
   - Proper close account handling
   - Edge case: first deposit (total_shares == 0)
   - Edge case: withdraw all (vault empties)
   - Borrow/repay atomicity enforcement
   - Balance assertions on repayment

### Deployment

- **Devnet first:** `anchor deploy --provider.cluster devnet`. Record program ID, update configs. Run full integration test.
- **Mainnet after devnet proven:** `anchor deploy --provider.cluster mainnet-beta`. Engine config has both IDs, selects based on mode.
- **Upgrade authority:** Keep on separate cold wallet. Allows bug fixes without redeploying. Renounce later once battle-tested.

## Rust Module Structure

```
engine-worker/
├── Cargo.toml
├── engine.toml
├── Dockerfile
└── src/
    ├── main.rs                   # Entry point, spawn tasks, run loop
    ├── config/
    │   └── mod.rs                # Config loading (TOML + env), EngineMode enum
    ├── db/
    │   └── mod.rs                # Telemetry JSONL + HTTP client for Next.js API
    ├── kms/
    │   └── mod.rs                # Real AES-256-GCM decrypt, key rotation
    ├── price/
    │   ├── mod.rs                # PriceCache (Arc<RwLock>), broadcast channel
    │   ├── jupiter.rs            # Jupiter quote API polling
    │   └── cex.rs                # Bitget REST API polling
    ├── strategy/
    │   ├── mod.rs                # Strategy trait definition
    │   ├── triangular.rs         # Triangular DEX arb
    │   ├── flash_loan.rs         # Flash loan routing via vault borrow
    │   ├── cex_dex.rs            # CEX-DEX spread detection
    │   ├── funding_rate.rs       # Drift funding rate arb
    │   └── statistical.rs        # Pair trading + mean reversion
    ├── approval/
    │   ├── mod.rs                # Approval router (threshold + queue)
    │   ├── telegram.rs           # Telegram bot API
    │   └── http_server.rs        # Axum server for dashboard (port 3002)
    ├── executor/
    │   ├── mod.rs                # TX submission dispatcher
    │   ├── jito.rs               # Jito bundle building + tip + submission
    │   ├── simulator.rs          # Paper mode: simulateTransaction
    │   └── circuit_breaker.rs    # Loss tracking, halt logic
    └── types.rs                  # Shared types: Opportunity, TradeResult, Position
```

### New Dependencies

```toml
toml = "0.8"              # Config file parsing
axum = "0.7"              # HTTP server for dashboard API
tower-http = "0.5"        # CORS middleware
chrono = "0.4"            # Timestamps
hmac = "0.12"             # Bitget API auth
rust_decimal = "1.33"     # Precise decimal math (profit calcs, P&L)
anchor-client = "0.29"    # Anchor CPI for vault
tracing = "0.1"           # Structured logging
tracing-subscriber = "0.3" # Log output formatting (JSON for prod)
```

### Startup Sequence

1. Load config (engine.toml + env vars)
2. Initialize structured logger (tracing with JSON output)
3. KMS decrypt engine wallet
4. Connect to Solana RPC (with fallback URL list: primary -> secondary -> public)
5. Check if vault program exists on-chain — if missing, disable flash loan strategy with warning
6. Initialize PriceCache
7. Spawn tasks: price pollers, strategy detectors, approval router, Telegram poller, HTTP server, executor, circuit breaker monitor
8. Log "Engine started in {mode} mode"
9. Await all tasks (tokio::select! for graceful shutdown on SIGTERM)

### Rate Limiting & Backoff

- **Jupiter API:** On 429 response or timeout, exponential backoff (1s, 2s, 4s, max 30s). Mark prices as stale after 5s with no update. Strategies skip detection on stale prices.
- **Bitget API:** Respect documented rate limits. Backoff on 429. Mark CEX prices as stale after 10s. CEX-DEX strategy pauses when CEX feed is stale.
- **Solana RPC:** On timeout/error, try next RPC in fallback list. If all fail, pause execution and alert Telegram.
- **Telegram API:** Non-critical — log and skip on failure. Retry notifications next cycle.

## Infrastructure

- **Now:** Everything on Railway (fast iteration)
- **Later:** Split to Railway (Next.js dashboard) + dedicated server (Rust engine) for lower latency
- **Design is Docker-based** — deployment-agnostic, easy to migrate
- **Port 3002** (engine HTTP API) is internal-only — exposed within Docker network, proxied through Next.js `/api/engine` route. Never publicly accessible.
