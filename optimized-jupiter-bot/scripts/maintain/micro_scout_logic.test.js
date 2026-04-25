const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluateNoDexMicroScoutProbe } = require('./micro_scout_logic.ts');

const baseConfig = {
  minRawBuys60s: 8,
  minRawBuyRatio60s: 0.7,
  minRawSolVolume60s: 1,
  minVelocity: 8,
};

test('evaluateNoDexMicroScoutProbe arms on moderate fresh-launch flow without DEX data', () => {
  const result = evaluateNoDexMicroScoutProbe({
    buys60s: 8,
    sells60s: 0,
    buyRatio60s: 1,
    velocity: 8,
    solVolume60s: 1.3,
  }, baseConfig);

  assert.equal(result.shouldScout, true);
  assert.equal(result.rawVelocityException, true);
  assert.equal(result.limitingReason, 'raw_velocity_exception');
});

test('evaluateNoDexMicroScoutProbe allows whale-flow exceptions slightly below the raw buy floor', () => {
  const result = evaluateNoDexMicroScoutProbe({
    buys60s: 7,
    sells60s: 0,
    buyRatio60s: 1,
    velocity: 7,
    solVolume60s: 3.2,
  }, baseConfig);

  assert.equal(result.shouldScout, true);
  assert.equal(result.rawVelocityException, false);
  assert.equal(result.whaleFlowException, true);
  assert.equal(result.limitingReason, 'whale_flow_exception');
});

test('evaluateNoDexMicroScoutProbe rejects weak no-DEX bursts cleanly', () => {
  const result = evaluateNoDexMicroScoutProbe({
    buys60s: 5,
    sells60s: 1,
    buyRatio60s: 0.6,
    velocity: 6,
    solVolume60s: 0.4,
  }, baseConfig);

  assert.equal(result.shouldScout, false);
  assert.equal(result.rawVelocityException, false);
  assert.equal(result.whaleFlowException, false);
  assert.equal(result.limitingReason, 'buys_below_floor');
});
