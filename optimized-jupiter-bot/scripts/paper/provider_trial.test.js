const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reserve, unwrapGmgn, MONTH_CAP, DAY_CAP } = require('./provider_trial');
test('reservation preserves previous spend and charges failed attempts conservatively', () => {
  assert.deepEqual(reserve([{ at: 100, cost: 1 }], 200, 1), [{ at: 100, cost: 1 }, { at: 200, cost: 1 }]);
});
test('daily and monthly ceilings reject before requests', () => {
  assert.throws(() => reserve([{ at: 100, cost: DAY_CAP }], 200, 1));
  assert.throws(() => reserve([{ at: 100, cost: MONTH_CAP }], 86400200, 1));
});
test('corrupt accounting and future reservations fail closed', () => {
  assert.throws(() => reserve([{ at: 300, cost: 1 }], 200, 1));
  assert.throws(() => reserve([], 200, NaN));
  assert.throws(() => reserve({}, 200, 1));
});
test('nested GMGN failure cannot become successful market evidence', () => {
  assert.throws(() => unwrapGmgn({ code: 0, data: { code: 403 } }));
  assert.deepEqual(unwrapGmgn({ code: 0, data: { code: 0, data: { rank: [] } } }), []);
});
