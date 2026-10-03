'use strict';
const { concentrationIssues } = require('./supply_control');
// Versioned paper hypothesis, not a profitability claim or a token safety guarantee.
const POLICY = Object.freeze({ id: 'pcp-three-lane-v7', minAgeSeconds: 3600,
  minLiquidityUsd: 7000, minHolders: 100, maxTop10: 0.30,
  reviewedSupplyControlProfiles: true,
  minVolume1mUsd: 1000, minVolume5mUsd: 5000, minSwaps1m: 5,
  minAccelerationAgeSeconds: 600, accelerationCandleCount: 6,
  minAccelerationGain: 0.05, maxAccelerationPullback: 0.05,
  // Lane floors match the global turnover floors (1000/5000): a candidate that clears
  // admission should not be re-rejected by a lane floor it already passed, or the
  // extra 2000/8000 margin halves the fill rate without adding real protection.
  minAccelerationVolume1mUsd: 1000, minAccelerationVolume5mUsd: 5000,
  minAccelerationSwaps1m: 12, minAccelerationBuys1m: 8, minAccelerationBuyRatio: 0.60,
  minAccelerationBuyVolumeRatio: 0.65,
  minConvictionAgeSeconds: 86400, minConvictionLiquidityUsd: 250000,
  minConvictionHolders: 10000, minConvictionVolume1hUsd: 50000,
  minConvictionVolume24hUsd: 1000000, minConvictionBuyVolumeRatio: 0.55,
  minConvictionShortMomentum: 0.002, minConvictionMediumMomentum: -0.01,
  minConvictionScore: 75,
  // No-candle lane: admits a young, actively-traded token from window flow alone
  // when GMGN returns no candle history at all. The edge is unvalidated, so every
  // safety and execution check below still applies; only the OHLC pattern is waived.
  minFlowMomentumAgeSeconds: 600, minFlowMomentumGain: 0.01,
  minFlowMomentumVolume1mUsd: 1000, minFlowMomentumVolume5mUsd: 5000,
  minFlowMomentumSwaps1m: 12, minFlowMomentumBuys1m: 8,
  minFlowMomentumBuyRatio: 0.60, minFlowMomentumBuyVolumeRatio: 0.65,
  // flow_momentum buys a 1m momentum top; on thin young tokens ~70% of those are
  // already below entry the moment they fill (verified 2026-10-02: 18/26 trades never
  // printed a green mark, perfect-exit ceiling +0.003). Require the price to still
  // hold the signal level after a short delay, else stand down. Measured on the 26
  // live trades this flips the lane from -0.143 to ~breakeven while keeping ~2/26.
  minFlowMomentumFollowThroughMs: 20000,
  candleCount: 90, maxHistorySpanMinutes: 120, floorTolerance: 0.03, floorBreakTolerance: 0.05,
  minPostHypeDrawdown: 0.15, maxPostHypeDrawdown: 0.85, deepRetraceThreshold: 0.60,
  minDeepVolume5mUsd: 10000, minDeepSwaps1m: 8, maxEntryFromFloor: 0.12,
  maxRoundTripLoss: 0.05, maxQuoteReserveFraction: 0.001 });
