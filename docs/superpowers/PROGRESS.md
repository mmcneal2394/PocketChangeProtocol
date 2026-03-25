# Engine Implementation Progress

**Date:** 2026-03-23
**Status:** All engine work complete (Layers 1-2 + Drift perp + infrastructure)

## Summary

- **65 unique tests passing** (57 unit + 8 integration), 0 failures
- Release build compiles
- All 5 strategies fully wired to real APIs, including Drift perp hedge for funding rate
- Drift instruction builder with PDA derivation, Borsh serialization, full perp order support
- PostgreSQL deployed on Railway, devnet contract live, Docker multi-stage build ready
- 7 PRs merged to main (#3–#9)

---

## Layer 1 — Engine Scaffold (PR #4)

24 tests, 25 tasks across 7 phases. Built the full engine architecture.

### Phase 1: Foundation & Cleanup (Tasks 1-4)

- [x] **Task 1:** Updated Cargo.toml with 13 new deps, deleted dead code (check_wallets.rs, sandbox.rs, aggregator.rs, pricing.rs), created engine.toml config
- [x] **Task 2:** Shared types module — EngineMode, StrategyKind, Opportunity, TradeResult, PriceSnapshot, ActivePosition, TelemetryEvent
- [x] **Task 3:** Config module rewrite — TOML loading, per-strategy thresholds, RPC fallback URLs, env var overlay
- [x] **Task 4:** KMS module — real AES-256-GCM encryption/decryption with key rotation support (3 tests)

### Phase 2: Core Infrastructure (Tasks 5-10)

- [x] **Task 5:** Module scaffolding — created price/, strategy/, approval/, executor/ directories with mod.rs files, Strategy trait + run_detector loop, FallbackRpcClient
- [x] **Task 6:** Engine refactor — stripped multi-tenant code from engine/mod.rs, kept VaultExecutor instruction builders
- [x] **Task 7:** Telemetry rewrite — new JSONL schema, TelemetryWriter, ApiClient for Next.js communication
- [x] **Task 8:** Jupiter price poller — polls 7 token mints at 500ms, exponential backoff, staleness tracking
- [x] **Task 9:** Bitget CEX poller — HMAC-SHA256 auth, polls tickers at 2s, backoff on failure
- [x] **Task 10:** Circuit breaker — 24h loss limit, single trade limit, consecutive failure detection, manual resume (5 tests)

### Phase 3: Execution Layer (Tasks 11-13)

- [x] **Task 11:** Jito bundle builder — wraps instructions + tip into signed transactions, submits to block engine (1 test)
- [x] **Task 12:** Paper mode simulator — RPC simulate_transaction with virtual balance tracking
- [x] **Task 13:** Executor dispatcher — routes to simulator (paper) or Jito (devnet/mainnet), records in circuit breaker + telemetry

### Phase 4: Approval Flow (Tasks 14-16)

- [x] **Task 14:** Approval router — threshold-based auto-execute, pending queue with expiry, atomic approve/reject
- [x] **Task 15:** Telegram bot — send opportunities, parse /approve_id /reject_id /resume commands, poll updates (4 tests)
- [x] **Task 16:** HTTP API server — Axum on port 3002, Bearer token auth, GET /api/status, GET /api/opportunities, POST approve/reject

### Phase 5: Atomic Strategies (Tasks 17-19)

- [x] **Task 17:** Smart contract hardening — borrow state tracking (is_borrowing, borrow_amount, pre_borrow_balance), balance assertions, VaultError enum, replaced all .unwrap() with error propagation (14 sites)
- [x] **Task 18:** Triangular DEX strategy — 5 predefined 3-hop routes, cross-rate profit calculation (8 tests)
- [x] **Task 19:** Flash loan strategy — vault borrow-swap-repay via VaultExecutor + Jupiter API (7 tests)

### Phase 6: Non-Atomic Strategies (Tasks 20-22)

- [x] **Task 20:** CEX-DEX strategy + CexExecutor — spread detection, Jupiter DEX leg, Bitget order execution with 3x retry (1 test)
- [x] **Task 21:** Funding rate strategy — Drift Protocol API, annualized profit normalization (3 tests)
- [x] **Task 22:** Statistical arb strategy — rolling z-score on SOL/JitoSOL and SOL/mSOL pairs, configurable window (7 tests)

### Phase 7: Integration (Tasks 23-25)

- [x] **Task 23:** Prisma migration — switched to PostgreSQL, added Opportunity model
- [x] **Task 24:** Next.js API routes — /api/opportunities CRUD, updated engine proxy with sub-path routing, backward-compatible logs parser
- [x] **Task 25:** main.rs orchestration — full startup sequence with JoinSet task spawning, conditional strategy enabling, Telegram command loop, graceful Ctrl+C shutdown

---

## Layer 2 — Real API Integrations (PR #5 + finish)

+24 tests (38 → 48 total). Wired all strategy build_instructions() to real APIs.

| Strategy | evaluate() | build_instructions() |
|----------|-----------|---------------------|
| Triangular | Real (cross-rate calc) | Real (Jupiter V6 swap-instructions, 3-leg chaining) |
| Flash Loan | Real (price discrepancy) | Real (VaultExecutor borrow → Jupiter swaps → repay) |
| CEX-DEX | Real (spread detection) | Real (Jupiter DEX leg + Bitget market orders) |
| Funding Rate | Real (Drift Protocol API) | Real (Jupiter spot leg; perp leg needs Drift SDK v2) |
| Statistical | Real (z-score on ratios) | Real (Jupiter pair trades: buy underperformer, sell outperformer) |

### Layer 2 commits:
- [x] Triangular: route parsing, mint resolution, 3-hop Jupiter swap instruction chaining
- [x] Flash loan: VaultExecutor integration, borrow/repay discriminators, Jupiter swap wrapping
- [x] CEX-DEX: Jupiter DEX leg + CexExecutor with Bitget place_market_order, get_order_status, execute_cex_leg with retry
- [x] Funding rate: Drift REST API funding rate fetch, spot leg via Jupiter, market/direction parsing
- [x] Statistical: pair trade instruction building, long/short leg via Jupiter, route direction parsing
- [x] Untracked engine-worker/target/ and Cargo.lock from git

---

## Devnet Deployment & Infrastructure

- [x] **Smart contract deployed to devnet** — Program ID: `34sgN4q5CaaGCwqePU6d2y6xzBuY5ASA8E8LtXjfyN3c`, cost: 2.44 SOL, binary: 342 KB
- [x] **All program ID references updated** across 9 files (contract, engine, frontend, scripts, docs)
- [x] **Dockerfile updated** — multi-stage build (builder + debian:bookworm-slim runtime), exposes port 3002
- [x] **Integration tests added** — 8 tests covering config, PriceCache, circuit breaker, telemetry, KMS, strategies, approval router paper mode
- [x] **lib.rs created** — re-exports all modules for integration test access

**Test counts:** 48 unit + 8 integration = 56 unique tests (104 total including lib re-run)

## Drift Protocol Integration (PR #8)

- [x] **Drift instruction builder** (`engine/drift.rs`) — PDA derivation, Borsh serialization, place_perp_order, cancel_order, initialize_user (6 tests)
- [x] **Funding rate perp leg** — full hedge: Jupiter spot + Drift perp in opposite direction, USDC-to-base-unit conversion (11 tests total)

## Infrastructure (PR #9)

- [x] **PostgreSQL on Railway** — deployed, schema synced via `prisma db push`
- [x] **Devnet contract deployed** — Program ID: `34sgN4q5CaaGCwqePU6d2y6xzBuY5ASA8E8LtXjfyN3c`
- [x] **Dockerfile** — multi-stage build, port 3002
- [x] **Integration tests** — 8 tests covering paper mode pipeline
- [x] **docker-compose.yml** — updated for new architecture (engine + web, Railway Postgres)
- [x] **.env.local** — generated with KMS key, engine secret, Railway DB URL

**Final test count:** 65 unique tests (57 unit + 8 integration), all passing

## Remaining Work

- [ ] Deploy smart contract to mainnet (needs real SOL + audit review)
- [ ] Fill in Telegram bot token and Bitget API keys in .env.local
- [ ] First paper mode test run (`cargo run` with engine.toml mode = "paper")
