/**
 * live_tuner.ts — Auto-adjusts exit parameters from post-exit + observer data
 * ─────────────────────────────────────────────────────────────────────────────
 * Closes the learning loop: missed gains → widen trail/TP,
 * correct exits → tighten SL. Updates every 5 trades or 50 observations.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Live-tunable exit parameters (read by checkExits in momentum_sniper)
export const exitParams = {
  hardSL: 12.5,
  catastrophicSL: 12.5,
  breakevenTrigger: 12,
  trailTrigger: 20,
  trailDistance: 12,
  fullTP: 60,
  minHoldMs: 15_000,
  lastTuned: 0,
  tuneCount: 0,
};

interface ExitOutcome {
  exitReason: string;
  exitPnl: number;
  priceAfter30s: number | null;
  priceAfter1m: number | null;
  priceAfter3m: number | null;
  priceAfter5m: number | null;
  missedPnl: number; // max price after exit - exit price
}

const exitOutcomes: ExitOutcome[] = [];

/** Record what happened after an exit — called by post-exit monitor */
export function recordExitOutcome(
  exitReason: string, exitPnl: number,
  priceChanges: { label: string; pctChange: number }[]
) {
  const outcome: ExitOutcome = {
    exitReason: exitReason.split(' ')[0], // just the type: TRAIL, P1-SL, P2-BE, STALE, etc.
    exitPnl,
    priceAfter30s: null, priceAfter1m: null, priceAfter3m: null, priceAfter5m: null,
    missedPnl: 0,
  };

  let maxAfter = 0;
  for (const pc of priceChanges) {
    if (pc.label === '30s') outcome.priceAfter30s = pc.pctChange;
    if (pc.label === '1m') outcome.priceAfter1m = pc.pctChange;
    if (pc.label === '3m') outcome.priceAfter3m = pc.pctChange;
    if (pc.label === '5m') outcome.priceAfter5m = pc.pctChange;
    if (pc.pctChange > maxAfter) maxAfter = pc.pctChange;
  }
  outcome.missedPnl = maxAfter;

  exitOutcomes.push(outcome);
  if (exitOutcomes.length > 100) exitOutcomes.shift();

  // Auto-tune after every 5 new outcomes
  if (exitOutcomes.length >= 5 && exitOutcomes.length % 5 === 0) {
    tuneExitParams();
  }
}

function tuneExitParams() {
  if (exitOutcomes.length < 5) return;

  const recent = exitOutcomes.slice(-20); // last 20 exits

  // Count missed gains by exit type
  const byType: Record<string, { count: number; missedGains: number[]; correctExits: number }> = {};
  for (const o of recent) {
    const type = o.exitReason;
    if (!byType[type]) byType[type] = { count: 0, missedGains: [], correctExits: 0 };
    byType[type].count++;
    if (o.missedPnl > 20) {
      byType[type].missedGains.push(o.missedPnl);
    } else if (o.missedPnl < -10) {
      byType[type].correctExits++;
    }
  }

  let changed = false;

  // TRAIL exits missing gains → widen trail distance
  const trailData = byType['TRAIL'];
  if (trailData && trailData.missedGains.length > trailData.correctExits) {
    const oldDist = exitParams.trailDistance;
    exitParams.trailDistance = Math.min(25, exitParams.trailDistance + 2);
    if (exitParams.trailDistance !== oldDist) {
      console.log(`[TUNER] Trail distance ${oldDist}% → ${exitParams.trailDistance}% (${trailData.missedGains.length} missed gains vs ${trailData.correctExits} correct)`);
      changed = true;
    }
  }

  // TRAIL exits mostly correct → tighten trail slightly
  if (trailData && trailData.correctExits > trailData.missedGains.length * 2 && trailData.count >= 3) {
    const oldDist = exitParams.trailDistance;
    exitParams.trailDistance = Math.max(8, exitParams.trailDistance - 1);
    if (exitParams.trailDistance !== oldDist) {
      console.log(`[TUNER] Trail distance ${oldDist}% → ${exitParams.trailDistance}% (tightened — mostly correct exits)`);
      changed = true;
    }
  }

  // STALE exits missing gains → increase stale timeout or add holder check
  const staleData = byType['STALE'];
  if (staleData && staleData.missedGains.length >= 2) {
    // Can't easily change stale timeout from here, but log it
    console.log(`[TUNER] WARNING: ${staleData.missedGains.length} STALE exits missed gains (avg +${(staleData.missedGains.reduce((a,b)=>a+b,0)/staleData.missedGains.length).toFixed(0)}%)`);
  }

  // P2-BE (breakeven) exits — if most miss gains, raise breakeven trigger
  const beData = byType['P2-BE'];
  if (beData && beData.missedGains.length > beData.correctExits) {
    const oldTrigger = exitParams.breakevenTrigger;
    exitParams.breakevenTrigger = Math.min(20, exitParams.breakevenTrigger + 2);
    if (exitParams.breakevenTrigger !== oldTrigger) {
      console.log(`[TUNER] Breakeven trigger ${oldTrigger}% → ${exitParams.breakevenTrigger}% (${beData.missedGains.length} missed gains)`);
      changed = true;
    }
  }

  // P1-SL exits — if many would have recovered, widen SL slightly
  const slData = byType['P1-SL'];
  if (slData && slData.missedGains.length > 0 && slData.missedGains.length >= slData.count * 0.4) {
    const oldSL = exitParams.hardSL;
    exitParams.hardSL = Math.min(20, exitParams.hardSL + 1);
    exitParams.catastrophicSL = exitParams.hardSL;
    if (exitParams.hardSL !== oldSL) {
      console.log(`[TUNER] Hard SL ${oldSL}% → ${exitParams.hardSL}% (${slData.missedGains.length}/${slData.count} would have recovered)`);
      changed = true;
    }
  }

  // If we have lots of missed TP (price went way past fullTP after exit), raise TP
  const tpMissed = recent.filter(o => o.exitReason === 'TP' && o.missedPnl > 30);
  if (tpMissed.length >= 2) {
    const oldTP = exitParams.fullTP;
    exitParams.fullTP = Math.min(100, exitParams.fullTP + 10);
    if (exitParams.fullTP !== oldTP) {
      console.log(`[TUNER] Full TP ${oldTP}% → ${exitParams.fullTP}% (${tpMissed.length} exits still running after TP)`);
      changed = true;
    }
  }

  if (changed) {
    exitParams.lastTuned = Date.now();
    exitParams.tuneCount++;
    console.log(`[TUNER] Current params: SL:-${exitParams.hardSL}% BE:+${exitParams.breakevenTrigger}% Trail:+${exitParams.trailTrigger}%/-${exitParams.trailDistance}% TP:+${exitParams.fullTP}%`);
  }
}

/** Get current params as string for logging */
export function getTunerStatus(): string {
  return `SL:-${exitParams.hardSL}% BE:+${exitParams.breakevenTrigger}% Trail:-${exitParams.trailDistance}% TP:+${exitParams.fullTP}% (tuned ${exitParams.tuneCount}x)`;
}
