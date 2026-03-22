# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PocketChange ($PCP) is a decentralized arbitrage protocol on Solana. It pools user capital and executes atomic arbitrage trades across DEXs and CEXs, returning 80% of profit to depositors and 20% to treasury. The operational/technical name is **ArbitraSaaS**.

## Architecture

This is a **multi-language monorepo** with three major runtime components:

1. **Next.js Web Dashboard** (`src/`) — TypeScript/React frontend + API routes. Uses App Router, MUI, Solana wallet adapter. Path alias: `@/*` → `./src/*`.
2. **Rust Engine Worker** (`engine-worker/`) — Tokio-based async arbitrage execution engine. Connects to Solana RPC, decrypts tenant wallets via AES-GCM KMS, writes trade telemetry to JSONL.
3. **Solana Smart Contract** (`programs/pocketchange_vault/`) — Anchor 0.29 vault program. Users deposit USDC, receive PCP shares proportional to vault deposits.

**Supporting pieces:**
- `src/strategies/` — Python arbitrage strategy classes (triangular, cross-DEX, funding rate, statistical). Evaluated off-chain, not part of the Next.js build.
- `optimized-jupiter-bot/` — Standalone Jupiter swap aggregator bot (TypeScript/CommonJS).
- `prisma/schema.prisma` — Database schema (SQLite provider). Models: User, Wallet, TradingConfig, TradeLog, ActivePosition.

### Data Flow

Engine writes telemetry to `telemetry.jsonl` (JSONL format). The Next.js API routes read this file directly via shared Docker volume. Multiple fallback paths are checked: `C:/tmp/engine-worker-clean/telemetry.jsonl` → `./engine-worker/telemetry.jsonl` → `./telemetry.jsonl`.

## Commands

```bash
# Next.js frontend
npm run dev          # Dev server on :3000
npm run build        # Production build
npm run start        # Serve production build
npm run lint         # ESLint

# Prisma
npx prisma generate  # Generate client from schema
npx prisma db push   # Push schema to database

# Rust engine (from engine-worker/)
cargo build --release
cargo run

# Docker (full stack: postgres + engine + web)
docker compose up --build
```

## Environment Variables

Required in `.env.local`:
- `SOLANA_RPC_URL` — Solana RPC endpoint (defaults to devnet)
- `DATABASE_URL` — PostgreSQL connection string
- `KMS_MASTER_KEY` — AES master key for wallet encryption/decryption
- `SOLANA_PRIVATE_KEY` — Engine wallet private key (Base58-encoded)

Optional:
- `NEXT_PUBLIC_NETWORK` — `"devnet"` or `"localnet"` (default)
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` — Distributed rate limiting (falls back to in-memory)

## Key Integrations

- **Jito** — MEV-protected bundle submission for atomic trade execution
- **Jupiter** (`@jup-ag/api`) — DEX aggregator for swap routing
- **CCXT** — CEX connectivity (Bitget, etc.) for cross-exchange arbitrage
- **Drift Labs SDK** — Perpetual futures
- **Helius** — Primary Solana RPC provider
- **Stripe** — Billing/subscriptions for tier management (FREE/PRO/ENTERPRISE)

## Middleware

`src/middleware.ts` applies to all `/api/*` routes:
- Rate limiting: 60 req/60s per IP (Upstash Redis with in-memory fallback)
- OFAC geofencing: blocks KP, IR, SY, CU, RU, SD, BY

## Anchor Program

Program ID: `FSRUKKMxfWNDiVKKVyxiaaweZR8HZEMnsyHmb8caPjAy`

The vault uses a PDA-based share system: `shares_to_mint = (amount × total_shares) / total_deposits`.

## Session Log (CRITICAL — read after compaction)

`SESSION_LOG.md` in the project root is a live changelog updated DURING sessions. **After context compaction, re-read this file** to recover what was already decided and built. Append to it after each significant change with: what changed, why (the intent), and any key decisions made.

This prevents overwriting features from earlier in the session after compaction erases the conversation history.

## Memory System

This project uses the Itachi Memory System for persistent context across Claude Code sessions.

### How It Works

- Session hooks fire automatically during Claude Code sessions (start, edit, prompt, end)
- A unified extractor (gpt-5.4) classifies every interaction and extracts lessons, personality signals, and facts
- Memories are stored in Supabase (pgvector) with confidence scoring and reinforcement learning
- A session watcher daemon monitors active coding sessions in real-time, sends Telegram alerts for stuck loops and relevant past lessons
- Context persists across sessions, machines, and time

### Memory Categories

All memories are stored in one of 4 categories:
- **lesson** — What worked, what didn't, rules, guardrails, patterns (with `metadata.source`: guardrail, user_feedback, rule, session_insight, observation)
- **identity** — Creator profile: communication style, preferences, decision patterns
- **conversation** — Chat history summaries
- **fact** — Project details, technical state, code changes

### Hooks

These fire automatically during Claude Code sessions:
- **session-start** — Searches memories, injects relevant briefing into context
- **after-edit** — Tracks file modifications, syncs .env/.md files to cloud
- **user-prompt-submit** — Differential memory refresh on each prompt (only changed blocks)
- **session-end** — Extracts structured summary, lessons, and insights from transcript (signal-keyword filtered)

### Confidence Model

Lessons start at confidence 0.6 and adjust aggressively:
- Success: +0.1 | Failure: ×0.5 | User correction: set to 0.1 | Explicit praise: +0.15
- Only lessons with confidence ≥ 0.5 are injected into session context
- Daily maintenance prunes dead lessons (< 0.2), promotes cross-project patterns

### Documentation

When making significant code changes, update any relevant documentation in the project (architecture docs, install guides, API docs, READMEs, etc.). Keep docs in sync with the code. Do NOT update todo.md or any TODO files — those are managed separately.

### Disable Memory

To disable memory for this project, create a file called `.no-memory` in the project root.
