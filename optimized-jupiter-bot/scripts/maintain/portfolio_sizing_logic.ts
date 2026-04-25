type MaybeNumber = number | null | undefined;

function toFiniteNumber(value: MaybeNumber, fallback = 0): number {
  return Number.isFinite(value) ? Number(value) : fallback;
}

function clampNumber(value: MaybeNumber, fallback: number, min: number, max: number): number {
  const parsed = toFiniteNumber(value, fallback);
  return Math.min(max, Math.max(min, parsed));
}

export interface PortfolioSizingInput {
  deployableSol?: MaybeNumber;
  fixedBuySol?: MaybeNumber;
  portfolioSizingEnabled?: boolean | null;
  portfolioFraction?: MaybeNumber;
  currentOpenPositions?: MaybeNumber;
  maxOpenPositions?: MaybeNumber;
  minDeploySol?: MaybeNumber;
  maxDeploySol?: MaybeNumber;
}

export interface PortfolioSizingDecision {
  sizingMode: 'fixed' | 'portfolio';
  desiredBuySol: number;
  minDeploySol: number;
  portfolioFraction: number;
  remainingSlots: number;
}

export function resolvePortfolioSizedBuy(input: PortfolioSizingInput): PortfolioSizingDecision {
  const deployableSol = Math.max(0, toFiniteNumber(input.deployableSol, 0));
  const fixedBuySol = Math.max(0, toFiniteNumber(input.fixedBuySol, 0));
  const minDeploySol = Math.max(0, toFiniteNumber(input.minDeploySol, fixedBuySol));
  const portfolioFraction = clampNumber(input.portfolioFraction, 1, 0.01, 1);
  const maxDeploySol = Math.max(0, toFiniteNumber(input.maxDeploySol, 0));
  const currentOpenPositions = Math.max(0, Math.round(toFiniteNumber(input.currentOpenPositions, 0)));
  const maxOpenPositions = Math.max(1, Math.round(toFiniteNumber(input.maxOpenPositions, 1)));
  const remainingSlots = Math.max(0, maxOpenPositions - currentOpenPositions);

  if (input.portfolioSizingEnabled !== true) {
    return {
      sizingMode: 'fixed',
      desiredBuySol: Math.min(deployableSol, fixedBuySol),
      minDeploySol,
      portfolioFraction,
      remainingSlots,
    };
  }

  if (remainingSlots <= 0) {
    return {
      sizingMode: 'portfolio',
      desiredBuySol: 0,
      minDeploySol,
      portfolioFraction,
      remainingSlots,
    };
  }

  let desiredBuySol = deployableSol * (portfolioFraction / remainingSlots);
  if (maxDeploySol > 0) {
    desiredBuySol = Math.min(desiredBuySol, maxDeploySol);
  }

  return {
    sizingMode: 'portfolio',
    desiredBuySol: Math.min(deployableSol, Math.max(0, desiredBuySol)),
    minDeploySol,
    portfolioFraction,
    remainingSlots,
  };
}
