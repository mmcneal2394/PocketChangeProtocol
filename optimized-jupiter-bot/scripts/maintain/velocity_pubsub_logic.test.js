const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyVelocityPubsubPayload } = require('./velocity_pubsub_logic.ts');

test('classifyVelocityPubsubPayload treats mint arrays as deltas', () => {
  const result = classifyVelocityPubsubPayload({ mints: ['MintA', 'MintB'] });
  assert.deepEqual(result, { kind: 'delta', spikeCount: 2 });
});

test('classifyVelocityPubsubPayload treats mint maps as snapshots', () => {
  const result = classifyVelocityPubsubPayload({ mints: { MintA: {}, MintB: {} } });
  assert.deepEqual(result, { kind: 'snapshot', spikeCount: 2 });
});

test('classifyVelocityPubsubPayload rejects invalid payloads', () => {
  const result = classifyVelocityPubsubPayload(null);
  assert.deepEqual(result, { kind: 'invalid', spikeCount: 0 });
});