const finite = n => typeof n === 'number' && Number.isFinite(n);
const LANES = ['retrace', 'acceleration', 'conviction', 'flow_momentum'];
function qualityIssues(e, lane = 'retrace') {
  const out = [];
  // 'discovery' is the lane-agnostic screen used while a candidate is being enriched,
  // before a lane is selected. It reports only the gates every lane shares; asserting
  // the retrace migration/age requirement here would label young acceleration and
  // flow_momentum candidates as migration-blocked when they are not.
  const laneAgnostic = lane === 'discovery';
  if (!laneAgnostic && !LANES.includes(lane)) out.push('quality_unknown_entry_lane');
  if (lane === 'retrace' || lane === 'conviction') {
    if (Number(e.migration?.status) !== 1 || typeof e.migration?.migratedPool !== 'string' || !e.migration.migratedPool) out.push('quality_migration_unconfirmed');
    else if (typeof e.pool !== 'string' || !e.pool || e.migration.migratedPool !== e.pool) out.push('quality_migrated_pool_mismatch');
  }
  const minAge = laneAgnostic ? 0 : lane === 'acceleration' ? POLICY.minAccelerationAgeSeconds : lane === 'conviction' ? POLICY.minConvictionAgeSeconds : lane === 'flow_momentum' ? POLICY.minFlowMomentumAgeSeconds : POLICY.minAgeSeconds;
  for (const [key, floor] of [['ageSeconds', minAge], ['liquidityUsd', POLICY.minLiquidityUsd], ['holderCount', POLICY.minHolders]]) {
    if (!finite(e[key]) || e[key] < floor) out.push(`quality_${key}_below_${floor}`);
  }
  out.push(...concentrationIssues(e, POLICY.maxTop10));
  for (const [key, floor] of [['volume1mUsd', POLICY.minVolume1mUsd], ['volume5mUsd', POLICY.minVolume5mUsd], ['swaps1m', POLICY.minSwaps1m], ['buys1m', 1], ['sells1m', 1]]) {
    if (!finite(e.flow?.[key]) || e.flow[key] < floor) out.push(`quality_${key}_below_${floor}`);
  }
  if (e.pattern?.regime === 'deep_retrace') {
    if (!finite(e.flow?.volume5mUsd) || e.flow.volume5mUsd < POLICY.minDeepVolume5mUsd) out.push(`deep_retrace_volume5mUsd_below_${POLICY.minDeepVolume5mUsd}`);
    if (!finite(e.flow?.swaps1m) || e.flow.swaps1m < POLICY.minDeepSwaps1m) out.push(`deep_retrace_swaps1m_below_${POLICY.minDeepSwaps1m}`);
  }
  if (lane === 'acceleration') {
    for (const [key, floor] of [['volume1mUsd', POLICY.minAccelerationVolume1mUsd], ['volume5mUsd', POLICY.minAccelerationVolume5mUsd], ['swaps1m', POLICY.minAccelerationSwaps1m], ['buys1m', POLICY.minAccelerationBuys1m]]) {
      if (!finite(e.flow?.[key]) || e.flow[key] < floor) out.push(`acceleration_${key}_below_${floor}`);
    }
    const swaps = e.flow?.swaps1m, buys = e.flow?.buys1m;
    const buyVolume = e.flow?.windows?.['1m']?.buyVolumeUsd;
    const totalVolume = e.flow?.windows?.['1m']?.volumeUsd;
    const countPressure = finite(swaps) && swaps > 0 && finite(buys) && buys / swaps >= POLICY.minAccelerationBuyRatio;
    const volumePressure = finite(totalVolume) && totalVolume > 0 && finite(buyVolume) && buyVolume / totalVolume >= POLICY.minAccelerationBuyVolumeRatio;
    if (!countPressure && !volumePressure) out.push('acceleration_order_flow_below_threshold');
  }
  if (lane === 'conviction') {
    for (const [key, floor] of [['liquidityUsd', POLICY.minConvictionLiquidityUsd], ['holderCount', POLICY.minConvictionHolders]]) {
      if (!finite(e[key]) || e[key] < floor) out.push(`conviction_${key}_below_${floor}`);
    }
    if (!finite(e.pattern?.score) || e.pattern.score < POLICY.minConvictionScore) out.push(`conviction_score_below_${POLICY.minConvictionScore}`);
  }
  if (lane === 'flow_momentum') {
    for (const [key, floor] of [['volume1mUsd', POLICY.minFlowMomentumVolume1mUsd], ['volume5mUsd', POLICY.minFlowMomentumVolume5mUsd], ['swaps1m', POLICY.minFlowMomentumSwaps1m], ['buys1m', POLICY.minFlowMomentumBuys1m], ['sells1m', 1]]) {
      if (!finite(e.flow?.[key]) || e.flow[key] < floor) out.push(`flow_momentum_${key}_below_${floor}`);
    }
    const one = e.flow?.windows?.['1m'], five = e.flow?.windows?.['5m'];
    if (!finite(one?.priceUsd) || one.priceUsd <= 0 || !finite(five?.priceUsd) || five.priceUsd <= 0) out.push('flow_momentum_prices_unavailable');
    else if (one.priceUsd / five.priceUsd - 1 < POLICY.minFlowMomentumGain) out.push(`flow_momentum_gain_below_${POLICY.minFlowMomentumGain}`);
    const swaps = e.flow?.swaps1m, buys = e.flow?.buys1m;
    const countPressure = finite(swaps) && swaps > 0 && finite(buys) && buys / swaps >= POLICY.minFlowMomentumBuyRatio;
    const volumePressure = finite(one?.volumeUsd) && one.volumeUsd > 0 && finite(one?.buyVolumeUsd) && one.buyVolumeUsd / one.volumeUsd >= POLICY.minFlowMomentumBuyVolumeRatio;
    if (!countPressure && !volumePressure) out.push('flow_momentum_order_flow_below_threshold');
  }
  return out;
}
function recentClosedCandles(raw, now, count, options = {}) {
  if (!Array.isArray(raw)) throw new Error('pattern_history_missing');
  const current = Math.floor(now / 60000) * 60;
  const rows = raw.map(r => {
    const c = Object.fromEntries(['time', 'open', 'high', 'low', 'close'].map(k => [k, r[k] == null || r[k] === '' ? NaN : Number(r[k])]));
    if (Object.values(c).some(v => !Number.isFinite(v) || v <= 0) || !Number.isInteger(c.time) || c.time % 60 || c.time > current || c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close)) throw new Error('pattern_invalid_candle');
    return c;
  }).sort((a, b) => a.time - b.time);
  if (new Set(rows.map(c => c.time)).size !== rows.length) throw new Error('pattern_duplicate_candle');
  const closed = rows.filter(c => c.time < current).slice(-count);
  if (closed.length < count) throw new Error('pattern_insufficient_history');
  if (closed.at(-1).time !== current - 60) throw new Error('pattern_stale_history');
  if (options.requireContiguous !== false) {
    if (closed.some((c, i) => i && c.time - closed[i - 1].time !== 60)) throw new Error('pattern_history_gap');
  } else {
    // A single intermittent provider bar must not veto an otherwise complete window,
    // but the evidence must still be recent, ordered and free of duplicate minutes.
    const spanMinutes = (closed.at(-1).time - closed[0].time) / 60;
    if (spanMinutes > (options.maxSpanMinutes || POLICY.maxHistorySpanMinutes)) throw new Error('pattern_history_span_exceeded');
  }
  return closed;
}
function closedCandles(raw, now) { return recentClosedCandles(raw, now, POLICY.candleCount, { requireContiguous: false }); }
// A candle lane needs a bar closed in the minute right before `now` (see the
// pattern_stale_history rule); a window whose newest bar is older than that cannot
// confirm a candle entry, but must not veto the candle-free flow_momentum lane.
function staleCandleHistory(raw, now) {
  if (!Array.isArray(raw) || !raw.length) return false;
  const current = Math.floor(now / 60000) * 60;
  let newest = 0;
  for (const row of raw) { const t = Number(row && row.time); if (Number.isFinite(t) && t > newest) newest = t; }
  return newest > 0 && newest < current - 60;
}
function accelerationPattern(raw, now) {
  const closed = recentClosedCandles(raw, now, POLICY.accelerationCandleCount);
  const first = closed[0], last = closed.at(-1), prior = closed.at(-2);
  const gain = last.close / first.open - 1;
  const high = Math.max(...closed.map(c => c.high));
  const pullback = 1 - last.close / high;
  const positiveCloses = closed.slice(1).filter((c, i) => c.close > closed[i].close).length;
  if (gain < POLICY.minAccelerationGain) throw new Error('acceleration_gain_unconfirmed');
  if (pullback > POLICY.maxAccelerationPullback || last.close <= prior.close) throw new Error('acceleration_momentum_fading');
  if (positiveCloses < Math.ceil((closed.length - 1) * 0.6)) throw new Error('acceleration_sequence_weak');
  if (closed.some(c => c.high / c.low > 1.20)) throw new Error('pattern_excessive_candle_range');
  return { name: 'short_window_acceleration', regime: 'acceleration', momentumPct: gain,
    pullbackPct: pullback, positiveCloses, lastClosedAt: last.time * 1000, count: closed.length,
    source: 'gmgn_token_level_not_independent_pool_ohlc' };
}
function convictionPattern(e, now) {
  const windows = e.flow?.windows || {};
  const one = windows['1m'] || {}, five = windows['5m'] || {}, hour = windows['1h'] || {}, day = windows['24h'] || {};
  const required = [e.ageSeconds, e.liquidityUsd, e.holderCount, one.priceUsd, five.priceUsd, hour.priceUsd,
    one.volumeUsd, one.buyVolumeUsd, hour.volumeUsd, day.volumeUsd];
  if (required.some(value => !finite(value) || value < 0) || one.priceUsd <= 0 || five.priceUsd <= 0 || hour.priceUsd <= 0 || one.volumeUsd <= 0) throw new Error('conviction_evidence_incomplete');
  if (Number(e.migration?.status) !== 1 || e.migration?.migratedPool !== e.pool) throw new Error('conviction_migration_unconfirmed');
  if (e.ageSeconds < POLICY.minConvictionAgeSeconds) throw new Error('conviction_age_below_threshold');
  if (e.liquidityUsd < POLICY.minConvictionLiquidityUsd) throw new Error('conviction_liquidity_below_threshold');
  if (e.holderCount < POLICY.minConvictionHolders) throw new Error('conviction_holders_below_threshold');
  if (hour.volumeUsd < POLICY.minConvictionVolume1hUsd || day.volumeUsd < POLICY.minConvictionVolume24hUsd) throw new Error('conviction_turnover_below_threshold');
  const buyVolumeRatio = one.buyVolumeUsd / one.volumeUsd;
  const shortMomentum = one.priceUsd / five.priceUsd - 1;
  const mediumMomentum = five.priceUsd / hour.priceUsd - 1;
  if (buyVolumeRatio < POLICY.minConvictionBuyVolumeRatio) throw new Error('conviction_buy_pressure_below_threshold');
  if (shortMomentum < POLICY.minConvictionShortMomentum || mediumMomentum < POLICY.minConvictionMediumMomentum) throw new Error('conviction_momentum_below_threshold');
  let score = 0;
  score += e.liquidityUsd >= 1000000 ? 20 : 10;
  score += e.holderCount >= 100000 ? 15 : 8;
  score += day.volumeUsd >= 5000000 ? 15 : 8;
  score += hour.volumeUsd >= 100000 ? 10 : 5;
  score += buyVolumeRatio >= 0.65 ? 20 : 15;
  score += shortMomentum >= 0.01 ? 20 : 15;
  score += mediumMomentum >= 0 ? 10 : 5;
  if (!concentrationIssues(e, POLICY.maxTop10).length) score += 10;
  if (score < POLICY.minConvictionScore) throw new Error('conviction_score_below_threshold');
  return { name: 'mature_liquid_conviction', regime: 'conviction', score, buyVolumeRatio,
    shortMomentumPct: shortMomentum, mediumMomentumPct: mediumMomentum,
    observedAt: now, source: 'gmgn_multi_window_snapshot_not_independent_ohlc',
    caveat: 'probabilistic fallback used only when strict paper safety and execution checks still pass' };
}
function flowMomentumPattern(e, now) {
  const windows = e.flow?.windows || {};
  const one = windows['1m'] || {}, five = windows['5m'] || {};
  const required = [e.ageSeconds, e.liquidityUsd, e.holderCount, one.priceUsd, five.priceUsd, one.volumeUsd, one.buyVolumeUsd];
  if (required.some(value => !finite(value) || value < 0) || one.priceUsd <= 0 || five.priceUsd <= 0 || one.volumeUsd <= 0) throw new Error('flow_momentum_evidence_incomplete');
  if (e.ageSeconds < POLICY.minFlowMomentumAgeSeconds) throw new Error('flow_momentum_age_below_threshold');
  if (e.liquidityUsd < POLICY.minLiquidityUsd) throw new Error('flow_momentum_liquidity_below_threshold');
  if (e.holderCount < POLICY.minHolders) throw new Error('flow_momentum_holders_below_threshold');
  if (!finite(e.flow?.volume1mUsd) || e.flow.volume1mUsd < POLICY.minFlowMomentumVolume1mUsd
    || !finite(e.flow?.volume5mUsd) || e.flow.volume5mUsd < POLICY.minFlowMomentumVolume5mUsd) throw new Error('flow_momentum_turnover_below_threshold');
  if (!finite(e.flow?.swaps1m) || e.flow.swaps1m < POLICY.minFlowMomentumSwaps1m || !finite(e.flow?.buys1m) || e.flow.buys1m < POLICY.minFlowMomentumBuys1m) throw new Error('flow_momentum_swaps_below_threshold');
  const momentum = one.priceUsd / five.priceUsd - 1;
  if (momentum < POLICY.minFlowMomentumGain) throw new Error('flow_momentum_gain_below_threshold');
  const buyVolumeRatio = one.buyVolumeUsd / one.volumeUsd;
  const countPressure = e.flow.swaps1m > 0 && e.flow.buys1m / e.flow.swaps1m >= POLICY.minFlowMomentumBuyRatio;
  const volumePressure = buyVolumeRatio >= POLICY.minFlowMomentumBuyVolumeRatio;
  if (!countPressure && !volumePressure) throw new Error('flow_momentum_order_flow_below_threshold');
  return { name: 'flow_only_momentum', regime: 'flow_momentum', momentumPct: momentum, buyVolumeRatio, signalPriceUsd: one.priceUsd,
    lastClosedAt: null, observedAt: now, source: 'gmgn_window_flow_not_independent_ohlc',
    caveat: 'no candle history; edge unvalidated, admitted on window flow alone' };
}

