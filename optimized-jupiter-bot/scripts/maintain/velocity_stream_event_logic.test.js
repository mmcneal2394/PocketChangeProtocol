const test = require('node:test');
const assert = require('node:assert/strict');

const { hasVelocitySwapSignal } = require('./velocity_stream_event_logic.ts');

test('hasVelocitySwapSignal ignores initialize-only logs', () => {
  assert.equal(hasVelocitySwapSignal([
    'Program log: Instruction: InitializeMint2',
    'Program log: Initialize',
  ]), false);
});

test('hasVelocitySwapSignal accepts explicit buy and sell instructions', () => {
  assert.equal(hasVelocitySwapSignal([
    'Program log: Instruction: Buy',
  ]), true);
  assert.equal(hasVelocitySwapSignal([
    'Program log: Instruction: Sell',
  ]), true);
});

test('hasVelocitySwapSignal accepts swap logs', () => {
  assert.equal(hasVelocitySwapSignal([
    'Program log: Swap',
  ]), true);
});
