const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveWeakMomentumCooldownSeconds } = require('./weak_momentum_cooldown_logic.ts');

test('resolveWeakMomentumCooldownSeconds stretches flat gmgn missing-1m cooldowns', () => {
  const cooldownSeconds = resolveWeakMomentumCooldownSeconds({
    source: 'gmgn-bridge',
    momentum5m: 0,
    missingMomentum1m: true,
    defaultCooldownSeconds: 20,
  });

  assert.equal(cooldownSeconds, 90);
});

test('resolveWeakMomentumCooldownSeconds preserves default cooldown for non-flat or non-gmgn names', () => {
  assert.equal(
    resolveWeakMomentumCooldownSeconds({
      source: 'gmgn-bridge',
      momentum5m: 0.8,
      missingMomentum1m: true,
      defaultCooldownSeconds: 20,
    }),
    20,
  );
  assert.equal(
    resolveWeakMomentumCooldownSeconds({
      source: 'bags-swarm',
      momentum5m: 0,
      missingMomentum1m: true,
      defaultCooldownSeconds: 20,
    }),
    20,
  );
});
