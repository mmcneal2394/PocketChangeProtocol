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
      name: 'live-arbitrage-engine',
      script: 'node',
      args: 'scripts/live_arbitrage_engine.mjs',
      watch: false,
      autorestart: true,
      max_restarts: 100,
      env: {
        NODE_ENV: 'production',
      }
    }
  ]
};
