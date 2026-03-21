module.exports = {
  apps: [{
    name: "jupiter-ultra-bot",
    script: "scripts/run_1min.ts",
    interpreter: "node",
    interpreter_args: "--require ts-node/register",
    env: {
      NODE_ENV: "production"
    }
  }]
};
