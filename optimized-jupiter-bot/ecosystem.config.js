module.exports = {
  apps: [
    {
      name: "pcp-wallet-monitor",
      script: "scripts/maintain/wallet_monitor.ts",
      interpreter: "node",
      interpreter_args: "--require ts-node/register",
      env: { NODE_ENV: "production" }
    },
    {
      name: "pcp-market-data",
      script: "scripts/maintain/pcp_market_data.ts",
      interpreter: "node",
      interpreter_args: "--require ts-node/register",
      env: { NODE_ENV: "production" }
    },
    {
      name: "pcp-performance",
      script: "scripts/maintain/performance_tracker.ts",
      interpreter: "node",
      interpreter_args: "--require ts-node/register",
      env: { NODE_ENV: "production" }
    },
    {
      name: "pcp-regime",
      script: "scripts/maintain/market_regime.ts",
      interpreter: "node",
      interpreter_args: "--require ts-node/register",
      env: { NODE_ENV: "production" }
    },
    {
      name: "pcp-stale-sweeper",
      script: "scripts/maintain/stale_sweeper.ts",
      interpreter: "node",
      interpreter_args: "--require ts-node/register",
      env: { NODE_ENV: "production" }
    },
    {
      name: "pcp-ingestion",
      script: "scripts/maintain/ingestion_api.ts",
      interpreter: "node",
      interpreter_args: "--require ts-node/register",
      env: { NODE_ENV: "production" }
    },
    {
      name: "pcp-sniper-1",
      script: "scripts/maintain/momentum_sniper.ts",
      interpreter: "node",
      interpreter_args: "--require ts-node/register",
      env: { NODE_ENV: "production", WALLET_INDEX: "1" }
    },
    {
      name: "pcp-sniper-paper",
      script: "scripts/maintain/momentum_sniper.ts",
      interpreter: "node",
      interpreter_args: "--require ts-node/register",
      env: { NODE_ENV: "production", PAPER_MODE: "true" }
    },
    {
      name: "pcp-discovery-engine",
      script: "scripts/maintain/discovery_engine.ts",
      interpreter: "node",
      interpreter_args: "--require ts-node/register",
      env: { NODE_ENV: "production" }
    }
  ]
};
