# PocketChange ($PCP) – The Decentralized Arbitrage Protocol  
*Turning pocket change into institutional-grade returns*

---

## 🪙 Token Overview

| Attribute          | Value                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **Token Name**     | PocketChange                                                                                                                   |
| **Ticker**         | $PCP                                                                                                                           |
| **Contract Address** | `4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS`                                                                                 |
| **Blockchain**     | Solana                                                                                                                         |
| **Token Standard** | SPL                                                                                                                            |
| **Decimals**       | 9                                                                                                                              |
| **Total Supply**   | 1,000,000,000 $PCP                                                                                                             |
| **Initial Liquidity** | Locked for 12 months (proof available on-chain)                                                                                |

---

## 🧠 The Problem

Arbitrage is one of the most reliable strategies in crypto, yet it remains inaccessible to everyday investors:
- **High capital requirements** – You need significant funds to capture meaningful spreads.
- **Latency arms race** – Bots with co-located servers dominate the space.
- **Complex infrastructure** – Building and maintaining arbitrage bots is prohibitively expensive.
- **MEV & sandwich attacks** – Retail traders are front‑run at every turn.

As a result, **billions in annual arbitrage profits** are captured by a handful of institutional players and MEV bots. The average user is left watching from the sidelines.

---

## 💡 The Solution: PocketChange ($PCP)

PocketChange is the first **community‑owned arbitrage protocol** on Solana. By pooling user funds and leveraging advanced execution strategies, $PCP democratizes access to high‑frequency arbitrage profits.

### How It Works

1. **Users deposit** USDC or SOL into the PocketChange Vault and receive **$PCP tokens** proportional to their stake.
2. **The vault executes** automated arbitrage strategies across:
   - Solana DEXs (Raydium, Orca, Meteora)
   - Centralized exchanges (Bitget, Kraken)
   - Flash loan opportunities
   - Prediction markets (Polymarket)
   - Negative lending rate plays
3. **Profits are compounded** – 80% dynamically inflates the underlying value of all circulating $PCP tokens, and 20% is routed to the protocol treasury.
4. **Withdrawal** – Users burn their $PCP at any time to reclaim base assets, subject to a **0.5% unstaking fee** that protects liquidity and rewards long-term holders.

### Why Solana?
- **Sub‑second finality** – Enables latency‑sensitive arbitrage.
- **Transaction costs < $0.001** – Makes micro‑arbitrage viable.
- **Rich DeFi ecosystem** – Deep liquidity across multiple protocols.

---

## 🤖 Core Arbitrage Strategies

| Strategy | Description | Target Return |
|----------|-------------|---------------|
| **Triangular Arbitrage** | Exploit price inefficiencies between SOL, USDC, and USDT pairs across DEXs. | 0.1–0.5% per trade |
| **CEX‑DEX Arbitrage** | Buy on Bitget (0.01% fees), withdraw to Solana, sell on Raydium. | 0.5–2% per cycle |
| **Flash Loan Arbitrage** | Borrow millions uncollateralized, arbitrage across DEXs, repay in same block. | Variable |
| **Negative Rate Lending** | Borrow assets at negative APR (get paid), deposit in high‑yield vaults. | 2–4% APY |
| **Prediction Market Arb** | Buy complete sets on Polymarket below $1.00 for guaranteed profit. | Event‑driven |

*All strategies are executed atomically using Programmable Transaction Blocks (PTBs) – if any step fails, the entire transaction reverts.*

---

## 📊 Tokenomics – Fueling the Arbitrage Engine

$PCP is the **economic backbone** of the protocol:

- **Auto-Compounding Pool Share** – $PCP serves as the native liquid staking token. Its value automatically inflates against the underlying deposit assets as arbitrage profits are secured by the vault.
- **Deflationary Mechanics** – A smart-contract enforced **0.5% unstaking fee** is levied on withdrawals, protecting the pool and directly benefiting long-term holders.
- **Governance** – Holders propose and vote on new strategies, risk parameters, and treasury allocations.
- **Atomic Operations** – The vault is non-custodial and operates via atomic Programmable Transaction Blocks (PTB).

### Allocation

| Allocation | % | Vesting / Lockup |
|------------|---|------------------|
| Liquidity Pool (SOL/$PCP) | 30% | Locked 12 months |
| Vault Staking Rewards | 20% | Emitted over 3 years |
| Team | 15% | 1‑year cliff, 2‑year linear |
| Treasury | 15% | Multi‑sig controlled |
| Community Airdrops | 10% | Immediate |
| Strategic Partners | 10% | 6‑month cliff |

