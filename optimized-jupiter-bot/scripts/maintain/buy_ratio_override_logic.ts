type BuyRatioOverrideInput = {
  buyRatio?: number | null;
  reqRatio?: number | null;
  continuationApproved?: boolean;
  momentum1m?: number | null;
  buys1h?: number | null;
  volume1hUsd?: number | null;
  tokenAgeSec?: number | null;
  buys60s?: number | null;
  buyRatio60s?: number | null;
  velocity?: number | null;
  solVolume60s?: number | null;
};

export function shouldAllowBuyRatioOverride(input: BuyRatioOverrideInput): boolean {
  const buyRatio = Number(input.buyRatio || 0);
  const reqRatio = Number(input.reqRatio || 0);
  const momentum1m = Number(input.momentum1m);
  const buys1h = Number(input.buys1h || 0);
  const volume1hUsd = Number(input.volume1hUsd || 0);
  const tokenAgeSec = Number(input.tokenAgeSec || 0);
  const buys60s = Number(input.buys60s || 0);
  const buyRatio60s = Number(input.buyRatio60s || 0);
  const velocity = Number(input.velocity || 0);
  const solVolume60s = Number(input.solVolume60s || 0);

  const nearThreshold = buyRatio >= Math.max(1.4, reqRatio * 0.6);
  const freshEnough = tokenAgeSec > 0 && tokenAgeSec <= 20 * 60;
  const matureParticipation = buys1h >= 150;
  const strongLiveFlow =
    buyRatio60s >= 0.9 &&
    buys60s >= 9 &&
    (solVolume60s >= 3.0 || velocity >= 12);
  const missingMomentumRecovery =
    !Number.isFinite(momentum1m) &&
    volume1hUsd >= 5000 &&
    buys60s >= 8 &&
    (solVolume60s >= 1.5 || velocity >= 8);

  return Boolean(input.continuationApproved) &&
    freshEnough &&
    matureParticipation &&
    (
      (nearThreshold && strongLiveFlow) ||
      missingMomentumRecovery
    );
}
