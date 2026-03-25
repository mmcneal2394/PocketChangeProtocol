# Antigravy IDE — PocketChange Protocol Swarm

Composable AI agent swarm for Solana MEV arbitrage with formal risk governance.

## Directory Structure

```
antigravy/
├── prompts/
│   ├── swarm_skills/
│   │   ├── scanner_agent.prompt      ← DEX price monitoring, Geyser stream
│   │   ├── analyst_agent.prompt      ← Profit validation, false-positive filter
│   │   ├── executor_agent.prompt     ← Jito bundle submission, pre-flight checks
│   │   ├── coordinator_agent.prompt  ← Capital allocation, reputation weighting
│   │   └── risk_manager_agent.prompt ← 3-level circuit breakers, VETO power
│   └── risk_management/
│       ├── circuit_breaker.prompt    ← L1/L2/L3 breaker definitions
│       ├── position_limits.prompt    ← Graduated limits by phase
│       └── stress_test_scenario.prompt ← 4 scenarios before going live
├── workflows/
│   ├── discovery_workflow.yaml       ← Scanner→Analyst→Risk→Coordinator
│   ├── operation_workflow.yaml       ← Coordinator→Executor→Reconcile
│   ├── risk_monitoring_workflow.yaml ← 5s risk loop, daily report
│   └── adaptation_workflow.yaml     ← 6h rebalance, prune underperformers
└── templates/
    ├── agent_config.json             ← Per-agent config template
    ├── swarm_manifest.yaml           ← Full swarm declaration
    └── risk_policy.yaml             ← SOURCE OF TRUTH for all risk params
```

## Quick Start

```bash
# 1. Edit risk_policy.yaml — set current_phase and limits
# 2. Run stress tests BEFORE going live with capital
python antigravy/scripts/run_stress_tests.py --scenarios all

# 3. Start the opportunity hunt loop (no capital needed)
python -X utf8 antigravity-swarm/hunt.py --interval 900

# 4. When wallet funded → review risk_policy.yaml, then start engine
cd optimized-jupiter-bot && npx ts-node src/index.ts
```

## Pre-Live Checklist
- [ ] Wallet funded (≥ 0.5 SOL)
- [ ] Stress test score ≥ 70/100 (run stress_test_scenario.prompt)
- [ ] risk_policy.yaml reviewed: circuit_breakers, position_limits
- [ ] ATA cache pre-created: `npx ts-node scripts/setup_atas.ts`
- [ ] readiness_check.ts passes: `npx ts-node scripts/readiness_check.ts`
- [ ] Trade log path confirmed in swarm_manifest.yaml
- [ ] Daily report recipient configured

## Risk Governance Flow
```
opportunity_found
       ↓
[risk_manager] ← pre-checks circuit_breakers, position_limits
       ↓ approved
[coordinator]  ← assigns executor by performance weight
       ↓
[executor]     ← re-quotes live, simulates, submits Jito bundle
       ↓
[risk_manager] ← post-trade: update exposure, check L3
```
