# PocketChange Protocol — Revenue & API Sustainability Plan
> Last updated: 2026-03-23

## Current Monthly API Costs

| Service | Tier | Purpose | Est. Cost/mo |
|---|---|---|---|
| Helius RPC | Growth (Dedicated) | Main RPC + DAS holder queries | ~$50 |
| Chainstack Geyser gRPC | Business | Real-time Solana stream (sub-slot events) | ~$100 |
| Jupiter Pro API | Lite (free tier) | Quote + swap instructions | $0 |
| DigitalOcean Droplet | 2 CPU / 4GB | Engine host (arb-node) | ~$24 |
| **Total** | | | **~$174/mo** |

> **Break-even target**: The engine needs to net ~0.06 SOL/day to cover costs at $90/SOL (~$174/30 = $5.80/day).

---

## Self-Funding Model (3 Phases)

### Phase 1 — Break-Even (~$174/mo)
**Status**: Achievable now with current engine + dynamic tip fix

- Engine needs ~0.07 SOL/day net after fees
- At 0.02 SOL trade size and ~5bps EMA on bluechip routes, that's ~70 profitable executions/day
- Dynamic tip engine shipped (2026-03-23) eliminates flat tip overpayment → improves net yield per trade by an estimated 15–30% on losing blocks
- **Action**: Run engine 24/7 on droplet, route all arb profits to reinvestment wallet

### Phase 2 — Sustainable Operations (~$500/mo)
**Status**: Requires ~100 SOL TVL from stakers

Capital math at Phase 2:
| Metric | Value |
|---|---|
| TVL | 100 SOL (~$9,000) |
| Trade size | 1–5 SOL (Kelly calibrated) |
| Target daily return | 0.3–0.5% (on capital, net) |
| Daily SOL profit | ~0.3–0.5 SOL |
| Staker share (50%) | ~0.15–0.25 SOL/day |
| Protocol share (30%) | ~0.09–0.15 SOL/day → **~$270–400/mo ops** |
| Dev/treasury (20%) | ~0.06–0.10 SOL/day → **reserves** |

**Action items**:
- [ ] Launch staker deposit dashboard (vault UI) on pcprotocol.xyz
- [ ] Enable live PnL feed in Discord for social proof
- [ ] Run marketing Angles 1–7 from hooks.md at 3 posts/day cadence
- [ ] Set up Doppler-managed secrets for prod deployment

### Phase 3 — Upgrade Fund (~$1,000+/mo)
**Status**: Requires 500 SOL TVL or grant funding

Planned upgrades unlocked at Phase 3:
| Upgrade | Cost | Impact |
|---|---|---|
| Chainstack Dedicated gRPC node | +$250/mo | Sub-5ms event latency (from ~15ms) |
| Helius Business tier | +$100/mo | 100M CUs/mo, lower hot-path latency |
| Co-located DO droplet (NYC) | +$40/mo | Same region as Jito NY block engine |
| **Total** | **+$390/mo** | Est. +20-40% profitable execution rate |

**Reserve target**: accumulate 10 SOL in treasury before Phase 3 upgrades.

---

## Grant Opportunities

### 1. Solana Foundation Developer Grants
- **Program**: Foundation Delegation Program + Build & Earn
- **Amount**: $5K–$25K USDC
- **Fit**: On-chain MEV infrastructure, community-owned arb protocol
- **Requirement**: Working product, GitHub, whitepaper
- **Apply**: grants.solana.com
- **Status**: Not applied

### 2. Helius Build Program
- **What**: RPC credits + co-marketing + Helius Discord listing
- **Fit**: We use their DAS API + RPC as core infrastructure
- **Requirement**: Ship a product built on Helius, join their builder community
- **Apply**: builders.helius.dev
- **Value equiv**: ~$50–150/mo in credits
- **Status**: Not applied

### 3. Jito Network Ecosystem Grants
- **Program**: Jito Labs MEV Ecosystem Development
- **Amount**: Discretionary (has funded bots/tooling previously)
- **Fit**: We use Jito MEV bundles as primary execution layer
- **Requirement**: Demonstrable MEV tooling, integration use case
- **Contact**: jito.network/ecosystem
- **Status**: Not applied

---

## Recommended Action Order

1. **This week**: Push dynamic tip + EMA fast-fail engine to droplet → measure net improvement in `rolling_metrics.json`
2. **This week**: Apply to Helius Build Program (lowest friction, credits = direct cost relief)
3. **Next week**: Write Solana Foundation grant application (use this doc + GEMINI.md as basis)
4. **30 days**: Launch staker deposit UI, begin Discord PnL feed → grow TVL toward Phase 2 target
5. **60 days**: Evaluate Jito grant based on on-chain execution history (need tx proof)
