const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeVelocityMintData,
  normalizeVelocitySnapshot,
} = require('./velocity_snapshot_logic.ts');

test('normalizeVelocityMintData defaults synthetic rows into refinement mode', () => {
  const row = normalizeVelocityMintData('MintA', {
    isSynthetic: true,
    syntheticSource: 'composite-trending',
  });

  assert.equal(row.isSynthetic, true);
  assert.equal(row.refinementOnly, true);
  assert.equal(row.syntheticSource, 'composite-trending');
});

test('normalizeVelocityMintData keeps real rows executable by default', () => {
  const row = normalizeVelocityMintData('MintB', {
    buys60s: 5,
    isSynthetic: false,
  });

  assert.equal(row.isSynthetic, false);
  assert.equal(row.refinementOnly, false);
  assert.equal(row.syntheticSource, null);
});

test('normalizeVelocitySnapshot normalizes every row in a snapshot', () => {
  const snapshot = normalizeVelocitySnapshot({
    updatedAt: 123,
    mints: {
      MintA: { isSynthetic: true },
      MintB: { isSynthetic: false, refinementOnly: false },
    },
  });

  assert(snapshot);
  assert.equal(snapshot.mints.MintA.refinementOnly, true);
  assert.equal(snapshot.mints.MintB.refinementOnly, false);
});
