const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeSpendableNativeBalance,
  getCachedNativeBalanceLamports,
  MIN_NATIVE_SOL_RESERVE,
  rememberNativeBalanceLamports,
  resetNativeBalanceCacheForTests,
} = require('../../src/utils/native_sol_balance.ts');

test.beforeEach(() => {
  resetNativeBalanceCacheForTests();
});

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

test('native SOL cache preserves a fresh last-known balance', () => {
  rememberNativeBalanceLamports('wallet-1', 123456789, 1_000);
  assert.deepEqual(
    getCachedNativeBalanceLamports('wallet-1', 15_000, 4_000),
    { lamports: 123456789, ageMs: 3_000 },
  );
});

test('native SOL cache expires stale balance snapshots', () => {
  rememberNativeBalanceLamports('wallet-2', 987654321, 1_000);
  assert.equal(getCachedNativeBalanceLamports('wallet-2', 5_000, 7_001), null);
});
