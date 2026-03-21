# Roadmap: Milestone 3 (V2.0)

## Phase 1: PostgreSQL Telemetry Infrastructure
**Goal**: Launch PostgreSQL logic for logging Engine execution telemetry locally and remotely.
- Establish `docker-compose.yml` defining the `timescaledb/postgres` container.
- Build the `db/mod.rs` integration for `sqlx` in the rust `engine-worker`.
- Create a SQL script or schema initialization function for `trade_logs`.
- Validate that the rust worker injects fake/real logs successfully during polling.
- *Status*: Pending

## Phase 2: React Dashboard Next.js Dynamic Sourcing
**Goal**: Hook up the Next.js SaaS UI `api/logs` endpoint directly to the PostgreSQL database to pipe real stream data.
- Install `pg` node connector in the root frontend package.
- Overwrite `/api/logs/route.ts` to `SELECT * FROM trade_logs ORDER BY execution_time_ms DESC LIMIT 10`.
- *Status*: Pending

## Phase 3: Devnet Smart Contract and E2E Testing
**Goal**: Point the entire infrastructure from `localhost` toward `devnet`. Ensure full test cycle functions over the Solana test network with real wallet signoffs.
- Deploy the contract to devnet via native CLI or node mappings.
- Reconfigure `src/app/page.tsx` RPC urls and program addresses.
- Execute a Deposit of USDC from a devnet-loaded wallet.
- Process logs successfully on screen.
- *Status*: Pending
