#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { deriveOrchestratorResult } = require('./maintain/wiggum_economic_logic');

function runStep(label, command) {
  console.log(`[HERMES_ORCH] running ${label}`);
  const result = spawnSync(command, {
    cwd: process.cwd(),
    shell: true,
    env: process.env,
    stdio: 'inherit',
  });
  return result.status === 0;
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const cwd = process.cwd();
  const outDir = path.join(cwd, '.swarm', 'orchestrator');
  fs.mkdirSync(outDir, { recursive: true });

  const tasks = [];
  const results = [];

  tasks.push('research_strategy_state');
  results.push(runStep('researcher', 'node scripts/maintain/hermes_researcher.js'));

  tasks.push('execute_rebalance_if_needed');
  results.push(runStep('builder', 'node scripts/maintain/hermes_builder.js'));

  tasks.push('write_operator_log');
  results.push(runStep('writer', 'node scripts/maintain/hermes_writer.js'));

  const researcher = readJson(path.join(cwd, '.swarm', 'hermes', 'researcher', 'last_output.json'));
  const builder = readJson(path.join(cwd, '.swarm', 'hermes', 'builder', 'last_output.json'));
  const writer = readJson(path.join(cwd, '.swarm', 'hermes', 'writer', 'last_output.json'));
  const yieldReport = readJson(path.join(cwd, '.swarm', 'yield-cycle', 'latest-cycle.json'));

  const allSucceeded = results.every(Boolean) && Boolean(researcher && builder && writer);
  const orchestration = deriveOrchestratorResult({
    allStepsSucceeded: allSucceeded,
    yieldReport,
    builderStatus: builder?.micro_status || null,
  });
  const payload = {
    timestamp: new Date().toISOString(),
    tasks_dispatched: tasks,
    all_succeeded: Boolean(allSucceeded),
    orchestration_outcome: orchestration.orchestrationOutcome,
    notes: {
      rebalance_action: researcher?.rebalance_action || null,
      builder_status: builder?.micro_status || null,
      economic_acceptance_status: orchestration.economicAcceptanceStatus,
      yield_execution_status: orchestration.yieldExecutionStatus,
      yield_outcome_code: orchestration.yieldOutcomeCode,
      yield_outcome: orchestration.yieldOutcome,
      yield_net_gain_lamports: orchestration.netGainLamports,
      economically_acceptable_live_action: orchestration.acceptableForLive,
      writer_summary: writer?.summary || null,
    },
  };

  const outPath = path.join(outDir, 'last_cycle.json');
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(JSON.stringify(payload, null, 2));
  if (payload.orchestration_outcome === 'failure') process.exit(1);
}

main();
