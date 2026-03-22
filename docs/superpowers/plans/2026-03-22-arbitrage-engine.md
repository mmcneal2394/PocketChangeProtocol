# Arbitrage Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the scaffolded Rust engine into a tri-mode arbitrage system with 5 strategies, approval flow, and production safety controls.

**Architecture:** Single Rust binary with Tokio async runtime. Modules communicate via mpsc/broadcast channels. Strategies run as independent tasks. Engine exposes Axum HTTP API for dashboard integration. Telemetry dual-writes to JSONL and Next.js API.

**Tech Stack:** Rust (tokio, axum, solana-sdk, reqwest, aes-gcm, rust_decimal, tracing), Anchor 0.29, Next.js (Prisma/PostgreSQL), Jito block engine API.

**Spec:** `docs/superpowers/specs/2026-03-22-arbitrage-engine-design.md`

---

## File Map

### New Files
- `engine-worker/engine.toml` — Runtime configuration
- `engine-worker/src/types.rs` — Shared types (Opportunity, TradeResult, Position, PriceSnapshot)
- `engine-worker/src/rpc.rs` — RPC client with fallback URL list
- `engine-worker/src/strategy/mod.rs` — Strategy trait + detector loop (Phase 2)
- `engine-worker/src/executor/mod.rs` — TX submission dispatcher (Phase 2 skeleton)
- `engine-worker/src/executor/cex_executor.rs` — Bitget order placement, retry, stuck-position recovery
- `engine-worker/src/price/mod.rs` — PriceCache + broadcast channel
- `engine-worker/src/price/jupiter.rs` — Jupiter quote API poller
- `engine-worker/src/price/cex.rs` — Bitget REST API poller
- `engine-worker/src/strategy/mod.rs` — Strategy trait + detector loop
- `engine-worker/src/strategy/triangular.rs` — Triangular DEX arb
- `engine-worker/src/strategy/flash_loan.rs` — Flash loan routing
- `engine-worker/src/strategy/cex_dex.rs` — CEX-DEX spread arb
- `engine-worker/src/strategy/funding_rate.rs` — Drift funding rate
- `engine-worker/src/strategy/statistical.rs` — Statistical pair trading
- `engine-worker/src/approval/mod.rs` — Approval router + queue
- `engine-worker/src/approval/telegram.rs` — Telegram bot client
- `engine-worker/src/approval/http_server.rs` — Axum HTTP API (port 3002)
- `engine-worker/src/executor/mod.rs` — TX submission dispatcher
- `engine-worker/src/executor/jito.rs` — Jito bundle builder + submission
- `engine-worker/src/executor/simulator.rs` — Paper mode simulator
- `engine-worker/src/executor/circuit_breaker.rs` — Loss tracking + halt logic
- `src/app/api/opportunities/route.ts` — Next.js API for opportunity CRUD

### Modified Files
- `engine-worker/Cargo.toml` — Add new dependencies
- `engine-worker/src/main.rs` — Rewrite startup sequence
- `engine-worker/src/config/mod.rs` — Rewrite for TOML + env vars
- `engine-worker/src/db/mod.rs` — Extend with HTTP client + new JSONL schema
- `engine-worker/src/kms/mod.rs` — Implement real decryption + key rotation
- `engine-worker/src/engine/mod.rs` — Refactor VaultExecutor, remove tenant refs
- `engine-worker/src/engine/providers.rs` — Clean up, keep Jupiter/OpenOcean
- `prisma/schema.prisma` — Switch to PostgreSQL, add Opportunity model
- `src/app/api/engine/route.ts` — Extend proxy for new endpoints
- `src/app/api/logs/route.ts` — Update for new telemetry schema
- `programs/pocketchange_vault/src/lib.rs` — Smart contract hardening

### Removed Files
- `engine-worker/src/check_wallets.rs` — Dead code
- `engine-worker/src/engine/sandbox.rs` — Replaced by executor/simulator.rs
- `engine-worker/src/engine/aggregator.rs` — Subsumed into price/mod.rs pattern
- `engine-worker/src/engine/pricing.rs` — Logic moves into strategy modules

---

## Phase 1: Foundation & Cleanup

### Task 1: Clean Scaffold & Update Dependencies

**Files:**
- Modify: `engine-worker/Cargo.toml`
- Delete: `engine-worker/src/check_wallets.rs`
- Create: `engine-worker/engine.toml`

- [ ] **Step 1: Update Cargo.toml with new dependencies**

Add to `[dependencies]`:
```toml
toml = "0.8"
axum = { version = "0.7", features = ["json"] }
tower-http = { version = "0.5", features = ["cors"] }
chrono = { version = "0.4", features = ["serde"] }
hmac = "0.12"
sha2 = "0.10"
rust_decimal = { version = "1.33", features = ["serde-with-str"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["json", "env-filter"] }
async-trait = "0.1"
uuid = { version = "1", features = ["v4"] }
anchor-client = "0.29"
```

Remove the existing standalone `sha2 = "0.10.8"` line (now included with hmac).

- [ ] **Step 2: Delete dead code and superseded modules**

Remove these files:
- `engine-worker/src/check_wallets.rs` — dead code referencing external path
- `engine-worker/src/engine/sandbox.rs` — replaced by `executor/simulator.rs`
- `engine-worker/src/engine/aggregator.rs` — subsumed into `price/` module pattern
- `engine-worker/src/engine/pricing.rs` — logic moves into strategy modules

Update `engine-worker/src/engine/mod.rs`: remove `mod sandbox;`, `mod aggregator;`, `mod pricing;` declarations. Keep `VaultExecutor`, `build_vault_ptb()`, `get_discriminator()`, and `fetch_jupiter_instructions()`.

- [ ] **Step 3: Create engine.toml config file**

```toml
mode = "paper"
jito_endpoint = "https://mainnet.block-engine.jito.wtf"
auto_execute_threshold_default = 0.5
approval_timeout_secs = 300
max_loss_24h = 50.0
max_trade_size = 10.0
max_cex_exposure_secs = 300

# RPC fallback list (primary first, tried in order)
rpc_fallback_urls = ["https://mainnet.helius-rpc.com/?api-key=...", "https://api.mainnet-beta.solana.com"]

[strategy.triangular]
auto_execute_threshold = 0.3
enabled = true

[strategy.cex_dex]
auto_execute_threshold = 1.0
enabled = true

[strategy.flash_loan]
auto_execute_threshold = 0.3
enabled = true

[strategy.funding_rate]
auto_execute_threshold = 0.08
enabled = false

[strategy.statistical]
auto_execute_threshold = 2.0
enabled = false
```

- [ ] **Step 4: Verify project compiles**

Run: `cd engine-worker && cargo check`
Expected: Compilation succeeds (warnings OK for now)

- [ ] **Step 5: Commit**

