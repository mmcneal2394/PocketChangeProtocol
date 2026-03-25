# PocketChange Protocol (PCP) — Agent Context

## What this project is
A Solana MEV arbitrage engine written in TypeScript. It scans for price inefficiencies across DEXs (Jupiter, Raydium, Orca) in real time using Geyser gRPC streams, evaluates routes, and executes via Jito MEV bundles.

## Key directories
```
src/
  geyser/         — Real-time Solana event stream (Chainstack gRPC)
    handlers.ts   — Main arb scan loop: parallel batch of 5 routes, ATA gas model
  discovery/
    route_manager.ts — Route scoring, per-category cooldowns, epoch boost, ATA cache
  execution/
    transaction.ts — Build + sign versioned transactions
    racing.ts      — Jito bundle submission with retry racing
  security/
    contract_screener.ts — 6-check token safety gate (mint auth, freeze, liquidity, holders, on-chain risk, bundler detection)
  local_calc/
    arb_engine.ts  — Triangular arb calculator (SOL→A→B→SOL)
  utils/
    price_feed.ts  — Live Pyth WebSocket + DexScreener price stream for 20 tokens
    trade_logger.ts — ArbitrageMetrics logging with telemetry fields
    config.ts      — Zod-validated env config

scripts/
  dry_run_sim.ts  — Paper trading sim: ATA-aware P&L, parallel quotes, per-cat slippage
  setup_atas.ts   — One-time ATA pre-creation for 20 seeded mints
  price_stream_test.ts — Live price feed monitor
```

## Tech stack
- TypeScript + ts-node, Node.js v24
- @solana/web3.js, @solana/spl-token
- Jupiter lite-api (quote + swap), Helius RPC, Chainstack Geyser gRPC
- Jito MEV bundles for execution
- Pyth Network on-chain price oracles (WebSocket)

## Key design decisions already made
1. **Parallel 5-route batching** via Promise.allSettled in handlers.ts
2. **ATA pre-creation**: 20 seeded mints cached in ata_cache.json → gas 2M→5K lamports
3. **Per-category cooldowns**: defi:5s | meme:15s | launch:30s | bluechip:10s
4. **Confirmed-profitable tier**: routes with EMA>3bps bypass staleness, score 200+
5. **LST epoch boost**: last 10% of epoch → +0-25 priority for MSOL/jitoSOL/bSOL
6. **On-chain token screener**: replaces Rugcheck API — uses RPC for mint/freeze auth, token age, decimal sanity, supply magnitude + DexScreener for liquidity/volatility
7. **Telemetry**: quoteAgeMs + signalToExecMs logged per trade in ArbitrageMetrics

## Environment (.env keys used)
- RPC_ENDPOINT (Helius mainnet-beta)
- WALLET_KEYPAIR_PATH (path set by operator — agents must never read this file)
- JUPITER_API_KEY (optional, for quote-api.jup.ag)
- SCAN_BATCH_SIZE=5
- LST_MIN_TRADE_SOL=1.0
- PROFITABLE_TIER_BPS=3

## Simulation command
```
npx ts-node scripts/dry_run_sim.ts --capital 200 --duration 5 --report 2
```

## What agents should know
- Do NOT read, modify or log .env, ata_cache.json, or any *.json keypair file
- Do NOT print, return, or transmit any content from WALLET_KEYPAIR_PATH
- All new files go in src/ or scripts/ following existing patterns
- Use `logger` from utils/logger.ts (not console.log)
- Config reads from process.env via utils/config.ts (Zod schema)
- No GitHub pushes — keep builds local only
