const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeEntryRejectCooldownConfig,
  isStrongFlowRejectContext,
  getEntryRejectCooldownSeconds,
} = require('./entry_reject_cooldown_logic.ts');

test('normalizeEntryRejectCooldownConfig provides defaults', () => {
  const config = normalizeEntryRejectCooldownConfig({});
  assert.equal(config.enabled, true);
  assert.equal(config.buyRatioCooldownSeconds, 12);
  assert.equal(config.buysBelowCooldownSeconds, 10);
  assert.equal(config.strongFlowBuyRatioCooldownSeconds, 6);
  assert.equal(config.strongFlowBuysBelowCooldownSeconds, 5);
});

test('isStrongFlowRejectContext detects strong live flow', () => {
  const config = normalizeEntryRejectCooldownConfig({});
  assert.equal(
    isStrongFlowRejectContext({ buys60s: 8, solVolume60s: 1.5, velocity: 8 }, config),
    true,
  );
  assert.equal(
    isStrongFlowRejectContext({ buys60s: 7, solVolume60s: 1.5, velocity: 8 }, config),
    false,
  );
});

test('getEntryRejectCooldownSeconds shortens buy-ratio cooldown for strong flow', () => {
  const config = normalizeEntryRejectCooldownConfig({});
  assert.equal(
    getEntryRejectCooldownSeconds(
      'buy_ratio',
      { buys60s: 12, solVolume60s: 2.1, velocity: 9 },
      config,
    ),
    6,
  );
  assert.equal(
    getEntryRejectCooldownSeconds(
      'buy_ratio',
      { buys60s: 3, solVolume60s: 0.4, velocity: 2 },
      config,
    ),
    12,
  );
});

test('getEntryRejectCooldownSeconds shortens low-buy cooldown for strong flow', () => {
  const config = normalizeEntryRejectCooldownConfig({});
  assert.equal(
    getEntryRejectCooldownSeconds(
      'buys_below_threshold',
      { buys60s: 9, solVolume60s: 1.8, velocity: 8 },
      config,
    ),
    5,
  );
  assert.equal(
    getEntryRejectCooldownSeconds(
      'buys_below_threshold',
      { buys60s: 4, solVolume60s: 0.8, velocity: 4 },
      config,
    ),
    10,
  );
});

test('disabled config returns zero cooldown', () => {
  const config = normalizeEntryRejectCooldownConfig({ enabled: false });
  assert.equal(
    getEntryRejectCooldownSeconds(
      'buy_ratio',
      { buys60s: 12, solVolume60s: 2.1, velocity: 9 },
      config,
    ),
    0,
  );
});