```bash
git add engine-worker/Cargo.toml engine-worker/engine.toml
git add -u engine-worker/src/check_wallets.rs
git commit -m "chore: update engine deps, remove dead code, add engine.toml config"
```

---

### Task 2: Shared Types Module

**Files:**
- Create: `engine-worker/src/types.rs`

- [ ] **Step 1: Write types.rs with all shared types**

Define these types (all `#[derive(Debug, Clone, Serialize, Deserialize)]`):

```rust
use rust_decimal::Decimal;
use solana_sdk::instruction::Instruction;
use solana_sdk::signature::Keypair;
use std::time::Instant;

/// Engine operating mode
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineMode { Paper, Devnet, Mainnet }

/// Strategy identifier
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StrategyKind { Triangular, CexDex, FlashLoan, FundingRate, Statistical }

/// A detected arbitrage opportunity
pub struct Opportunity {
    pub id: String,                    // UUID
    pub strategy: StrategyKind,
    pub route: String,                 // Human-readable route description
    pub expected_profit_pct: Decimal,  // Normalized profit percentage
    pub trade_size_usdc: Decimal,
    #[serde(skip)]                     // Instruction is not Serialize
    pub instructions: Vec<Instruction>,
    #[serde(skip)]
    pub detected_at: Instant,
}

/// Result of executing an opportunity
pub struct TradeResult {
    pub opportunity_id: String,
    pub success: bool,
    pub tx_hash: Option<String>,
    pub actual_profit_sol: Option<Decimal>,
    pub execution_time_ms: u64,
    pub error: Option<String>,
}

/// Price snapshot from a feed
pub struct PriceSnapshot {
    pub mint: String,
    pub price_usdc: f64,
    pub source: String,          // "jupiter" or "bitget"
    pub timestamp: Instant,
}

/// Approval status for the approval queue
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalStatus { Pending, Approved, Rejected, Expired, Executed }

/// Active held position (for funding_rate and statistical strategies)
pub struct ActivePosition {
    pub id: String,
    pub strategy: StrategyKind,
    pub pair: String,
    pub status: PositionStatus,
    pub entry_price: Decimal,
    pub size_sol: Decimal,
    pub target_price: Option<Decimal>,
    pub stop_loss: Option<Decimal>,
    pub opened_at: Instant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PositionStatus { Open, Closing, Closed }

/// Telemetry event written to JSONL
pub struct TelemetryEvent {
    pub timestamp: String,        // ISO 8601
    pub event: String,            // opportunity_detected, trade_executed, etc.
    pub strategy: String,
    pub route: String,
    pub expected_profit_pct: f64,
    pub actual_profit_sol: Option<f64>,
    pub tx_hash: Option<String>,
    pub mode: String,
    pub execution_time_ms: Option<u64>,
    pub status: String,           // success, failed, simulated
    pub error: Option<String>,
}
```

- [ ] **Step 2: Add `mod types;` to main.rs**

Add `mod types;` at the top of `engine-worker/src/main.rs` (alongside existing module declarations).

- [ ] **Step 3: Verify compilation**

Run: `cd engine-worker && cargo check`

- [ ] **Step 4: Commit**

```bash
git add engine-worker/src/types.rs engine-worker/src/main.rs
git commit -m "feat(engine): add shared types module with Opportunity, TradeResult, TelemetryEvent"
```

---

### Task 3: Config Module Rewrite

**Files:**
- Modify: `engine-worker/src/config/mod.rs`

- [ ] **Step 1: Write failing test for config loading**

Add `#[cfg(test)]` module at the bottom of `config/mod.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_config_from_toml_string() {
        let toml_str = r#"
            mode = "paper"
            jito_endpoint = "https://test.jito.wtf"
            auto_execute_threshold_default = 0.5
            approval_timeout_secs = 300
            max_loss_24h = 50.0
            max_trade_size = 10.0

            [strategy.triangular]
            auto_execute_threshold = 0.3
            enabled = true
        "#;
        let config: EngineConfig = toml::from_str(toml_str).unwrap();
        assert_eq!(config.mode, EngineMode::Paper);
        assert_eq!(config.max_trade_size, 10.0);
        assert!(config.strategy.get("triangular").unwrap().enabled);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd engine-worker && cargo test config::tests::test_load_config_from_toml_string`
Expected: FAIL (EngineConfig not defined)

- [ ] **Step 3: Implement EngineConfig**

Rewrite `config/mod.rs` with:
- `EngineConfig` struct (mode, jito_endpoint, thresholds, strategy map)
- `StrategyConfig` struct (auto_execute_threshold, enabled)
- `EngineConfig::load()` — reads `engine.toml`, overlays env vars for secrets
- `EngineConfig::get_strategy_threshold()` — returns per-strategy or default threshold
- Remove all `TenantConfig`, `StrategyTarget`, `ConfigManager` structs

- [ ] **Step 4: Run test to verify it passes**

Run: `cd engine-worker && cargo test config::tests`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add engine-worker/src/config/mod.rs
git commit -m "feat(engine): rewrite config module for TOML + env var loading"
```

---

### Task 4: KMS Module — Real Decryption

**Files:**
- Modify: `engine-worker/src/kms/mod.rs`

- [ ] **Step 1: Write test for encrypt/decrypt round-trip**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let master_key = [0u8; 32]; // Test key
        let kms = KMSClient::from_key(&master_key);
        let secret = b"my_private_key_bytes";
        let encrypted = kms.encrypt(secret).unwrap();
        let decrypted = kms.decrypt(&encrypted).unwrap();
        assert_eq!(decrypted, secret);
    }

    #[test]
    fn test_key_rotation() {
        let old_key = [1u8; 32];
        let new_key = [2u8; 32];
        let old_kms = KMSClient::from_key(&old_key);
        let secret = b"my_private_key_bytes";
        let encrypted = old_kms.encrypt(secret).unwrap();

        // New key fails, falls back to old key
        let new_kms = KMSClient::from_key(&new_key);
        assert!(new_kms.decrypt(&encrypted).is_err());

        let rotator = KMSClient::with_rotation(&new_key, Some(&old_key));
        let decrypted = rotator.decrypt_with_rotation(&encrypted).unwrap();
        assert_eq!(decrypted, secret);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd engine-worker && cargo test kms::tests`

- [ ] **Step 3: Implement real KMS encryption/decryption**

Rewrite `kms/mod.rs`:
- `KMSClient::from_key(key: &[u8; 32])` — initialize AES-256-GCM cipher
- `KMSClient::from_env()` — reads `KMS_MASTER_KEY` (hex-encoded), optionally `KMS_MASTER_KEY_PREVIOUS`
- `encrypt(plaintext: &[u8]) -> Result<EncryptedPayload>` — generate random nonce, encrypt, return nonce + ciphertext
- `decrypt(payload: &EncryptedPayload) -> Result<Vec<u8>>` — AES-GCM decrypt
- `decrypt_with_rotation(payload: &EncryptedPayload) -> Result<Vec<u8>>` — try current key, fall back to previous
- `EncryptedPayload` struct: nonce (12 bytes), ciphertext (variable)
- Remove hardcoded keypair, remove `decrypt_tenant_key` stub

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd engine-worker && cargo test kms::tests`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add engine-worker/src/kms/mod.rs
git commit -m "feat(engine): implement real AES-256-GCM encryption with key rotation"
```

