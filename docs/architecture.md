# ArbitraSaaS Architecture

## System Overview
ArbitraSaaS transforms the Jarvis Arbitrage Engine into a multi-tenant cloud application. 
The system leverages Rust for low-latency transaction processing, Next.js for the dynamic frontend and REST API, and Postgres/TimescaleDB for robust time-series data storage.

## Component Breakdown

1. **Frontend Dashboard (Next.js Application)**
   - Houses the `User Dashboard` (Wallets, Settings, Dashboard) and `Admin Dashboard`.
   - Hosted on Kubernetes across autoscaling pods.
   - Communicates with the Next.js API Routes to interact with the database.

2. **Core Trading Engine (Rust Worker Pool)**
   - Deployed as `arbitrasaas-engine-worker` via Kubernetes.
   - **Isolation**: Each active profile gets its execution thread under cgroup bounds.
   - **Ingestion**: A shared central NATS pub/sub broker distributes real-time RPC data from Solana.
   - **Execution**: Jito bundles are used for MEV-protected dynamic routing execution.
   
3. **Data Layer (Prisma + PostgreSQL / TimescaleDB)**
   - Maintains references to user preferences, encrypted keys, and transaction history.
   - TimescaleDB functions maintain real-time aggregates for PNL and user analytics.

4. **Security Envelope (HSM / KMS Implementation)**
   - Users provide private keys through the Dashboard. 
   - Keys are encrypted locally using an ephemeral RSA public key from the backend.
   - The backend KMS proxy intercepts the key, decrypts it safely, re-encrypts it via AES-256 with a master rotation key, and saves it in Prisma. 
   - Workers query the KMS for in-memory decryption per trade.

## High Availability & Scalability
- Horizontal scalability handles 50,000+ wallets utilizing NATS event-driven architecture.
- Fallback RPCs execute when primary fails.
