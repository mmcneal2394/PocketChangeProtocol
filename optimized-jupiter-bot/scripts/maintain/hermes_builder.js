#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function fail(message) {
  console.error(`[HERMES_BUILDER] ${message}`);
  process.exit(1);
}

function main() {
  const cwd = process.cwd();
  const outDir = path.join(cwd, '.swarm', 'hermes', 'builder');
  fs.mkdirSync(outDir, { recursive: true });

  const result = spawnSync('node scripts/maintain/run_yield_cycle.js', {
    cwd,
    shell: true,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    fail(`run_yield_cycle failed with exit code ${result.status}`);
  }

  const reportPath = path.join(cwd, '.swarm', 'yield-cycle', 'latest-cycle.json');
  if (!fs.existsSync(reportPath)) {
    fail(`missing yield report: ${reportPath}`);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const micro = report.microTransaction || {};
  const payload = {
    timestamp: new Date().toISOString(),
    action: report.walletRebalance?.action || 'unknown',
    micro_status: micro.status || 'missing',
    tx_signature: micro.signature || null,
    simulation_success: micro.simulation ? micro.simulation.err == null : null,
    fee_paid_lamports: micro.swapBuild?.prioritizationFeeLamports ?? null,
    source_report: reportPath,
  };

  const outPath = path.join(outDir, 'last_output.json');
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify(payload, null, 2));
}

main();