---

## Phase 2: Core Infrastructure

### Task 5: Module Directory Scaffolding + Strategy Trait

**Files:**
- Create: `engine-worker/src/price/mod.rs` (skeleton)
- Create: `engine-worker/src/strategy/mod.rs` (Strategy trait + run_detector)
- Create: `engine-worker/src/approval/mod.rs` (skeleton)
- Create: `engine-worker/src/executor/mod.rs` (skeleton)
- Create: `engine-worker/src/rpc.rs` (RPC with fallback)
- Modify: `engine-worker/src/main.rs` (add mod declarations)

The Strategy trait and `run_detector` loop are needed by Phase 3-4 (executor and approval router). Module skeletons are needed so Rust can resolve sub-module imports.

- [ ] **Step 1: Create Strategy trait in strategy/mod.rs**

```rust
use async_trait::async_trait;
use rust_decimal::Decimal;
use solana_sdk::instruction::Instruction;
use solana_sdk::signature::Keypair;
use crate::types::*;

pub mod triangular;
pub mod flash_loan;
pub mod cex_dex;
pub mod funding_rate;
pub mod statistical;

#[async_trait]
pub trait Strategy: Send + Sync {
    fn name(&self) -> &str;
    fn kind(&self) -> StrategyKind;
    async fn evaluate(&self, prices: &crate::price::PriceCache) -> Vec<Opportunity>;
    fn build_instructions(&self, opp: &Opportunity, wallet: &Keypair) -> anyhow::Result<Vec<Instruction>>;
    fn min_profit_threshold(&self) -> Decimal;
    fn normalized_profit_pct(&self, opp: &Opportunity) -> Decimal;
}

/// Generic detector loop — one per strategy. Subscribes to price updates,
/// calls evaluate(), forwards opportunities to the approval router.
pub async fn run_detector(
    strategy: Arc<dyn Strategy>,
    mut price_rx: broadcast::Receiver<PriceSnapshot>,
    opportunity_tx: mpsc::Sender<Opportunity>,
    price_cache: Arc<RwLock<PriceCache>>,
) {
    loop {
        // Wait for a price update
        let _ = price_rx.recv().await;
        let cache = price_cache.read().await;
        let opps = strategy.evaluate(&cache).await;
        drop(cache);
        for opp in opps {
            let _ = opportunity_tx.send(opp).await;
        }
    }
}
```

- [ ] **Step 2: Create skeleton mod.rs for price, approval, executor**

Each skeleton just declares its sub-modules (empty files are fine — we fill them in later tasks):

`price/mod.rs`: `pub mod jupiter; pub mod cex;` + PriceCache struct placeholder
`approval/mod.rs`: `pub mod telegram; pub mod http_server;` + placeholder structs
`executor/mod.rs`: `pub mod jito; pub mod simulator; pub mod circuit_breaker; pub mod cex_executor;` + placeholder

Create empty placeholder files for all sub-modules so `cargo check` passes.

- [ ] **Step 3: Create rpc.rs with fallback RPC client**

```rust
use solana_client::rpc_client::RpcClient;

pub struct FallbackRpcClient {
    clients: Vec<RpcClient>,
    current: usize,
}

impl FallbackRpcClient {
    pub fn new(urls: Vec<String>) -> Self { /* init clients */ }
    pub fn get(&self) -> &RpcClient { &self.clients[self.current] }
    pub fn rotate(&mut self) { self.current = (self.current + 1) % self.clients.len(); }
    // Wraps common RPC calls with automatic failover on timeout/error
    pub async fn send_transaction_with_failover(&mut self, tx: &Transaction) -> Result<Signature> { /* try current, rotate on failure */ }
}
```

- [ ] **Step 4: Add all module declarations to main.rs**

```rust
mod config;
mod db;
mod kms;
mod types;
mod rpc;
mod price;
mod strategy;
mod approval;
mod executor;
mod engine; // kept for VaultExecutor instruction builders
```

- [ ] **Step 5: Verify compilation**

Run: `cd engine-worker && cargo check`
Expected: Compiles (warnings OK for unused code in skeletons)

- [ ] **Step 6: Commit**

```bash
git add engine-worker/src/strategy/ engine-worker/src/price/ engine-worker/src/approval/ engine-worker/src/executor/ engine-worker/src/rpc.rs engine-worker/src/main.rs
git commit -m "feat(engine): add module scaffolding, Strategy trait, and RPC fallback client"
```

---

### Task 6: Refactor engine/mod.rs — Strip Multi-Tenant Code

**Files:**
- Modify: `engine-worker/src/engine/mod.rs`
- Modify: `engine-worker/src/engine/providers.rs`

Before implementing strategies, clean up the existing engine module so reusable code is accessible.

- [ ] **Step 1: Read and understand existing VaultExecutor**

Read `engine-worker/src/engine/mod.rs` (265 lines). Key functions to KEEP:
- `get_discriminator(name: &str) -> [u8; 8]` — SHA256-based Anchor instruction discriminator
- `VaultExecutor::build_vault_ptb(borrow_amount, swap_ixs) -> Vec<Instruction>` — assembles borrow → swaps → process_arbitrage
- `VaultExecutor::fetch_jupiter_instructions(quote) -> Vec<Instruction>` — calls Jupiter V6 swap-instructions API

Functions to REMOVE:
- `VaultExecutor::process_loop()` — old polling loop with hardcoded mints and NATS
- `VaultExecutor::fetch_jupiter_swap()` — mocked quote generator
- All `tenant_id` parameters and logging
- `SandboxManager` references
- Hardcoded RPC URL (`https://api.devnet.solana.com`)

- [ ] **Step 2: Refactor engine/mod.rs**

Strip the functions listed above. Make `build_vault_ptb` and `get_discriminator` public. Remove `mod sandbox; mod aggregator; mod pricing;` declarations. Keep `mod providers;`.

- [ ] **Step 3: Clean up providers.rs**

Remove tenant references from `JupiterProvider` and `OpenOceanProvider`. Keep the HTTP call logic — it will be reused by the price feed and strategy modules.

- [ ] **Step 4: Verify compilation**

Run: `cd engine-worker && cargo check`

- [ ] **Step 5: Commit**

```bash
git add engine-worker/src/engine/
git commit -m "refactor(engine): strip multi-tenant code, keep VaultExecutor instruction builders"
```

