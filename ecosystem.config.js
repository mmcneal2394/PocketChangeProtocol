module.exports = {
  apps: [
    {
      name: 'solana-arbitrage-dashboard',
      script: 'start.bat',
      args: '',
      watch: false,
      autorestart: true,
      max_restarts: 100,
      env: {
        NODE_ENV: 'development',
      }
    },
    {
      name: 'pcp-sniper-1',
      script: 'node',
      args: '-r ts-node/register/transpile-only scripts/maintain/momentum_sniper.ts',
      cwd: 'optimized-jupiter-bot',
      watch: false,
      autorestart: true,
      max_restarts: 100,
      env: {
        NODE_ENV: 'production',
      }
    },
    {
      name: 'pcp-wallet-monitor',
      script: 'node',
      args: '-r ts-node/register/transpile-only scripts/maintain/wallet_monitor.ts',
      cwd: 'optimized-jupiter-bot',
      watch: false,
      autorestart: true,
      max_restarts: 100,
      env: {
        NODE_ENV: 'production',
      }
    },
    {
      name: 'pcp-wallet-intel',
      script: 'node',
      args: '-r ts-node/register/transpile-only scripts/maintain/wallet_intel_engine.ts',
      cwd: 'optimized-jupiter-bot',
      watch: false,
      autorestart: true,
      max_restarts: 100,
      env: {
        NODE_ENV: 'production',
      }
    },
    {
      name: 'pcp-profit-accumulator',
      script: 'node',
      args: '-r ts-node/register/transpile-only scripts/maintain/profit_accumulator.ts',
      cwd: 'optimized-jupiter-bot',
      watch: false,
      autorestart: true,
      max_restarts: 100,
      env: {
        NODE_ENV: 'production',
      }
    },
    {
      name: 'pcp-capital-allocator',
      script: 'node',
      args: '-r ts-node/register/transpile-only scripts/maintain/capital_allocator.ts',
      cwd: 'optimized-jupiter-bot',
      watch: false,
      autorestart: true,
      max_restarts: 100,
      env: {
        NODE_ENV: 'production',
      }
    },
    {
      name: 'pcp-arb-scout',
      script: 'node',
      args: 'scripts/maintain/arb_scout.js',
      cwd: 'optimized-jupiter-bot',
      watch: false,
      autorestart: true,
      max_restarts: 100,
      env: {
        NODE_ENV: 'production',
      }
    },
    {
      name: 'pcp-slopfest-guardian',
      script: 'node',
      args: '-r ts-node/register/transpile-only scripts/maintain/slopfest_guardian.ts',
      cwd: 'optimized-jupiter-bot',
      watch: false,
      autorestart: true,
      max_restarts: 100,
      env: {
        NODE_ENV: 'production',
      }
    },
    {
      name: 'pcp-overview',
      script: 'node',
      args: '-r ts-node/register/transpile-only scripts/maintain/overview_server.ts',
      cwd: 'optimized-jupiter-bot',
      watch: false,
      autorestart: true,
      max_restarts: 100,
      env: {
        NODE_ENV: 'production',
      }
    }
  ]
};
