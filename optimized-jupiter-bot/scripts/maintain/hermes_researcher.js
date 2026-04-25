#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function fail(message) {
  console.error(`[HERMES_RESEARCHER] ${message}`);
  process.exit(1);
}

function main() {
  const cwd = process.cwd();
  const outDir = path.join(cwd, '.swarm', 'hermes', 'researcher');
  fs.mkdirSync(outDir, { recursive: true });

  const result = spawnSync('node scripts/maintain/run_yield_cycle.js', {
    cwd,
    shell: true,
    env: { ...process.env, YIELD_FORCE_NO_SEND: 'true' },
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
  const warnings = [];
  if (report.inspection?.status !== 'ok') warnings.push(`inspection:${report.inspection?.status || 'missing'}`);
  if (report.walletRebalance?.status !== 'ok') warnings.push(`walletRebalance:${report.walletRebalance?.status || 'missing'}`);

  const payload = {
    timestamp: new Date().toISOString(),
    pool_address: report.inspection?.poolAddress || null,
    pool_name: report.inspection?.poolName || null,
    apy: report.inspection?.apy ?? null,
    tvl_usd: report.inspection?.tvl ?? null,
    balance_sol: report.walletInventory?.nativeSol?.sol ?? null,
    balance_usdc: report.walletInventory?.quote?.uiAmount ?? null,
    position_detected: report.inspection?.positionSummary?.selectedPoolPositionDetected === true,
    rebalance_action: report.walletRebalance?.action || 'unknown',
    confidence: warnings.length === 0 ? 'high' : 'medium',
    warnings,
    source_report: reportPath,
  };

  const outPath = path.join(outDir, 'last_output.json');
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify(payload, null, 2));
}

main();
