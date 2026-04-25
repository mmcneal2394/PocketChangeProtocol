module.exports = {
  apps: [
    {
      name: "pcp-sniper-1",
      script: "scripts/maintain/momentum_sniper.ts",
      interpreter: "node",
      interpreter_args: "--require ts-node/register",
      env: {
        NODE_ENV: "production",
        WALLET_INDEX: "",
        WALLET_KEYPAIR_PATH: "./wallet.json",
        STRATEGY_PROFILE_PATH: "config/strategy-profiles/active.strategy.json",
        SNIPER_POLL_MS: "15000",
        SNIPER_MAX_POS: "10",
        SNIPER_MIN_VOL: "8000",
        SNIPER_MIN_CHG: "3",
        SNIPER_MIN_BR: "2.5",
        SNIPER_MIN_BUYS: "8"
      }
    },
    {
      name: "pcp-wallet-monitor",
      script: "scripts/maintain/wallet_monitor.ts",
      interpreter: "node",
      interpreter_args: "--require ts-node/register",
      env: { NODE_ENV: "production" }
    },
    {
      name: "pcp-wallet-intel",
      script: "scripts/maintain/wallet_intel_engine.ts",
      interpreter: "node",
      interpreter_args: "--require ts-node/register",
      env: { NODE_ENV: "production" }
    },
    {
      name: "pcp-profit-accumulator",
      script: "scripts/maintain/profit_accumulator.ts",
      interpreter: "node",
      interpreter_args: "--require ts-node/register",
      env: { NODE_ENV: "production" }
    },
    {
      name: "pcp-capital-allocator",
      script: "scripts/maintain/capital_allocator.ts",
      interpreter: "node",
      interpreter_args: "--require ts-node/register",
      env: { NODE_ENV: "production" }
    },
    {
      name: "pcp-arb-scout",
      script: "scripts/maintain/arb_scout.js",
      interpreter: "node",
      env: { NODE_ENV: "production" }
    },
    {
      name: "pcp-slopfest-guardian",
      script: "scripts/maintain/slopfest_guardian.ts",
      interpreter: "node",
      interpreter_args: "--require ts-node/register",
      env: { NODE_ENV: "production" }
    },
    {
      name: "pcp-overview",
      script: "scripts/maintain/overview_server.ts",
      interpreter: "node",
      interpreter_args: "--require ts-node/register",
      env: { NODE_ENV: "production" }
    },
    {
      name: "pcp-sniper-paper",
      script: "scripts/maintain/momentum_sniper.ts",
      interpreter: "node",
      interpreter_args: "--require ts-node/register",
      env: { NODE_ENV: "production", PAPER_MODE: "true" }
    }
  ]
};