---

### Task 7: Telemetry & DB Module

**Files:**
- Modify: `engine-worker/src/db/mod.rs`

- [ ] **Step 1: Rewrite db/mod.rs**

Keep the JSONL appending logic. Add:
- `TelemetryWriter::write_event(event: &TelemetryEvent)` — writes new schema JSONL
- `ApiClient` struct wrapping `reqwest::Client` with base URL and auth token
- `ApiClient::post_opportunity(opp)` / `patch_opportunity(id, status)` / `get_approved_opportunities()` — HTTP calls to Next.js API
- Remove `tenant_id` from `TradeLogEvent`
- All `ApiClient` methods handle errors gracefully (log + continue, never panic)

- [ ] **Step 2: Write test for JSONL serialization**

```rust
#[test]
fn test_telemetry_event_serialization() {
    let event = TelemetryEvent { /* ... */ };
    let json = serde_json::to_string(&event).unwrap();
    assert!(json.contains("\"event\":"));
    assert!(json.contains("\"strategy\":"));
}
```

- [ ] **Step 3: Verify tests pass**

Run: `cd engine-worker && cargo test db::tests`

- [ ] **Step 4: Commit**

```bash
git add engine-worker/src/db/mod.rs
git commit -m "feat(engine): extend telemetry with new JSONL schema + API client"
```

---

### Task 8: Price Feeds — PriceCache + Jupiter Poller

**Files:**
- Create: `engine-worker/src/price/mod.rs`
- Create: `engine-worker/src/price/jupiter.rs`

- [ ] **Step 1: Implement PriceCache**

In `price/mod.rs`:
```rust
pub struct PriceCache {
    prices: HashMap<String, PriceEntry>,  // mint -> latest price
}

pub struct PriceEntry {
    pub price_usdc: f64,
    pub source: String,
    pub updated_at: Instant,
    pub stale: bool,  // true if >5s since last update
}

impl PriceCache {
    pub fn update(&mut self, snapshot: PriceSnapshot) { /* ... */ }
    pub fn get(&self, mint: &str) -> Option<&PriceEntry> { /* ... */ }
    pub fn mark_stale(&mut self, source: &str, threshold: Duration) { /* ... */ }
    pub fn is_fresh(&self, mint: &str) -> bool { /* ... */ }
}
```

Wrap as `Arc<RwLock<PriceCache>>`. Create `tokio::sync::broadcast` channel for price update notifications.

- [ ] **Step 2: Implement Jupiter poller**

In `price/jupiter.rs`:
- `JupiterPoller::new(cache: Arc<RwLock<PriceCache>>, tx: broadcast::Sender<PriceSnapshot>)`
- `run(interval_ms: u64)` — loops: fetch quotes for configured mints, update cache, broadcast. On 429/error: exponential backoff (1s, 2s, 4s, max 30s). Mark stale after 5s.
- Uses real Jupiter V6 API: `GET https://public.jupiterapi.com/quote?inputMint=...&outputMint=...&amount=...`
- Configure mint list: SOL, USDC, RAY, BONK, JitoSOL, mSOL, WIF

- [ ] **Step 3: Write test for PriceCache staleness**

```rust
#[test]
fn test_price_cache_staleness() {
    let mut cache = PriceCache::new();
    cache.update(PriceSnapshot { mint: "SOL".into(), price_usdc: 150.0, source: "jupiter".into(), timestamp: Instant::now() });
    assert!(cache.is_fresh("SOL"));
    // Simulate staleness by checking threshold
    cache.mark_stale("jupiter", Duration::from_secs(0)); // force stale
    assert!(!cache.is_fresh("SOL"));
}
```

- [ ] **Step 4: Verify tests pass, commit**

Run: `cd engine-worker && cargo test price::tests`

```bash
git add engine-worker/src/price/
git commit -m "feat(engine): add PriceCache with Jupiter poller and staleness tracking"
```

---

### Task 9: Price Feeds — CEX (Bitget) Poller

**Files:**
- Create: `engine-worker/src/price/cex.rs`

- [ ] **Step 1: Implement Bitget REST poller**

- `BitgetPoller::new(cache, tx, api_key, api_secret, passphrase)`
- HMAC-SHA256 signature for authenticated endpoints
- `run(interval_ms: u64)` — polls `GET /api/v2/spot/market/tickers` for configured pairs
- Same backoff/staleness pattern as Jupiter (10s stale threshold for CEX)
- Parse Bitget response: `{ "data": [{ "symbol": "SOLUSDT", "lastPr": "150.23" }] }`

- [ ] **Step 2: Write test for Bitget signature generation**

```rust
#[test]
fn test_bitget_hmac_signature() {
    let sig = BitgetPoller::sign("1234567890", "GET", "/api/v2/spot/market/tickers", "", "test_secret");
    assert!(!sig.is_empty());
    // Verify it's valid base64
    base64::decode(&sig).unwrap();
}
```

- [ ] **Step 3: Verify tests pass, commit**

```bash
git add engine-worker/src/price/cex.rs
git commit -m "feat(engine): add Bitget CEX price poller with HMAC auth"
```

---

### Task 10: Circuit Breaker

**Files:**
- Create: `engine-worker/src/executor/circuit_breaker.rs`

- [ ] **Step 1: Write tests for circuit breaker triggers**

```rust
#[test]
fn test_circuit_breaker_24h_loss_limit() {
    let mut cb = CircuitBreaker::new(Decimal::new(50, 0), Decimal::new(20, 0));
    cb.record_trade(Decimal::new(-30, 0)); // -30 SOL
    assert!(!cb.is_tripped());
    cb.record_trade(Decimal::new(-25, 0)); // -25 SOL, total -55
    assert!(cb.is_tripped());
    assert_eq!(cb.trip_reason(), Some("24h loss limit exceeded: -55 SOL > 50 SOL"));
}

#[test]
fn test_circuit_breaker_consecutive_failures() {
    let mut cb = CircuitBreaker::new(Decimal::new(50, 0), Decimal::new(20, 0));
    for _ in 0..5 {
        cb.record_failure();
    }
    assert!(cb.is_tripped());
}

#[test]
fn test_circuit_breaker_manual_resume() {
    let mut cb = CircuitBreaker::new(Decimal::new(50, 0), Decimal::new(20, 0));
    for _ in 0..5 { cb.record_failure(); }
    assert!(cb.is_tripped());
    cb.resume();
    assert!(!cb.is_tripped());
}
```

- [ ] **Step 2: Implement CircuitBreaker**

```rust
pub struct CircuitBreaker {
    max_loss_24h: Decimal,
    max_single_trade: Decimal,
    trades_24h: Vec<(Instant, Decimal)>,
    consecutive_failures: u32,
    tripped: bool,
    trip_reason: Option<String>,
    pause_until: Option<Instant>,
}
```