**Security First:**
- Mint authority **renounced** (no new tokens can be created).
- Freeze authority **renounced** (no one can freeze your tokens).
- LP tokens **locked** via Streamflow

---

## 🏗️ Technical Architecture

```text
┌─────────────────┐
│   User Deposits │ (USDC, SOL)
└────────┬────────┘
         ▼
┌─────────────────┐
│ PocketChange    │ → Mints $PCP (Pool Share Token)
│ Vault Contract  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Arbitrage Bot   │ → Scans opportunities across DEXs/CEXs
│ (Off‑chain)     │ → Submits PTBs to Jito bundles (MEV protection)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Profit          │ → 80% Stays in Vault (Boosts $PCP value)
│ Distribution    │ → 20% to Protocol Treasury
└─────────────────┘
```

**Key Features:**
- **Atomic Execution** – PTBs ensure all swaps succeed or none do.
- **Jito Integration** – Transactions are submitted via private mempool to prevent sandwich attacks.
- **Dynamic Fees** – Priority fees adjust based on network congestion and opportunity size.
- **AI Scoring** – Multi‑factor analysis (spread, liquidity, slippage, gas) to filter only profitable trades.

---

## 🛡️ Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Smart contract exploits | Audits, bug bounty program, insurance fund (5% of treasury) |
| MEV / sandwich attacks | Jito bundles + private mempool + flashbot‑style protection |
| Impermanent loss | Focus on stablecoin‑based strategies; delta‑neutral hedging |
| Regulatory uncertainty | Compliance‑first approach, KYC for large fiat offramps |

---

## 🚀 Roadmap

**Q2 2026 – Foundation**
- ✅ Token creation (`4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS`)
- 🔄 Liquidity pool launch on Raydium
- 🔄 Vault contract development & audit
- 🔄 Community building (Telegram, Twitter, Discord)

**Q3 2026 – Vault Live**
- Mainnet deployment of PocketChange Vault
- Initial arbitrage strategies (triangular + CEX‑DEX)
- Staking rewards go live
- First profit distribution

**Q4 2026 – Expansion**
- Flash loan integration
- Prediction market arbitrage
- Negative lending rate monitoring
- Tier‑2 CEX listings

**2027 – Governance & Scaling**
- DAO launch – $PCP holders vote on strategy parameters
- Cross‑chain expansion (Ethereum, Base, Sui via Wormhole)
- Institutional partnerships

---

## 💬 Community & Transparency

- **Contract Address:** `4yfwG2VqohXCMpX7SKz3uy7CKzujL4SkhjJMkgKvBAGS` (verified on Solscan)

**We believe in radical transparency:**
- All code open‑source (GitHub)
- Real‑time profit tracking dashboard
- Regular AMAs with the team
- Community multi‑sig for treasury

---

## 🎯 The Ask – Join the PocketChange Revolution

We’re building the **people’s arbitrage protocol**. Whether you’re a crypto veteran or just getting started, $PCP gives you a stake in the most consistent yield opportunity in DeFi.

- **For Investors:** Buy $PCP on Raydium, stake in the vault, and earn passive income.
- **For Developers:** Contribute to our open‑source code, build new strategies, earn bounties.
- **For Partners:** Integrate PocketChange into your dApp or exchange for shared liquidity.

**Together, we turn pocket change into life‑changing wealth.**

---

## 🚀 Local Deployment (ArbitraSaaS Stack)

Want to run the complete execution environment locally or on a VPS? We've bundled the Next.js Frontend, Rust Execution Engine, and Postgres Telemetry Database into a unified Docker Compose architecture.

### Prerequisites
- Docker & Docker Compose
- Node.js (v18+) & Rust (cargo)

### Quick Start
1. Clone the repository and configure your keys:
```bash
cp .env.example .env
nano .env # Insert your KMS_MASTER_KEY and SOLANA_RPC_URL
```

2. Run the deployment script:
```bash
chmod +x deploy.sh
./deploy.sh
```

3. **Verify Deployment:**
- **Dashboard UI**: `http://localhost:3000`
- **Engine Logs**: `docker-compose logs -f engine-worker`
- **Postgres DB**: `localhost:5432`

---

*This is not financial advice. Always do your own research. $PCP is a utility token for the PocketChange protocol.*
