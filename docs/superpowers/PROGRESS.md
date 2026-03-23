# Engine Implementation Progress

**Branch:** `engine-impl`
**Date:** 2026-03-22
**Status:** All 25 tasks complete

## Summary

- 24 unit tests passing
- Release build compiles (3m09s)
- 17 commits across 7 phases

## Phase 1: Foundation & Cleanup (Tasks 1-4)

- [x] **Task 1:** Updated Cargo.toml with 13 new deps, deleted dead code (check_wallets.rs, sandbox.rs, aggregator.rs, pricing.rs), created engine.toml config
- [x] **Task 2:** Shared types module — EngineMode, StrategyKind, Opportunity, TradeResult, PriceSnapshot, ActivePosition, TelemetryEvent
- [x] **Task 3:** Config module rewrite — TOML loading, per-strategy thresholds, RPC fallback URLs, env var overlay
- [x] **Task 4:** KMS module — real AES-256-GCM encryption/decryption with key rotation support (3 tests)

## Phase 2: Core Infrastructure (Tasks 5-10)

- [x] **Task 5:** Module scaffolding — created price/, strategy/, approval/, executor/ directories with mod.rs files, Strategy trait + run_detector loop, FallbackRpcClient
- [x] **Task 6:** Engine refactor — stripped multi-tenant code from engine/mod.rs, kept VaultExecutor instruction builders
- [x] **Task 7:** Telemetry rewrite — new JSONL schema, TelemetryWriter, ApiClient for Next.js communication
- [x] **Task 8:** Jupiter price poller — polls 7 token mints at 500ms, exponential backoff, staleness tracking
- [x] **Task 9:** Bitget CEX poller — HMAC-SHA256 auth, polls tickers at 2s, backoff on failure
- [x] **Task 10:** Circuit breaker — 24h loss limit, single trade limit, consecutive failure detection, manual resume (5 tests)

## Phase 3: Execution Layer (Tasks 11-13)

- [x] **Task 11:** Jito bundle builder — wraps instructions + tip into signed transactions, submits to block engine (1 test)
- [x] **Task 12:** Paper mode simulator — RPC simulate_transaction with virtual balance tracking
- [x] **Task 13:** Executor dispatcher — routes to simulator (paper) or Jito (devnet/mainnet), records in circuit breaker + telemetry

## Phase 4: Approval Flow (Tasks 14-16)

- [x] **Task 14:** Approval router — threshold-based auto-execute, pending queue with expiry, atomic approve/reject
- [x] **Task 15:** Telegram bot — send opportunities, parse /approve_id /reject_id /resume commands, poll updates (4 tests)
- [x] **Task 16:** HTTP API server — Axum on port 3002, Bearer token auth, GET /api/status, GET /api/opportunities, POST approve/reject

## Phase 5: Atomic Strategies (Tasks 17-19)

- [x] **Task 17:** Smart contract hardening — borrow state tracking (is_borrowing, borrow_amount, pre_borrow_balance), balance assertions, VaultError enum, replaced all .unwrap() with error propagation (14 sites)
- [x] **Task 18:** Triangular DEX strategy — 5 predefined 3-hop routes, cross-rate profit calculation (2 tests)
- [x] **Task 19:** Flash loan strategy — vault borrow-swap-repay, disabled when vault unavailable (2 tests)

## Phase 6: Non-Atomic Strategies (Tasks 20-22)

- [x] **Task 20:** CEX-DEX strategy + CexDexPosition — spread detection, one-position-at-a-time enforcement, settlement lifecycle (1 test)
- [x] **Task 21:** Funding rate strategy — Drift Protocol stub, annualized profit normalization
- [x] **Task 22:** Statistical arb strategy — rolling z-score on SOL/JitoSOL and SOL/mSOL pairs, configurable window (2 tests)

## Phase 7: Integration (Tasks 23-25)

- [x] **Task 23:** Prisma migration — switched to PostgreSQL, added Opportunity model
- [x] **Task 24:** Next.js API routes — /api/opportunities CRUD, updated engine proxy with sub-path routing, backward-compatible logs parser
- [x] **Task 25:** main.rs orchestration — full startup sequence with JoinSet task spawning, conditional strategy enabling, Telegram command loop, graceful Ctrl+C shutdown

## Remaining Work (not in this PR)

- Wire `build_instructions()` to real Jupiter V6 swap-instructions API (currently returns empty vec)
- Integrate VaultExecutor.build_vault_ptb() into flash loan strategy's build_instructions
- Implement Drift Protocol API calls in funding rate strategy
- Deploy smart contract to devnet and mainnet
- Run with real PostgreSQL (currently in-memory store for opportunities API)
- Integration test: full pipeline from price feed to telemetry output