Methods: `record_trade()`, `record_failure()`, `record_success()`, `is_tripped()`, `trip_reason()`, `resume()`, `cleanup_old_trades()` (evicts >24h entries).

- [ ] **Step 3: Verify tests pass, commit**

```bash
git add engine-worker/src/executor/circuit_breaker.rs
git commit -m "feat(engine): add circuit breaker with 24h loss limit and failure tracking"
```

---

## Phase 3: Execution Layer

### Task 11: Jito Bundle Builder

**Files:**
- Create: `engine-worker/src/executor/jito.rs`

- [ ] **Step 1: Implement Jito bundle submission**

- `JitoClient::new(endpoint: String)`
- `build_bundle(instructions: Vec<Instruction>, tip_lamports: u64, payer: &Keypair) -> Vec<Transaction>` — wraps instructions into transaction(s), appends tip transfer to Jito tip program
- `submit_bundle(bundle: Vec<Transaction>) -> Result<String>` — POST to `{endpoint}/api/v1/bundles` with base64-encoded transactions
- `get_bundle_status(bundle_id: &str) -> Result<BundleStatus>` — poll for confirmation
- Jito tip program: `T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt`
- Tip destination: randomly select from Jito tip accounts list

- [ ] **Step 2: Write test for bundle construction**

```rust
#[test]
fn test_bundle_includes_tip_instruction() {
    let keypair = Keypair::new();
    let swap_ix = system_instruction::transfer(&keypair.pubkey(), &keypair.pubkey(), 1000);
    let client = JitoClient::new("https://test.jito.wtf".into());
    let bundle = client.build_bundle(vec![swap_ix], 10000, &keypair);
    // Last instruction should be a tip transfer
    let last_tx = bundle.last().unwrap();
    assert!(last_tx.message.instructions.len() >= 2); // swap + tip
}
```

- [ ] **Step 3: Verify tests pass, commit**

```bash
git add engine-worker/src/executor/jito.rs
git commit -m "feat(engine): add Jito bundle builder with tip instruction"
```

---

### Task 12: Paper Mode Simulator

**Files:**
- Create: `engine-worker/src/executor/simulator.rs`

- [ ] **Step 1: Implement paper trade simulator**

- `Simulator::new(rpc_client: Arc<RpcClient>)`
- `simulate(instructions: Vec<Instruction>, payer: &Keypair) -> Result<TradeResult>` — calls `rpc_client.simulate_transaction()`, parses logs for success/failure, computes virtual P&L
- Maintains a virtual balance tracker for paper P&L reporting
- Returns `TradeResult` with `tx_hash: None`, simulated profit

- [ ] **Step 2: Write test, verify, commit**

```bash
git add engine-worker/src/executor/simulator.rs
git commit -m "feat(engine): add paper mode trade simulator using RPC simulate_transaction"
```

---

### Task 13: Executor Dispatcher

**Files:**
- Create: `engine-worker/src/executor/mod.rs`

- [ ] **Step 1: Implement executor dispatcher**

- `Executor::new(mode, jito_client, simulator, circuit_breaker, telemetry_writer)`
- `execute(opportunity: Opportunity, wallet: &Keypair) -> TradeResult`:
  1. Check circuit breaker — if tripped, return error
  2. Match on mode:
     - Paper → `simulator.simulate()`
     - Devnet/Mainnet → `jito_client.build_bundle()` + `submit_bundle()`
  3. Record result in circuit breaker
  4. Write telemetry event
  5. Return TradeResult

- [ ] **Step 2: Write test for mode dispatch, verify, commit**

```bash
git add engine-worker/src/executor/mod.rs
git commit -m "feat(engine): add executor dispatcher with mode-based routing"
```

---

## Phase 4: Approval Flow

### Task 14: Approval Router

**Files:**
- Create: `engine-worker/src/approval/mod.rs`

- [ ] **Step 1: Implement approval router**

- `ApprovalRouter::new(config, telegram, executor_tx)`
- Receives `Opportunity` from strategy detectors via mpsc channel
- Decision logic:
  - Paper mode → log + notify, never execute
  - Profit >= threshold → send to executor channel immediately
  - Profit < threshold → add to pending queue, notify Telegram + dashboard
- Pending queue: `HashMap<String, PendingOpportunity>` with expiry timer
- `approve(id: &str) -> Result<()>` — atomic CAS: only transitions PENDING→APPROVED once
- `reject(id: &str)` / `expire_stale()` — cleanup
- Spawns background task to expire old opportunities every 10s

- [ ] **Step 2: Write test for threshold routing**

```rust
#[test]
fn test_above_threshold_auto_executes() {
    // Opportunity with 1.0% profit, threshold 0.5%
    // Should route to executor, not approval queue
}

#[test]
fn test_below_threshold_queues_for_approval() {
    // Opportunity with 0.2% profit, threshold 0.5%
    // Should add to pending queue
}

#[test]
fn test_paper_mode_never_executes() {
    // Even above threshold, Paper mode only logs
}
```

- [ ] **Step 3: Verify tests pass, commit**

```bash
git add engine-worker/src/approval/mod.rs
git commit -m "feat(engine): add approval router with threshold-based auto-execute"
```

---

### Task 15: Telegram Bot Client

**Files:**
- Create: `engine-worker/src/approval/telegram.rs`

- [ ] **Step 1: Implement Telegram bot**

- `TelegramBot::new(token: String, chat_id: String)`
- `send_opportunity(opp: &Opportunity) -> Result<()>` — format message per spec, POST to `https://api.telegram.org/bot{token}/sendMessage`
- `send_alert(message: &str) -> Result<()>` — generic alert (circuit breaker, errors)
- `poll_updates(last_update_id: &mut i64) -> Vec<TelegramCommand>` — GET `/getUpdates?offset={id}`, parse `/approve_<id>` and `/reject_<id>` and `/resume` commands
- `run_poller(approval_router)` — async loop: poll every 2s, forward commands to approval router
- All errors are logged and skipped (Telegram is non-critical)

- [ ] **Step 2: Write test for command parsing**

```rust
#[test]
fn test_parse_approve_command() {
    let text = "/approve_abc-123-def";
    let cmd = TelegramBot::parse_command(text);
    assert_eq!(cmd, Some(TelegramCommand::Approve("abc-123-def".into())));
}

#[test]
fn test_parse_resume_command() {
    let text = "/resume";
    let cmd = TelegramBot::parse_command(text);
    assert_eq!(cmd, Some(TelegramCommand::Resume));
}
```

- [ ] **Step 3: Verify tests pass, commit**

```bash
git add engine-worker/src/approval/telegram.rs
git commit -m "feat(engine): add Telegram bot for opportunity alerts and approval commands"
```

---

### Task 16: HTTP API Server (Axum)

**Files:**
- Create: `engine-worker/src/approval/http_server.rs`