// Anti-chase: flow_momentum signals a 1m top, so wait a short beat and enter only if
// the price has not given the level back. Returns a normalized pattern carrying the
// fresh price, or null when the follow-through check is not yet due.
function confirmFollowThrough(pattern, e, now) {
  const dueAt = Number(pattern.observedAt) + POLICY.minFlowMomentumFollowThroughMs;
  if (!Number.isFinite(dueAt) || now < dueAt) return null;
  const signalPrice = Number(pattern.signalPriceUsd);
  const currentPrice = Number(e.flow?.windows?.['1m']?.priceUsd);
  if (!Number.isFinite(signalPrice) || signalPrice <= 0 || !Number.isFinite(currentPrice) || currentPrice <= 0) throw new Error('follow_through_price_unavailable');
  if (currentPrice < signalPrice) throw new Error('follow_through_price_lost');
  return { ...pattern, signalPriceUsd: signalPrice, followThroughPriceUsd: currentPrice, followThroughMs: now - pattern.observedAt, observedAt: now };
}
function selectEntryPattern(e, raw, now) {
  let retraceIssue = null;
  const migrated = Number(e.migration?.status) === 1 && e.migration?.migratedPool === e.pool;
  // When the candle window has gone stale, candle lanes cannot confirm an entry but
  // must not veto the candle-free flow lane; drop the window so only flow_momentum
  // can match.
  const candles = staleCandleHistory(raw, now) ? [] : raw;
  if (migrated && e.ageSeconds >= POLICY.minAgeSeconds) {
    try { return { pattern: supportPattern(candles, now), entryLane: 'retrace' }; }
    catch (error) { retraceIssue = error.message; }
  }
  let accelerationIssue = null;
  try { return { pattern: accelerationPattern(candles, now), entryLane: 'acceleration' }; }
  catch (error) { accelerationIssue = error.message; }
  let convictionIssue = null;
  try { return { pattern: convictionPattern(e, now), entryLane: 'conviction' }; }
  catch (error) { convictionIssue = error.message; }
  // Least-specific fallback: a mature conviction token also clears these flow
  // floors, so this lane is tried last to leave the conviction contract intact.
  try { return { pattern: flowMomentumPattern(e, now), entryLane: 'flow_momentum' }; }
  catch (error) { throw new Error([retraceIssue, accelerationIssue, convictionIssue, error.message].filter(Boolean).join('; ')); }
}
function supportPattern(raw, now) {
  const closed = closedCandles(raw, now);
  const last = closed.at(-1), prior = closed.at(-2);
  const preConfirmation = closed.slice(0, -1), peakSearch = preConfirmation.slice(0, -10);
  const peakIndex = peakSearch.reduce((best, c, i) => c.high > peakSearch[best].high ? i : best, 0);
  const peak = peakSearch[peakIndex].high, postPeak = preConfirmation.slice(peakIndex + 1);
  if (postPeak.length < 12) throw new Error('pattern_post_hype_history_short');
  const lowest = postPeak.map(c => c.low).sort((a, b) => a - b).slice(0, 3);
  const floor = lowest[1];
  const drawdown = 1 - floor / peak;
  if (drawdown < POLICY.minPostHypeDrawdown) throw new Error('pattern_retrace_too_shallow');
  if (drawdown > POLICY.maxPostHypeDrawdown) throw new Error('pattern_retrace_collapse');
  if (postPeak.some(c => c.low < floor * (1 - POLICY.floorBreakTolerance))) throw new Error('pattern_floor_broken');
  const touchIndexes = postPeak.map((c, i) => c.low <= floor * (1 + POLICY.floorTolerance) ? i : -1).filter(i => i >= 0);
  const touchClusters = touchIndexes.filter((i, n) => n === 0 || i - touchIndexes[n - 1] > 3);
  if (touchClusters.length < 2 || touchClusters.at(-1) < postPeak.length - 8 || touchClusters.at(-1) - touchClusters[0] < 8) throw new Error('pattern_floor_not_retested');
  if (last.low < floor * (1 - POLICY.floorBreakTolerance) || last.close <= last.open || last.close <= prior.high) throw new Error('pattern_reclaim_unconfirmed');
  if (last.close > floor * (1 + POLICY.maxEntryFromFloor)) throw new Error('pattern_extended_from_floor');
  if (closed.some(c => c.high / c.low > 1.20)) throw new Error('pattern_excessive_candle_range');
  return { name: 'migrated_floor_retrace_reclaim', floorUsd: floor, closeUsd: last.close,
    peakUsd: peak, peakIndex, touchClusters: touchClusters.length, postHypeDrawdownPct: drawdown,
    regime: drawdown >= POLICY.deepRetraceThreshold ? 'deep_retrace' : 'standard_retrace',
    lastClosedAt: last.time * 1000, count: closed.length, source: 'gmgn_token_level_not_independent_pool_ohlc' };
}
function executionIssues(e, stake, proceeds, feeBps) {
  const issues = [];
  if (![stake, proceeds, feeBps].every(finite) || stake <= 0 || proceeds <= 0 || feeBps < 0 || feeBps >= 10000 || proceeds * (1 - feeBps / 10000) / stake < 1 - POLICY.maxRoundTripLoss) issues.push('quality_round_trip_cost_exceeds_5pct');
  if (!finite(e.reserves?.quoteSol) || e.reserves.quoteSol <= 0 || stake / e.reserves.quoteSol > POLICY.maxQuoteReserveFraction) issues.push('quality_position_exceeds_quote_reserve_limit');
  return issues;
}
module.exports = { POLICY, qualityIssues, supportPattern, accelerationPattern, convictionPattern, flowMomentumPattern, confirmFollowThrough, selectEntryPattern, executionIssues, closedCandles, staleCandleHistory };
