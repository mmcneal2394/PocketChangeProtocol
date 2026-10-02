'use strict';
function candleRequest(mint, now = Date.now()) {
  // Live GMGN OpenAPI uses milliseconds despite its seconds-based documentation.
  // Fetch 120 minutes so the 90-candle retrace window survives intermittent missing bars.
  return { chain: 'sol', address: mint, resolution: '1m', from: now - 7200000, to: now };
}
function normalizeCandles(rows, capturedAt) {
  if (!Array.isArray(rows)) throw new Error('candle_response_not_array');
  if (capturedAt !== undefined && (!Number.isSafeInteger(capturedAt) || capturedAt <= 0)) throw new Error('candle_invalid_capture_time');
  const normalized = rows.map(row => {
    const raw = row?.time;
    const time = raw === '' || raw == null ? NaN : Number(raw);
    if (!Number.isSafeInteger(time) || time <= 0) throw new Error('candle_invalid_timestamp');
    const seconds = time >= 1e12 ? time / 1000 : time;
    if (!Number.isSafeInteger(seconds)) throw new Error('candle_fractional_timestamp');
    if (capturedAt !== undefined && seconds > Math.floor(capturedAt / 60000) * 60) throw new Error('candle_future_timestamp');
    return { ...row, time: seconds };
  });
  // Never let a saved, partially formed candle become "closed" just as time passes.
  return capturedAt === undefined ? normalized : normalized.filter(row => row.time < Math.floor(capturedAt / 60000) * 60);
}
module.exports = { candleRequest, normalizeCandles };