- [ ] **Step 1: Implement Axum HTTP server**

Endpoints per spec:
- `GET /api/status` — returns engine health JSON (mode, uptime, strategies, circuit breaker, P&L, price feed status)
- `GET /api/opportunities` — returns pending opportunities from approval router
- `POST /api/opportunities/:id/approve` — calls `approval_router.approve(id)`
- `POST /api/opportunities/:id/reject` — calls `approval_router.reject(id)`
- `GET /api/positions` — returns active held positions

All routes require `Authorization: Bearer {ENGINE_API_SECRET}` middleware. CORS enabled for Next.js origin.

Shared state via Axum `State<Arc<AppState>>`:
```rust
struct AppState {
    approval_router: Arc<ApprovalRouter>,
    circuit_breaker: Arc<RwLock<CircuitBreaker>>,
    config: Arc<EngineConfig>,
    start_time: Instant,
    price_cache: Arc<RwLock<PriceCache>>,
}
```

- [ ] **Step 2: Write test for auth middleware**

```rust
#[tokio::test]
async fn test_unauthenticated_request_rejected() {
    // Build app, send request without Bearer token
    // Expect 401 Unauthorized
}

#[tokio::test]
async fn test_status_endpoint_returns_mode() {
    // Build app with test state, send authenticated GET /api/status
    // Expect 200 with mode field
}
```

- [ ] **Step 3: Verify tests pass, commit**

```bash
git add engine-worker/src/approval/http_server.rs
git commit -m "feat(engine): add authenticated Axum HTTP API for dashboard integration"
```

---

## Phase 5: Atomic Strategies

### Task 17: Smart Contract Hardening (before strategies that use vault)

**Files:**
- Modify: `programs/pocketchange_vault/src/lib.rs`

Must be done before flash loan strategy (Task 19) since hardening changes the VaultState struct.

- [ ] **Step 1: Add borrow state tracking to VaultState**

Add fields: `is_borrowing: bool`, `borrow_amount: u64`, `pre_borrow_balance: u64`

- [ ] **Step 2: Update borrow_for_arbitrage**

Set `vault_state.is_borrowing = true`, store amounts. Add constraint: `require!(!vault_state.is_borrowing, VaultError::BorrowAlreadyActive)`.

- [ ] **Step 3: Update process_arbitrage**

Add balance assertion: `require!(vault_usdc.amount >= vault_state.pre_borrow_balance, VaultError::InsufficientRepayment)`. Clear borrow state.

- [ ] **Step 4: Replace unwrap() with error propagation**

Convert all `checked_mul(...).unwrap()` to `checked_mul(...).ok_or(VaultError::MathOverflow)?`.

- [ ] **Step 5: Add VaultError variants**

```rust
#[error_code]
pub enum VaultError {
    #[msg("Math overflow")] MathOverflow,
    #[msg("Borrow already active")] BorrowAlreadyActive,
    #[msg("Insufficient repayment")] InsufficientRepayment,
}
```

- [ ] **Step 6: Build and verify**

Run: `cd programs/pocketchange_vault && anchor build`

- [ ] **Step 7: Commit**

```bash
git add programs/pocketchange_vault/
git commit -m "security(vault): add borrow state tracking, balance assertions, error propagation"
```

---

### Task 18: Triangular DEX Strategy

**Files:**
- Create: `engine-worker/src/strategy/mod.rs`
- Create: `engine-worker/src/strategy/triangular.rs`

- [ ] **Step 1: Define Strategy trait in mod.rs**

```rust
#[async_trait]
pub trait Strategy: Send + Sync {
    fn name(&self) -> &str;
    fn kind(&self) -> StrategyKind;
    async fn evaluate(&self, prices: &PriceCache) -> Vec<Opportunity>;
    fn build_instructions(&self, opp: &Opportunity, wallet: &Keypair) -> Result<Vec<Instruction>>;
    fn min_profit_threshold(&self) -> Decimal;
    fn normalized_profit_pct(&self, opp: &Opportunity) -> Decimal;
}
```

Also implement `run_detector(strategy, price_rx, opportunity_tx)` — generic async loop that listens for price updates, calls `evaluate()`, and forwards opportunities.

- [ ] **Step 2: Implement TriangularStrategy**

In `triangular.rs`:
- Predefined route set: `[(SOL, RAY, USDC), (SOL, BONK, USDC), (SOL, WIF, USDC), (USDC, SOL, RAY)]`
- `evaluate()`: for each route, fetch Jupiter quotes for each leg, calculate round-trip return, deduct estimated fees (Jito tip + priority fee). Flag if net profit > threshold.
- `build_instructions()`: chain 3 Jupiter swap instructions from the existing `JupiterProvider::get_instructions()` pattern in `engine/providers.rs`
- `normalized_profit_pct()`: `round_trip_return - estimated_fees_pct`

- [ ] **Step 3: Write test for profit calculation**

```rust
#[test]
fn test_triangular_profit_calculation() {
    // SOL -> RAY: 1 SOL = 10 RAY
    // RAY -> USDC: 10 RAY = 152 USDC
    // USDC -> SOL: 152 USDC = 1.01 SOL
    // Round-trip return = (1.01 - 1.0) / 1.0 = 1.0%
    // Minus fees ~0.3% = 0.7% net profit
}
```

- [ ] **Step 4: Verify tests pass, commit**

```bash
git add engine-worker/src/strategy/
git commit -m "feat(engine): add Strategy trait and triangular DEX arb implementation"
```

---

### Task 19: Flash Loan Strategy

**Files:**
- Create: `engine-worker/src/strategy/flash_loan.rs`

- [ ] **Step 1: Read and understand VaultExecutor instruction builders**

Read `engine-worker/src/engine/mod.rs`. Understand these functions before implementing:
- `get_discriminator(name: &str) -> [u8; 8]` — creates SHA256 Anchor instruction discriminator from `"global:<name>"`
- `VaultExecutor::build_vault_ptb(borrow_amount: u64, swap_ixs: Vec<Instruction>) -> Vec<Instruction>` — assembles: borrow_for_arbitrage IX → swap instructions → process_arbitrage IX. Uses program accounts: vault PDA, USDC mint, admin signer, token program.
- `VaultExecutor::fetch_jupiter_instructions(quote_response: &Value) -> Vec<Instruction>` — POSTs to Jupiter V6 `/swap-instructions`, base64-decodes instruction data and account keys.

These are already implemented and tested. Your flash loan strategy will call them directly.

- [ ] **Step 2: Implement FlashLoanStrategy**

- Reuses `VaultExecutor::build_vault_ptb()` from `engine/mod.rs`
- `evaluate()`: fetch Jupiter quote for each candidate route. If quote shows profit > borrow cost, create opportunity.
- `build_instructions()`: assemble `borrow_for_arbitrage` → Jupiter swap(s) → `process_arbitrage` instructions in order. Uses Anchor discriminators from existing `get_discriminator()` function.
- If vault program not found at init, `evaluate()` returns empty vec (disabled).

