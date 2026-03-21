# Requirements: PocketChange Protocol Milestone 3

## V2.0 Requirements (Devnet & Telemetry)

### P1: PostgreSQL Database Infrastructure
- Stand up a PostgreSQL database (via `docker-compose.yml`) for local development and future TimescaleDB integration.
- Design the `trade_logs` schema to capture: tenant ID, tx signature, execution time, route, profit, and status.
- Re-integrate `sqlx` in the Rust `engine-worker` to pipe live execution results into this database asynchronously without blocking the trade loop.

### P2: API Backend Integration
- Refactor the Next.js SaaS Dashboard API (`/api/logs`) to query the actual PostgreSQL database instead of returning static mocked JSON.
- Ensure the frontend live stream is accurately reflecting the engine's real-time outputs.

### P3: Devnet Smart Contract Deployment
- Configure `Anchor.toml` and Solana CLI to point to `devnet`.
- Airdrop devnet SOL to the deployer keypair.
- Deploy `pocketchange_vault` to Devnet and capture the new Program ID.
- Update the Next.js `src/app/page.tsx` constants to utilize the Devnet RPC and the new Program ID.
- Mint Devnet USDC and Devnet PCP tokens for testing.

### P4: Engine Loop Execution
- Configure the engine to run its background polling loop on Devnet tokens.
- Simulate or execute actual Jupiter routed swaps on Devnet if liquidity exists, or mock the swap execution success on Devnet by simulating the transaction and just logging it.
