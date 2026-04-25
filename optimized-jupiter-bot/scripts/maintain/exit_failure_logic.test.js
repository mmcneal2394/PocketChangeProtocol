const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyExitSwapFailure,
  resolveExitRetryCooldownMs,
} = require('./exit_failure_logic.ts');

test('classifyExitSwapFailure detects overflow-style route failures', () => {
  const meta = classifyExitSwapFailure({
    simulationErr: { InstructionError: [3, { Custom: 6024 }] },
    simulationLogs: ['Program log: AnchorError thrown. Error Number: 6024. Error Message: Overflow.'],
  });

  assert.equal(meta.category, 'route_overflow');
  assert.equal(meta.code, 6024);
  assert.equal(meta.cooldownMs, 15 * 60_000);
});

test('classifyExitSwapFailure detects slippage-style route failures', () => {
  const meta = classifyExitSwapFailure({
    statusErr: { InstructionError: [3, { Custom: 6001 }] },
    message: 'custom program error: 0x1771',
  });

  assert.equal(meta.category, 'route_slippage');
  assert.equal(meta.code, 6001);
  assert.equal(meta.cooldownMs, 10 * 60_000);
});

test('resolveExitRetryCooldownMs escalates repeated route failures but caps them', () => {
  const meta = { category: 'route_overflow', code: 6024, detail: 'overflow', retryable: true, cooldownMs: 15 * 60_000 };

  assert.equal(resolveExitRetryCooldownMs(meta, 1, 120_000), 15 * 60_000);
  assert.equal(resolveExitRetryCooldownMs(meta, 2, 120_000), 22.5 * 60_000);
  assert.equal(resolveExitRetryCooldownMs(meta, 5, 120_000), 45 * 60_000);
});
