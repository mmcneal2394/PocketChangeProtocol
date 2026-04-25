#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const cwd = process.cwd();
  const researcherPath = path.join(cwd, '.swarm', 'hermes', 'researcher', 'last_output.json');
  const builderPath = path.join(cwd, '.swarm', 'hermes', 'builder', 'last_output.json');
  const outDir = path.join(cwd, '.swarm', 'hermes', 'writer');
  fs.mkdirSync(outDir, { recursive: true });

  const researcher = readJson(researcherPath);
  const builder = readJson(builderPath);
  if (!researcher || !builder) {
    console.error('[HERMES_WRITER] missing researcher or builder output');
    process.exit(1);
  }

  const timestamp = new Date().toISOString();
  const lines = [
    `### ${timestamp}`,
    `- Pool: ${researcher.pool_name || 'unknown'} (${researcher.pool_address || 'n/a'})`,
    `- APY: ${researcher.apy ?? 'n/a'} | TVL USD: ${researcher.tvl_usd ?? 'n/a'}`,
    `- Wallet: ${Number(researcher.balance_sol || 0).toFixed(6)} SOL | ${Number(researcher.balance_usdc || 0).toFixed(6)} USDC`,
    `- Rebalance action: ${researcher.rebalance_action}`,
    `- Builder status: ${builder.micro_status}`,
    `- Tx: ${builder.tx_signature || 'none'}`,
  ];

  const operatorLogPath = path.join(cwd, 'notes', 'operator_log.md');
  const priorLog = fs.existsSync(operatorLogPath) ? fs.readFileSync(operatorLogPath, 'utf8') : '';
  fs.writeFileSync(operatorLogPath, `${lines.join('\n')}\n\n${priorLog}`, 'utf8');

  const verifyPath = path.join(cwd, 'reports', 'verify-upgrades.json');
  const verify = readJson(verifyPath) || {};
  verify.last_run = timestamp;
  verify.summary = `Hermes writer recorded ${researcher.rebalance_action} with builder status ${builder.micro_status}`;
  fs.writeFileSync(verifyPath, JSON.stringify(verify, null, 2), 'utf8');

  const payload = {
    timestamp,
    operator_log: operatorLogPath,
    verify_report: verifyPath,
    summary: verify.summary,
  };
  const outPath = path.join(outDir, 'last_output.json');
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify(payload, null, 2));
}

main();
