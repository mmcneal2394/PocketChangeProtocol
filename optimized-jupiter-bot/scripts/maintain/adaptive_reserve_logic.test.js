const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveAdaptiveReserve } = require('./adaptive_reserve_logic.ts');

test('preserves configured reserve when balance already clears probe plus fees', () => {
  const result = resolveAdaptiveReserve(
    {
      nativeSol: 1.2,
      configuredReserveSol: 0.79,
      desiredDeploySol: 0.001,
    },
    {
      enabled: true,
      minReserveSol: 0.25,
      feeBufferSol: 0.0004,
    },
  );

  assert.equal(result.wasClamped, false);
  assert.equal(result.effectiveReserveSol, 0.79);
  assert.ok(result.deployableSol > 0.001);
});

test('clamps reserve just enough to preserve one micro probe when balance falls below configured reserve', () => {
  const result = resolveAdaptiveReserve(
    {
      nativeSol: 0.604610219,
      configuredReserveSol: 0.79,
      desiredDeploySol: 0.001,
    },
    {
      enabled: true,
      minReserveSol: 0.25,
      feeBufferSol: 0.0004,
    },
  );

  assert.equal(result.wasClamped, true);
  assert.ok(result.effectiveReserveSol < 0.79);
  assert.ok(result.deployableSol >= 0.0014 - 1e-9);
});

test('never clamps below the hard reserve floor', () => {
  const result = resolveAdaptiveReserve(
    {
      nativeSol: 0.2509,
      configuredReserveSol: 0.79,
      desiredDeploySol: 0.001,
    },
    {
      enabled: true,
      minReserveSol: 0.25,
      feeBufferSol: 0.0004,
    },
  );

  assert.equal(result.effectiveReserveSol, 0.25);
  assert.ok(result.deployableSol < 0.0014);
});

test('disabled adaptive reserve leaves the original reserve untouched', () => {
  const result = resolveAdaptiveReserve(
    {
      nativeSol: 0.5,
      configuredReserveSol: 0.79,
      desiredDeploySol: 0.001,
    },
    {
      enabled: false,
      minReserveSol: 0.25,
      feeBufferSol: 0.0004,
    },
  );

  assert.equal(result.wasClamped, false);
  assert.equal(result.effectiveReserveSol, 0.79);
  assert.equal(result.deployableSol, 0);
});
