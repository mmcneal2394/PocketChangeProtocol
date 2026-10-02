'use strict';
// Missing bars are not evidence of no trades. Require every minute including
// the current partial minute and use the start of the verified empty window.
function trafficEvidence(candles, now) {
  const unknown = { checkedAt: now, quietSince: null };
  if (!Array.isArray(candles)) return unknown;
  const minute = 60000, end = Math.floor(now / minute) * minute, start = end - 600000;
  const rows = new Map();
  for (const c of candles) {
    if (!Number.isSafeInteger(c.time) || c.time % minute || c.time > end) return unknown;
    if (rows.has(c.time) || [c.volume, c.amount].some(v => v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) || Number(v) < 0)) return unknown;
    rows.set(c.time, Number(c.volume) + Number(c.amount));
  }
  for (let t = start; t <= end; t += minute) if (!rows.has(t) || rows.get(t) !== 0) return unknown;
  return { checkedAt: now, quietSince: start };
}
module.exports = { trafficEvidence };
