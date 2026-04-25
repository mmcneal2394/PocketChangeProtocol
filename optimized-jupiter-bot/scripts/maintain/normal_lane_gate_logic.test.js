require('ts-node/register/transpile-only');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isExecutableLivePair,
  shouldAllowNormalLaneApexMarketCapBypass,
  shouldApplyNormalLaneMomentumFloor,
} = require('./normal_lane_gate_logic.ts');

test('isExecutableLivePair rejects zero-liquidity pairs', () => {
  assert.equal(isExecutableLivePair({ liquidity: 0 }), false);
  assert.equal(isExecutableLivePair({ liquidity: null }), false);
});

test('isExecutableLivePair accepts positive-liquidity pairs', () => {
  assert.equal(isExecutableLivePair({ liquidity: 1 }), true);
  assert.equal(isExecutableLivePair({ liquidity: 5000 }), true);
});

test('shouldAllowNormalLaneApexMarketCapBypass blocks giant-cap overlay bypasses', () => {
  assert.equal(
    shouldAllowNormalLaneApexMarketCapBypass({
      marketCapUsd: 20000000,
      overlayMaxMarketCapUsd: 3500000,
      apexSupportsAggressiveOverlay: true,
    }),
    false,
  );
});

test('shouldAllowNormalLaneApexMarketCapBypass allows capped overlay bypasses', () => {
  assert.equal(
    shouldAllowNormalLaneApexMarketCapBypass({
      marketCapUsd: 2500000,
      overlayMaxMarketCapUsd: 3500000,
      apexSupportsAggressiveOverlay: true,
    }),
    true,
  );
});

test('shouldApplyNormalLaneMomentumFloor can bypass duplicate velocity gating', () => {
  assert.equal(
    shouldApplyNormalLaneMomentumFloor({
      entryMode: 'normal',
      bypassNormalMomentumFloor: true,
    }),
    false,
  );
  assert.equal(
    shouldApplyNormalLaneMomentumFloor({
      entryMode: 'normal',
      bypassNormalMomentumFloor: false,
    }),
    true,
  );
});
