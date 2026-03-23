# Session Log — PocketChangeProtocol

This file is updated DURING sessions after each significant change. It survives context compaction because it's on disk. After compaction, re-read this file to recover what was already decided.

**Format:** Each entry has a timestamp, what changed, and WHY (the intent behind it).

---

### 2026-03-22 — Engine Implementation (Layer 1 complete)

**What:** Implemented all 25 tasks of the engine plan across 7 phases. 24 tests passing, release build compiles. PR #4 merged to main.

**Modules built:** config (TOML), KMS (AES-256-GCM), price feeds (Jupiter+Bitget), circuit breaker, Jito bundle builder, paper simulator, executor dispatcher, approval router, Telegram bot, Axum HTTP API, 5 strategies (triangular, flash loan, CEX-DEX, funding rate, statistical), smart contract hardening, Prisma migration, Next.js API routes, main.rs orchestration.

**Key decisions:**
- Tokio channels for inter-module comms (no NATS for v1)
- Engine talks to DB via Next.js API (not direct SQL) to avoid schema drift
- Per-strategy auto-execute thresholds in config
- Strategy trait returns Vec<Instruction> (not Transaction) so executor adds Jito tips
- Vault verification is soft dependency — missing vault only disables flash loan
- Norton antivirus blocks Cargo builds — workaround: `incremental = false` in .cargo/config.toml

**Remaining (Layer 2):** Wire build_instructions() to real Jupiter API, integrate VaultExecutor into flash loan, implement Drift API, deploy contract, PostgreSQL, integration tests.

---
