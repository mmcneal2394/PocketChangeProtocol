#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { deriveYieldEconomicResultFromReport } = require('./maintain/wiggum_economic_logic');

function fail(message) {
  console.error(`[YIELD_VALIDATOR] ${message}`);
  process.exit(1);
}

function main() {
  const reportPath = path.join(process.cwd(), '.swarm', 'yield-cycle', 'latest-cycle.json');
  if (!fs.existsSync(reportPath)) {
    fail(`Missing report: ${reportPath}`);
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const required = [
    report.generatedAt,
    report.strategyId,
    report.mode,
    report.wallet,
    report.execution?.status,
    report.outcome,
    report.outcomeCode,
    report.economicAcceptance?.status,
    report.economicAcceptance?.orchestrationOutcome,
  ];
  if (required.some((value) => !value)) {
    fail('Yield cycle report is missing required fields');
  }

  const acceptableStatus = new Set([
    'dry-run',
    'dry-run-simulated',
    'dry-run-alpha-armed',
    'live-sent',
    'live-ready-to-send',
    'live-alpha-armed',
    'live-skipped-unprofitable',
    'live-blocked',
    'live-monitoring',
    'live-failed',
  ]);
  if (!acceptableStatus.has(report.execution.status)) {
    fail(`Unexpected execution status: ${report.execution.status}`);
  }

  if (!report.inspection || !report.inspection.status) {
    fail('Yield cycle report is missing inspection output');
  }

  const acceptableInspection = new Set(['ok', 'fetch-failed', 'pool-not-found']);
  if (!acceptableInspection.has(report.inspection.status)) {
    fail(`Unexpected inspection status: ${report.inspection.status}`);
  }

  if (report.inspection.status === 'ok') {
    if (!report.inspection.poolAddress) fail('Inspection marked ok but no pool address was recorded');
    if (!report.inspection.walletPosition || !report.inspection.walletPosition.status) fail('Inspection marked ok but wallet position signal is missing');
    if (!report.inspection.onChainPosition || !report.inspection.onChainPosition.status) fail('Inspection marked ok but on-chain position signal is missing');
    if (!report.inspection.positionSummary) fail('Inspection marked ok but position summary is missing');
  }

  if (!report.walletInventory || !report.walletRebalance || !report.walletRebalance.action) {
    fail('Yield cycle report is missing wallet inventory or rebalance output');
  }

  if (!report.microTransaction || !report.microTransaction.status) {
    fail('Yield cycle report is missing microtransaction output');
  }

  if (report.alphaSignal) {
    const acceptableAlphaStatus = new Set(['not-run', 'not-enabled', 'ok', 'insufficient-data', 'fetch-failed']);
    if (!acceptableAlphaStatus.has(report.alphaSignal.status)) {
      fail(`Unexpected alpha signal status: ${report.alphaSignal.status}`);
    }
  }

  if (report.alphaReadiness) {
    const acceptableAlphaReadinessStatus = new Set(['ok', 'not-enabled', 'insufficient-data']);
    if (!acceptableAlphaReadinessStatus.has(report.alphaReadiness.status)) {
      fail(`Unexpected alpha readiness status: ${report.alphaReadiness.status}`);
    }
    if (typeof report.alphaReadiness.ready !== 'boolean') {
      fail('Alpha readiness is missing boolean ready flag');
    }
  }

  if (report.alphaReadinessHistory) {
    if (!Number.isFinite(report.alphaReadinessHistory.consecutiveReadyCycles)) {
      fail('Alpha readiness history is missing consecutiveReadyCycles');
    }
    if (!Number.isFinite(report.alphaReadinessHistory.averageScoreLast10)) {
      fail('Alpha readiness history is missing averageScoreLast10');
    }
  }

  if (report.alphaExecution) {
    const acceptableAlphaExecutionStatus = new Set(['armed', 'blocked']);
    if (!acceptableAlphaExecutionStatus.has(report.alphaExecution.status)) {
      fail(`Unexpected alpha execution status: ${report.alphaExecution.status}`);
    }
    if (typeof report.alphaExecution.ready !== 'boolean') {
      fail('Alpha execution is missing boolean ready flag');
    }
  }

  if (report.alphaPromotion) {
    const acceptableAlphaPromotionStatus = new Set(['ok', 'not-enabled']);
    if (!acceptableAlphaPromotionStatus.has(report.alphaPromotion.status)) {
      fail(`Unexpected alpha promotion status: ${report.alphaPromotion.status}`);
    }
    if (typeof report.alphaPromotion.eligible !== 'boolean') {
      fail('Alpha promotion is missing boolean eligible flag');
    }
  }

  if (report.alphaSafety) {
    const acceptableAlphaSafetyStatus = new Set(['ok', 'tripped']);
    if (!acceptableAlphaSafetyStatus.has(report.alphaSafety.status)) {
      fail(`Unexpected alpha safety status: ${report.alphaSafety.status}`);
    }
  }

  const acceptableMicroStatus = new Set(['not-configured', 'not-needed', 'blocked', 'simulated-only', 'ready-to-send', 'sent', 'send-failed', 'simulation-failed', 'probe-error', 'skipped-unprofitable']);
  if (!acceptableMicroStatus.has(report.microTransaction.status)) {
    fail(`Unexpected microtransaction status: ${report.microTransaction.status}`);
  }

  const acceptableEconomicStatus = new Set([
    'acceptable-profitable',
    'acceptable-maintenance',
    'acceptable-live-ready',
    'acceptable-alpha-live',
    'dry-run',
    'dry-run-simulated',
    'dry-run-alpha-armed',
    'hold-unprofitable',
    'hold-blocked',
    'hold-low-balance',
    'hold-no-action-needed',
    'hold-monitoring',
    'hold-risk-tripped',
    'technical-failure',
  ]);
  if (!acceptableEconomicStatus.has(report.economicAcceptance.status)) {
    fail(`Unexpected economic acceptance status: ${report.economicAcceptance.status}`);
  }

  const acceptableOrchestration = new Set(['success', 'hold', 'failure']);
  if (!acceptableOrchestration.has(report.economicAcceptance.orchestrationOutcome)) {
    fail(`Unexpected economic orchestration outcome: ${report.economicAcceptance.orchestrationOutcome}`);
  }

  if (typeof report.economicAcceptance.acceptableForLive !== 'boolean') {
    fail('Economic acceptance is missing boolean acceptableForLive');
  }

  const derived = deriveYieldEconomicResultFromReport(report);
  if (report.execution.status !== derived.executionStatus) {
    fail(`Execution status drifted from derived state: ${report.execution.status} !== ${derived.executionStatus}`);
  }
  if (report.outcomeCode !== derived.outcomeCode) {
    fail(`Outcome code drifted from derived state: ${report.outcomeCode} !== ${derived.outcomeCode}`);
  }
  if (report.outcome !== derived.outcome) {
    fail(`Outcome text drifted from derived state: ${report.outcome}`);
  }
  if (report.economicAcceptance.status !== derived.economicAcceptance.status) {
    fail(`Economic status drifted from derived state: ${report.economicAcceptance.status} !== ${derived.economicAcceptance.status}`);
  }
  if (report.economicAcceptance.orchestrationOutcome !== derived.economicAcceptance.orchestrationOutcome) {
    fail(`Economic orchestration drifted from derived state: ${report.economicAcceptance.orchestrationOutcome} !== ${derived.economicAcceptance.orchestrationOutcome}`);
  }

  console.log('YIELD_CYCLE_VALID');
}

main();
