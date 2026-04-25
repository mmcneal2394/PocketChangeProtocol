#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const outputPath = path.join(process.cwd(), '.swarm', 'orchestrator', 'last_cycle.json');
if (!fs.existsSync(outputPath)) {
  console.error(`[ORCH_VALIDATOR] missing ${outputPath}`);
  process.exit(1);
}
const payload = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
if (!payload.timestamp || !Array.isArray(payload.tasks_dispatched) || typeof payload.all_succeeded !== 'boolean') {
  console.error('[ORCH_VALIDATOR] invalid payload shape');
  process.exit(1);
}
if (!payload.orchestration_outcome || !['success', 'hold', 'failure'].includes(payload.orchestration_outcome)) {
  console.error('[ORCH_VALIDATOR] missing or invalid orchestration_outcome');
  process.exit(1);
}
if (!payload.all_succeeded && payload.orchestration_outcome !== 'failure') {
  console.error('[ORCH_VALIDATOR] all_succeeded drifted from orchestration_outcome');
  process.exit(1);
}
if (payload.orchestration_outcome === 'failure') {
  console.error('[ORCH_VALIDATOR] orchestration reported failure');
  process.exit(1);
}
console.log('ORCHESTRATOR_OUTPUT_VALID');