- [ ] **Step 2: Write test for instruction ordering**

```rust
#[test]
fn test_flash_loan_instruction_order() {
    // Verify: first instruction is borrow, last is process_arbitrage
    // Middle instructions are swaps
}
```

- [ ] **Step 3: Verify tests pass, commit**

```bash
git add engine-worker/src/strategy/flash_loan.rs
git commit -m "feat(engine): add flash loan strategy using vault borrow-swap-repay PTB"
```

---

## Phase 6: Non-Atomic Strategies

### Task 20: CEX-DEX Strategy + CEX Executor

**Files:**
- Create: `engine-worker/src/strategy/cex_dex.rs`
- Create: `engine-worker/src/executor/cex_executor.rs`

This is the most complex strategy because it's non-atomic (two-phase: DEX then CEX).

- [ ] **Step 1: Implement CexExecutor (Bitget order placement)**

In `executor/cex_executor.rs`:
```rust
pub struct CexExecutor {
    api_key: String,
    api_secret: String,
    passphrase: String,
    client: reqwest::Client,
    max_exposure_secs: u64,
}

pub struct CexDexPosition {
    pub id: String,
    pub status: CexDexStatus, // DexPending, DexConfirmed, CexPending, CexConfirmed, Stuck, Unwinding
    pub dex_tx_hash: Option<String>,
    pub cex_order_id: Option<String>,
    pub pair: String,
    pub size: Decimal,
    pub opened_at: Instant,
}

pub enum CexDexStatus { DexPending, DexConfirmed, CexPending, CexConfirmed, Stuck, Unwinding, Settled }
```

Methods:
- `place_market_order(pair, side, size) -> Result<String>` — POST to Bitget `/api/v2/spot/trade/place-order` with HMAC auth
- `get_order_status(order_id) -> Result<OrderStatus>` — check fill status
- `execute_cex_leg(position: &mut CexDexPosition) -> Result<()>` — place order, retry 3x with 2s/4s/8s backoff, mark stuck on failure
- `unwind_dex_leg(position: &CexDexPosition, wallet: &Keypair) -> Result<()>` — reverse the on-chain swap at market
- `run_settlement_monitor(position_lock: Arc<Mutex<Option<CexDexPosition>>>, telegram)` — async loop: check open position, auto-unwind after `max_exposure_secs`, alert on stuck

- [ ] **Step 2: Implement CexDexStrategy**

In `strategy/cex_dex.rs`:
- `evaluate()`: compare Bitget price vs Jupiter quote. Calculate spread minus total fees (CEX fee + gas + slippage + withdrawal). Flag if spread > 2x fees.
- `build_instructions()`: returns DEX leg instructions only (Jupiter swap). CEX leg is handled by `CexExecutor` after DEX confirms.
- `normalized_profit_pct()`: `spread_pct - total_fees_pct`
- One position at a time: `Arc<Mutex<Option<CexDexPosition>>>` — `evaluate()` returns empty if a position is open.

The executor dispatcher (Task 13) needs a special case for CEX-DEX: after DEX leg confirms, hand off to `CexExecutor::execute_cex_leg()`.

- [ ] **Step 3: Write tests for spread calculation, settlement states, and order retry**

```rust
#[test]
fn test_spread_calculation_positive() {
    // Bitget SOL price: $150.50, Jupiter SOL price: $149.80
    // Spread: 0.47%, Fees: ~0.15%
    // Net: 0.32% — above 2x fees threshold? No (2x0.15=0.30). Marginal.
}

#[test]
fn test_settlement_stuck_after_timeout() {
    let mut pos = CexDexPosition { status: CexDexStatus::CexPending, opened_at: Instant::now() - Duration::from_secs(400), .. };
    // max_exposure_secs = 300 → should transition to Stuck
}

#[test]
fn test_one_position_at_a_time() {
    // With an open position, evaluate() returns empty
}
```

- [ ] **Step 4: Verify tests pass, commit**

```bash
git add engine-worker/src/strategy/cex_dex.rs engine-worker/src/executor/cex_executor.rs
git commit -m "feat(engine): add CEX-DEX strategy with two-phase execution and settlement recovery"
```

---

### Task 21: Funding Rate Strategy

**Files:**
- Create: `engine-worker/src/strategy/funding_rate.rs`

- [ ] **Step 1: Implement FundingRateStrategy**

- `evaluate()`: fetch Drift funding rates via REST API, compare against spot yield. Flag when differential exceeds threshold.
- `build_instructions()`: instructions for opening hedged position (spot buy + perp short, or vice versa)
- Position management: `run_position_monitor()` async task that periodically checks open positions, collects funding, exits when conditions met
- `normalized_profit_pct()`: annualized funding rate differential

- [ ] **Step 2: Write tests, verify, commit**

```bash
git add engine-worker/src/strategy/funding_rate.rs
git commit -m "feat(engine): add funding rate arbitrage strategy with position management"
```

---

### Task 22: Statistical Arbitrage Strategy

**Files:**
- Create: `engine-worker/src/strategy/statistical.rs`

- [ ] **Step 1: Implement StatisticalStrategy**

- Maintains rolling window of price ratios (configurable window size, e.g., 100 data points)
- `evaluate()`: calculate z-score = (current_ratio - mean) / std_dev. Flag when |z-score| > threshold.
- `build_instructions()`: instructions for opening pair trade (long underperformer, short outperformer)
- Position management: monitor for ratio reversion to mean, stop-loss on divergence
- `normalized_profit_pct()`: `abs(z_score) * historical_pct_per_z`

- [ ] **Step 2: Write test for z-score calculation**

```rust
#[test]
fn test_zscore_calculation() {
    let ratios = vec![1.0, 1.01, 0.99, 1.02, 0.98, 1.0, 1.01, 0.99];
    let stats = StatisticalStrategy::calculate_stats(&ratios);
    // Current ratio 0.99, mean ~1.0, std ~0.013
    // z-score should be about -0.77
    assert!((stats.z_score - (-0.77)).abs() < 0.1);
}
```

- [ ] **Step 3: Verify tests pass, commit**

```bash
git add engine-worker/src/strategy/statistical.rs
git commit -m "feat(engine): add statistical arbitrage strategy with z-score detection"
```

---

## Phase 7: Integration

### Task 23: Database Migration (Prisma)

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Update Prisma schema**

Change `provider = "sqlite"` to `provider = "postgresql"`. Add:

```prisma
model Opportunity {
  id              String    @id @default(uuid())
  strategy        String
  route           String
  expectedProfit  Float
  tradeSize       Float
  status          String    @default("PENDING")
  mode            String
  detectedAt      DateTime  @default(now())
  resolvedAt      DateTime?
  resolvedBy      String?
  executionTxHash String?
  executionProfit Float?
  createdAt       DateTime  @default(now())
}
```

