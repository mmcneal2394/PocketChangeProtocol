const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeSpendableNativeBalance,
  MIN_NATIVE_SOL_RESERVE,
} = require('../../src/utils/native_sol_balance.ts');

test('computeSpendableNativeBalance preserves a native SOL reserve', () => {
  const snapshot = computeSpendableNativeBalance(1.5e9, 0.05);
  assert.equal(snapshot.nativeSol, 1.5);
  assert.equal(snapshot.totalSol, 1.5);
  assert.equal(snapshot.reserveSol, 0.05);
  assert.equal(snapshot.spendableSol, 1.45);
});

test('computeSpendableNativeBalance never returns negative spendable SOL', () => {
  const snapshot = computeSpendableNativeBalance(0.01 * 1e9, MIN_NATIVE_SOL_RESERVE);
  assert.equal(snapshot.nativeSol, 0.01);
  assert.equal(snapshot.spendableSol, 0);
});
