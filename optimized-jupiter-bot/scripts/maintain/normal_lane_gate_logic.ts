function toFiniteNumber(value: any): number | null {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isExecutableLivePair(pair?: { liquidity?: number | null } | null): boolean {
  const liquidityUsd = toFiniteNumber(pair?.liquidity);
  return liquidityUsd !== null && liquidityUsd > 0;
}

function shouldAllowNormalLaneApexMarketCapBypass(input: {
  marketCapUsd?: number | null;
  overlayMaxMarketCapUsd?: number | null;
  apexSupportsAggressiveOverlay?: boolean | null;
}): boolean {
  const marketCapUsd = toFiniteNumber(input.marketCapUsd);
  const overlayMaxMarketCapUsd = toFiniteNumber(input.overlayMaxMarketCapUsd);
  if (!input.apexSupportsAggressiveOverlay) return false;
  if (marketCapUsd === null || marketCapUsd <= 0) return false;
  if (overlayMaxMarketCapUsd === null || overlayMaxMarketCapUsd <= 0) return false;
  return marketCapUsd <= overlayMaxMarketCapUsd;
}

function shouldApplyNormalLaneMomentumFloor(input: {
  entryMode?: string | null;
  bypassNormalMomentumFloor?: boolean | null;
}): boolean {
  return input.entryMode === 'normal' && !input.bypassNormalMomentumFloor;
}

module.exports = {
  isExecutableLivePair,
  shouldAllowNormalLaneApexMarketCapBypass,
  shouldApplyNormalLaneMomentumFloor,
};

export {};
