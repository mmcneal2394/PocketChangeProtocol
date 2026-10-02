'use strict';
function marketCap(info, mint, observedAt, pool = null) {
  if (info?.address !== mint) throw new Error('market_cap_mint_conflict');
  const number = v => v === null || v === undefined || v === '' || typeof v === 'boolean' ? NaN : Number(v);
  const price = number(info.price?.price), reportedCirculating = number(info.circulating_supply);
  const totalSupply = number(info.total_supply), maxSupply = number(info.max_supply), baseReserve = number(pool?.base_reserve);
  const fdvSupply = [maxSupply, totalSupply, reportedCirculating].find(value => Number.isFinite(value) && value > 0);
  const fdvUsd = price >= 0 && fdvSupply > 0 && Number.isFinite(price * fdvSupply) ? price * fdvSupply : null;
  const isVirtualCurve = Number(info.launchpad_status) !== 1 && /curve/i.test(String(info.launchpad || pool?.exchange || ''));
  const floatSupply = isVirtualCurve && totalSupply > 0 && Number.isFinite(baseReserve) ? Math.max(0, totalSupply - baseReserve) : reportedCirculating;
  const usd = price >= 0 && floatSupply > 0 && Number.isFinite(price * floatSupply) ? price * floatSupply : null;
  return { usd, fdvUsd, priceUsd: Number.isFinite(price) && price >= 0 ? price : null,
    circulatingSupply: Number.isFinite(floatSupply) && floatSupply >= 0 ? floatSupply : null,
    providerReportedCirculating: Number.isFinite(reportedCirculating) ? reportedCirculating : null,
    curveReserveSupply: isVirtualCurve && Number.isFinite(baseReserve) ? baseReserve : null,
    valuationType: isVirtualCurve ? 'curve_float' : 'circulating', observedAt, source: 'GMGN',
    basis: isVirtualCurve ? 'USD price x supply outside pre-bond virtual curve' : 'USD price x circulating supply' };
}
function compactUsd(value) {
  if (value === null || !Number.isFinite(value) || value < 0) return 'Unknown';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(value);
}
function marketCapLabel(cap, now = Date.now()) {
  if (!cap || cap.usd === null || !Number.isFinite(cap.usd) || cap.usd < 0) return 'Unknown';
  const age = now - cap.observedAt;
  return `${compactUsd(cap.usd)}${cap.valuationType === 'curve_float' ? ' float' : ''} (${Number.isFinite(age) && age >= 0 && age <= 30000 ? 'GMGN' : 'stale'})`;
}
function marketCapSecondaryLabel(cap) {
  return cap?.valuationType === 'curve_float' && Number.isFinite(cap.fdvUsd) ? `${compactUsd(cap.fdvUsd)} curve FDV` : null;
}
module.exports = { marketCap, marketCapLabel, marketCapSecondaryLabel };