- [ ] **Step 2: Run Prisma migration**

Run: `npx prisma migrate dev --name add_opportunity_model`
Expected: Migration created and applied. If PostgreSQL is not running locally, use `npx prisma db push` as fallback.

- [ ] **Step 3: Generate Prisma client**

Run: `npx prisma generate`
Expected: Client generated successfully

- [ ] **Step 3: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(db): migrate to PostgreSQL, add Opportunity model"
```

---

### Task 24: Next.js API Routes for Opportunities

**Files:**
- Create: `src/app/api/opportunities/route.ts`
- Modify: `src/app/api/engine/route.ts`
- Modify: `src/app/api/logs/route.ts`

- [ ] **Step 1: Create opportunities API route**

```typescript
// GET: list opportunities (optional ?status=PENDING filter)
// POST: create new opportunity (from engine)
// PATCH: update opportunity status (approve/reject/execute)
// Auth: check ENGINE_API_SECRET header
```

- [ ] **Step 2: Update engine proxy route**

Extend `src/app/api/engine/route.ts` to proxy all sub-paths (`/api/engine/opportunities/*`, `/api/engine/positions`, etc.) to port 3002.

- [ ] **Step 3: Update logs route for new telemetry schema**

Update field mapping in `src/app/api/logs/route.ts` to handle new JSONL fields (`event`, `strategy`, `expected_profit_pct`, etc.).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/opportunities/ src/app/api/engine/ src/app/api/logs/
git commit -m "feat(api): add opportunities CRUD route, update engine proxy and logs parser"
```

---

### Task 25: Main.rs Orchestration & Docker

**Files:**
- Modify: `engine-worker/src/main.rs`
- Modify: `engine-worker/Dockerfile`

- [ ] **Step 1: Rewrite main.rs startup sequence**

```rust
#[tokio::main]
async fn main() -> Result<()> {
    // 1. Load config
    let config = Arc::new(EngineConfig::load("engine.toml")?);

    // 2. Init structured logger
    tracing_subscriber::fmt().json().init();
    info!(mode = ?config.mode, "Starting ArbitraSaaS Engine");

    // 3. KMS decrypt wallet
    let kms = KMSClient::from_env()?;
    let wallet = kms.decrypt_wallet()?;

    // 4. Connect to Solana RPC
    let rpc = Arc::new(RpcClient::new(config.rpc_url()));

    // 5. Check vault program
    let vault_available = check_vault_program(&rpc, &config).await;
    if !vault_available { warn!("Vault program not found — flash loan strategy disabled"); }

    // 6. Init shared state
    let price_cache = Arc::new(RwLock::new(PriceCache::new()));
    let (price_tx, _) = broadcast::channel(256);
    let circuit_breaker = Arc::new(RwLock::new(CircuitBreaker::new(config.max_loss_24h, config.max_trade_size * 2)));
    let telemetry = Arc::new(TelemetryWriter::new(&config));

    // 7. Build executor
    let jito = JitoClient::new(config.jito_endpoint.clone());
    let simulator = Simulator::new(rpc.clone());
    let executor = Arc::new(Executor::new(config.mode, jito, simulator, circuit_breaker.clone(), telemetry.clone()));

    // 8. Build approval router
    let telegram = TelegramBot::from_env();
    let (exec_tx, exec_rx) = mpsc::channel(64);
    let router = Arc::new(ApprovalRouter::new(config.clone(), telegram.clone(), exec_tx));

    // 9. Spawn all tasks
    let mut tasks = JoinSet::new();

    // Price feeds
    tasks.spawn(JupiterPoller::new(price_cache.clone(), price_tx.clone()).run(500));
    if config.strategy_enabled("cex_dex") {
        tasks.spawn(BitgetPoller::from_env(price_cache.clone(), price_tx.clone()).run(2000));
    }

    // Strategy detectors
    let (opp_tx, opp_rx) = mpsc::channel(128);
    let strategies = build_strategies(&config, vault_available);
    for strategy in strategies {
        let rx = price_tx.subscribe();
        let tx = opp_tx.clone();
        tasks.spawn(run_detector(strategy, rx, tx));
    }

    // Approval router
    tasks.spawn(router.clone().run(opp_rx));

    // Executor consumer
    tasks.spawn(run_executor_loop(executor.clone(), exec_rx, wallet));

    // Telegram poller
    if let Some(bot) = telegram {
        tasks.spawn(bot.run_poller(router.clone()));
    }

    // HTTP API server
    tasks.spawn(start_http_server(router.clone(), circuit_breaker.clone(), config.clone(), price_cache.clone()));

    info!("Engine started in {:?} mode", config.mode);

    // 10. Await shutdown
    tokio::select! {
        _ = signal::ctrl_c() => { info!("Shutting down..."); }
        res = tasks.join_next() => {
            if let Some(Err(e)) = res { error!("Task failed: {}", e); }
        }
    }

    Ok(())
}
```

- [ ] **Step 2: Update module declarations**

Replace old module declarations with:
```rust
mod config;
mod db;
mod kms;
mod types;
mod price;
mod strategy;
mod approval;
mod executor;
mod engine; // keep for VaultExecutor instruction builders
```

- [ ] **Step 3: Remove old engine code references**

Remove NATS references, tenant loops, hardcoded RPC URLs from old `main.rs`. Keep `engine/mod.rs` for `VaultExecutor::build_vault_ptb()` and `get_discriminator()` — used by flash_loan strategy.

- [ ] **Step 4: Update Dockerfile**

Ensure it copies `engine.toml` and exposes port 3002.

- [ ] **Step 5: Full build and test**

Run: `cd engine-worker && cargo build`
Run: `cd engine-worker && cargo test`
Expected: All tests pass, binary compiles

- [ ] **Step 6: Commit**

```bash
git add engine-worker/src/main.rs engine-worker/Dockerfile
git commit -m "feat(engine): wire up main.rs orchestration with all modules and graceful shutdown"
```

---

## Verification Checklist

After all tasks are complete:

- [ ] `cd engine-worker && cargo test` — all unit tests pass
- [ ] `cd engine-worker && cargo build --release` — release binary compiles
- [ ] `cd engine-worker && cargo clippy` — no warnings
- [ ] `npx prisma generate` — Prisma client generates
- [ ] `npm run build` — Next.js builds (ignoring pre-existing middleware errors)
- [ ] Run engine in paper mode: `MODE=paper cargo run` — starts, polls prices, logs opportunities
- [ ] Verify telemetry.jsonl is written with new schema
- [ ] Verify Telegram alerts fire (if bot token configured)
- [ ] Verify `GET http://localhost:3002/api/status` returns engine health
- [ ] `anchor build` — vault contract compiles with hardening changes
