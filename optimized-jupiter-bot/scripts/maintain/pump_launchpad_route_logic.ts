type PumpLaunchpadRouteBypassInput = {
  launchpad?: string | null;
  standard?: string | null;
  routeRoutable?: boolean | null;
  routeOutAmount?: string | number | null;
};

type PumpLaunchpadRouteBypassDecision = {
  allowBypass: boolean;
  reason: string | null;
};

function normalizeText(value: any): string {
  return String(value ?? '').trim().toLowerCase();
}

function parsePositiveNumber(value: any): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function evaluatePumpLaunchpadRouteBypass(
  input: PumpLaunchpadRouteBypassInput,
): PumpLaunchpadRouteBypassDecision {
  const launchpad = normalizeText(input.launchpad);
  const standard = normalizeText(input.standard);
  const routeOutAmount = parsePositiveNumber(input.routeOutAmount);

  if (!input.routeRoutable || routeOutAmount <= 0) {
    return { allowBypass: false, reason: 'route-unavailable' };
  }

  if (!launchpad.includes('pump')) {
    return { allowBypass: false, reason: 'not-pump-launchpad' };
  }

  if (standard.includes('mayhem')) {
    return { allowBypass: false, reason: 'pump-mayhem-standard' };
  }

  return { allowBypass: true, reason: 'pump-bonding-curve-routable' };
}

module.exports = {
  evaluatePumpLaunchpadRouteBypass,
};
