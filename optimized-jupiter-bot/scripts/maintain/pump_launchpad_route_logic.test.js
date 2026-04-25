const test = require('node:test');
const assert = require('node:assert/strict');

const { evaluatePumpLaunchpadRouteBypass } = require('./pump_launchpad_route_logic.ts');

test('allows bypass for pump launchpad token with a real route', () => {
  const decision = evaluatePumpLaunchpadRouteBypass({
    launchpad: 'pump.fun',
    standard: 'spl',
    routeRoutable: true,
    routeOutAmount: '123456789',
  });

  assert.equal(decision.allowBypass, true);
  assert.equal(decision.reason, 'pump-bonding-curve-routable');
});

test('blocks bypass when route is missing or zeroed', () => {
  const decision = evaluatePumpLaunchpadRouteBypass({
    launchpad: 'pump.fun',
    standard: 'spl',
    routeRoutable: true,
    routeOutAmount: '0',
  });

  assert.equal(decision.allowBypass, false);
  assert.equal(decision.reason, 'route-unavailable');
});

test('blocks bypass for non-pump launchpads', () => {
  const decision = evaluatePumpLaunchpadRouteBypass({
    launchpad: 'raydium',
    standard: 'spl',
    routeRoutable: true,
    routeOutAmount: '42',
  });

  assert.equal(decision.allowBypass, false);
  assert.equal(decision.reason, 'not-pump-launchpad');
});

test('blocks bypass for mayhem-standard pump launches', () => {
  const decision = evaluatePumpLaunchpadRouteBypass({
    launchpad: 'pump.fun',
    standard: 'pump-mayhem',
    routeRoutable: true,
    routeOutAmount: '42',
  });

  assert.equal(decision.allowBypass, false);
  assert.equal(decision.reason, 'pump-mayhem-standard');
});
