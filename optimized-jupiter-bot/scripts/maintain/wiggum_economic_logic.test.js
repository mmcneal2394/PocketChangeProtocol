const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveYieldEconomicResult,
  deriveYieldEconomicResultFromReport,
  deriveOrchestratorResult,
} = require('./wiggum_economic_logic');

test('deriveYieldEconomicResult marks skipped-unprofitable cycles as hold', () => {
  const result = deriveYieldEconomicResult({
    executionEnabled: true,
    actionable: true,
    walletRebalance: { action: 'rebalance-quote-inventory' },
    microTransaction: {
      status: 'skipped-unprofitable',
      blockReason: 'negative-edge',
      profitability: { passes: false, reason: 'negative-edge', mode: 'alpha' },
    },
    alphaExecution: { status: 'blocked', ready: false, effectiveMode: 'paper' },
    alphaSafety: { status: 'ok' },
  });

  assert.equal(result.executionStatus, 'live-skipped-unprofitable');
  assert.equal(result.outcomeCode, 'live-skipped-unprofitable');
  assert.equal(result.economicAcceptance.status, 'hold-unprofitable');
  assert.equal(result.economicAcceptance.orchestrationOutcome, 'hold');
  assert.equal(result.economicAcceptance.acceptableForLive, false);
});

test('deriveYieldEconomicResult marks sent profitable cycles as success', () => {
  const result = deriveYieldEconomicResult({
    executionEnabled: true,
    actionable: true,
    walletRebalance: { action: 'rebalance-quote-inventory' },
    microTransaction: {
      status: 'sent',
      profitability: { passes: true, reason: 'edge-positive', mode: 'alpha' },
    },
    alphaExecution: { status: 'blocked', ready: false, effectiveMode: 'paper' },
    alphaSafety: { status: 'ok' },
  });

  assert.equal(result.executionStatus, 'live-sent');
  assert.equal(result.outcomeCode, 'live-sent-profitable');
  assert.equal(result.economicAcceptance.status, 'acceptable-profitable');
  assert.equal(result.economicAcceptance.orchestrationOutcome, 'success');
  assert.equal(result.economicAcceptance.acceptableForLive, true);
});

test('deriveYieldEconomicResult marks technical micro failures as failure', () => {
  const result = deriveYieldEconomicResult({
    executionEnabled: true,
    actionable: true,
    walletRebalance: { action: 'rebalance-quote-inventory' },
    microTransaction: {
      status: 'send-failed',
      error: 'rpc-timeout',
    },
    alphaExecution: { status: 'blocked', ready: false, effectiveMode: 'paper' },
    alphaSafety: { status: 'ok' },
  });

  assert.equal(result.executionStatus, 'live-failed');
  assert.equal(result.economicAcceptance.status, 'technical-failure');
  assert.equal(result.economicAcceptance.orchestrationOutcome, 'failure');
});

test('deriveYieldEconomicResult keeps dry-run simulated cycles as hold', () => {
  const result = deriveYieldEconomicResult({
    executionEnabled: false,
    actionable: true,
    walletRebalance: { action: 'rebalance-quote-inventory' },
    microTransaction: {
      status: 'simulated-only',
      profitability: { passes: true, reason: 'edge-positive', mode: 'alpha' },
    },
    alphaExecution: { status: 'blocked', ready: false, effectiveMode: 'paper' },
    alphaSafety: { status: 'ok' },
  });

  assert.equal(result.executionStatus, 'dry-run-simulated');
  assert.equal(result.economicAcceptance.status, 'dry-run-simulated');
  assert.equal(result.economicAcceptance.orchestrationOutcome, 'hold');
});

test('deriveYieldEconomicResultFromReport reproduces expected hold state from report shape', () => {
  const result = deriveYieldEconomicResultFromReport({
    execution: { executionEnabled: true, actionable: true },
    walletRebalance: { action: 'rebalance-quote-inventory' },
    microTransaction: {
      status: 'blocked',
      blockReason: 'reserve-would-be-breached',
    },
    alphaExecution: { status: 'blocked', ready: false, effectiveMode: 'paper' },
    alphaSafety: { status: 'ok' },
  });

  assert.equal(result.executionStatus, 'live-blocked');
  assert.equal(result.economicAcceptance.status, 'hold-blocked');
});

test('deriveOrchestratorResult preserves success/hold/failure semantics', () => {
  const hold = deriveOrchestratorResult({
    allStepsSucceeded: true,
    builderStatus: 'skipped-unprofitable',
    yieldReport: {
      execution: { executionEnabled: true, actionable: true },
      walletRebalance: { action: 'rebalance-quote-inventory' },
      microTransaction: {
        status: 'skipped-unprofitable',
        blockReason: 'negative-edge',
        profitability: { passes: false, reason: 'negative-edge', mode: 'alpha', netGainLamports: -5000 },
      },
      alphaExecution: { status: 'blocked', ready: false, effectiveMode: 'paper' },
      alphaSafety: { status: 'ok' },
    },
  });

  assert.equal(hold.orchestrationOutcome, 'hold');
  assert.equal(hold.economicAcceptanceStatus, 'hold-unprofitable');

  const success = deriveOrchestratorResult({
    allStepsSucceeded: true,
    builderStatus: 'sent',
    yieldReport: {
      execution: { executionEnabled: true, actionable: true },
      walletRebalance: { action: 'rebalance-quote-inventory' },
      microTransaction: {
        status: 'sent',
        profitability: { passes: true, reason: 'edge-positive', mode: 'alpha', netGainLamports: 12000 },
      },
      alphaExecution: { status: 'blocked', ready: false, effectiveMode: 'paper' },
      alphaSafety: { status: 'ok' },
    },
  });

  assert.equal(success.orchestrationOutcome, 'success');
  assert.equal(success.economicAcceptanceStatus, 'acceptable-profitable');

  const failure = deriveOrchestratorResult({
    allStepsSucceeded: false,
    builderStatus: 'probe-error',
    yieldReport: null,
  });

  assert.equal(failure.orchestrationOutcome, 'failure');
});
