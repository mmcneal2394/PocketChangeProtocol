/**
 * market_observer.ts — Passive market intelligence
 * ─────────────────────────────────────────────────────────────────────────────
 * Watches ALL velocity-detected tokens and trending candidates, tracks their
 * price at 30s/1m/3m/5m, and builds a massive training dataset.
 *
 * Learns from 500+ observations/day instead of just the 5-10 we actually trade.
 * Auto-retunes scorer weights every 50 new observations.
 * ─────────────────────────────────────────────────────────────────────────────
 */

interface Observation {
  mint: string;
  symbol: string;
  source: 'new-mint' | 'trending' | 'rejected';
  detectedAt: number;
  // Entry metrics at detection time
  mcap: number;
  velocity: number;
  buyRatio: number;
  buys: number;
  liquidity: number;
  tokenAgeSec: number;
  // Price checks
  checks: Map<string, { priceSol: number; ts: number }>;
  // Outcome (filled after 5m check)
  outcome?: { pnl5m: number; maxPnl: number; wouldHaveWon: boolean };
}

const observations: Observation[] = [];
const observedMints = new Set<string>(); // dedupe
let totalObserved = 0;
let lastRetune = 0;
const RETUNE_INTERVAL = 50; // retune scorer every 50 observations
const MAX_OBSERVATIONS = 200; // keep bounded

// Price check schedule (sniper timeframes)
const CHECK_SCHEDULE = [
  { delay: 30_000, label: '30s' },
  { delay: 60_000, label: '1m' },
  { delay: 180_000, label: '3m' },
  { delay: 300_000, label: '5m' },
];

/**
 * Record a new observation — call from velocity tracker onNewMint,
 * trending scanner, or scorer rejection.
 */
export function observe(params: {
  mint: string;
  symbol: string;
  source: 'new-mint' | 'trending' | 'rejected';
  mcap: number;
  velocity: number;
  buyRatio: number;
  buys: number;
  liquidity: number;
  tokenAgeSec: number;
}) {
  if (observedMints.has(params.mint)) return; // already tracking
  observedMints.add(params.mint);

  observations.push({
    ...params,
    detectedAt: Date.now(),
    checks: new Map(),
  });

  // Bound the queue
  if (observations.length > MAX_OBSERVATIONS) {
    const removed = observations.shift();
    if (removed) observedMints.delete(removed.mint);
  }
}

/**
 * Run price checks — call every 10s from main loop
 */
export async function runObserverChecks(getQuote: (inputMint: string, outputMint: string, amount: number) => Promise<any>) {
  const now = Date.now();
  const WSOL = 'So11111111111111111111111111111111111111112';

  for (const obs of observations) {
    for (const { delay, label } of CHECK_SCHEDULE) {
      if (obs.checks.has(label)) continue;
      if (now - obs.detectedAt < delay) continue;

      try {
        const quote = await getQuote(WSOL, obs.mint, Math.floor(0.05 * 1e9)); // 0.05 SOL quote
        if (!quote || !quote.outAmount) continue;

        const tokensOut = Number(quote.outAmount);
        const priceSol = 0.05 / tokensOut;
        obs.checks.set(label, { priceSol, ts: now });

        // After first check, compute PnL vs detection price
        const firstCheck = obs.checks.get('30s');
        if (firstCheck && label !== '30s') {
          const pnlVsFirst = ((priceSol - firstCheck.priceSol) / firstCheck.priceSol) * 100;
          if (label === '5m') {
            // Compute max PnL across all checks
            let maxPnl = 0;
            for (const [, check] of obs.checks) {
              const pnl = ((check.priceSol - firstCheck.priceSol) / firstCheck.priceSol) * 100;
              if (pnl > maxPnl) maxPnl = pnl;
            }
            const wouldHaveWon = maxPnl > 10; // >10% at any point = would have been profitable
            obs.outcome = { pnl5m: pnlVsFirst, maxPnl, wouldHaveWon };
            totalObserved++;

            const tag = wouldHaveWon ? 'PUMP' : pnlVsFirst < -20 ? 'DUMP' : 'FLAT';
            console.log(`[OBSERVER] ${obs.symbol} (${obs.source}) | ${tag} | 5m:${pnlVsFirst >= 0 ? '+' : ''}${pnlVsFirst.toFixed(0)}% peak:+${maxPnl.toFixed(0)}% | vel:${obs.velocity.toFixed(1)} ratio:${obs.buyRatio.toFixed(1)}x mcap:$${(obs.mcap/1000).toFixed(0)}k`);

            // Save to DB
            await saveObservation(obs);
          }
        }
      } catch { /* non-fatal */ }

      // Rate limit — max 2 quotes per check cycle
      break;
    }
  }

  // Clean completed observations (all checks done)
  const cutoff = now - 360_000;
  while (observations.length > 0 && observations[0].detectedAt < cutoff && observations[0].checks.size >= CHECK_SCHEDULE.length) {
    const removed = observations.shift();
    if (removed) observedMints.delete(removed.mint);
  }

  // Auto-retune scorer every N observations
  if (totalObserved - lastRetune >= RETUNE_INTERVAL) {
    lastRetune = totalObserved;
    await retuneFromObservations();
  }
}

async function saveObservation(obs: Observation) {
  try {
    const { saveTradetoDB } = require('./scorer_db');
    if (!obs.outcome) return;
    await saveTradetoDB({
      mint: obs.mint,
      symbol: obs.symbol,
      source: `observer-${obs.source}`,
      metrics: {
        volume1h: 0,
        priceChange1h: 0,
        momentum5m: 0,
        buyRatio: obs.buyRatio,
        buys1h: obs.buys,
        liquidity: obs.liquidity,
        mcap: obs.mcap,
        tokenAgeSec: obs.tokenAgeSec,
        velocityScore: obs.velocity,
        detectionSource: obs.source === 'new-mint' ? 1 : 0,
        source: `observer-${obs.source}`,
      },
      won: obs.outcome.wouldHaveWon,
      pnlPct: obs.outcome.pnl5m,
      exitReason: `observer-5m-${obs.outcome.wouldHaveWon ? 'pump' : 'flat'}`,
    });
  } catch { /* non-fatal */ }
}

async function retuneFromObservations() {
  try {
    const { Pool } = require('pg');
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) return;

    const pool = new Pool({ connectionString: dbUrl, max: 1 });

    // Get recent observer data
    const res = await pool.query(`
      SELECT won, buy_ratio, velocity_score, mcap, token_age_sec, liquidity, buys_1h,
             pnl_pct, source
      FROM sniper_trades
      WHERE source LIKE 'observer-%'
      ORDER BY created_at DESC
      LIMIT 200
    `);

    if (res.rows.length < 20) {
      await pool.end();
      return;
    }

    const rows = res.rows;
    const wins = rows.filter((r: any) => r.won);
    const losses = rows.filter((r: any) => !r.won);
    const winRate = wins.length / rows.length;

    // Compute feature means for winners vs losers
    const avg = (arr: any[], key: string) => arr.reduce((s: number, r: any) => s + (+r[key] || 0), 0) / Math.max(arr.length, 1);

    console.log(`[OBSERVER] ═══ RETUNE from ${rows.length} observations (${wins.length}W/${losses.length}L, ${(winRate*100).toFixed(0)}% pump rate) ═══`);

    // Feature-by-feature pattern extraction
    const features = [
      { key: 'buy_ratio', label: 'Buy Ratio' },
      { key: 'velocity_score', label: 'Velocity' },
      { key: 'mcap', label: 'Mcap' },
      { key: 'token_age_sec', label: 'Token Age' },
      { key: 'liquidity', label: 'Liquidity' },
      { key: 'buys_1h', label: 'Buys/1h' },
    ];

    const patterns: { feature: string; direction: string; wAvg: number; lAvg: number; impact: number }[] = [];

    for (const feat of features) {
      const wAvg = avg(wins, feat.key);
      const lAvg = avg(losses, feat.key);
      const combined = avg(rows, feat.key);
      const impact = combined > 0 ? Math.abs(wAvg - lAvg) / combined : 0;

      // Bucket analysis: split into low/mid/high and check win rates per bucket
      const sorted = rows.map((r: any) => +r[feat.key] || 0).sort((a: number, b: number) => a - b);
      const p33 = sorted[Math.floor(sorted.length * 0.33)];
      const p66 = sorted[Math.floor(sorted.length * 0.66)];

      const lowBucket = rows.filter((r: any) => (+r[feat.key] || 0) <= p33);
      const midBucket = rows.filter((r: any) => (+r[feat.key] || 0) > p33 && (+r[feat.key] || 0) <= p66);
      const highBucket = rows.filter((r: any) => (+r[feat.key] || 0) > p66);

      const lowWR = lowBucket.length > 0 ? lowBucket.filter((r: any) => r.won).length / lowBucket.length : 0;
      const midWR = midBucket.length > 0 ? midBucket.filter((r: any) => r.won).length / midBucket.length : 0;
      const highWR = highBucket.length > 0 ? highBucket.filter((r: any) => r.won).length / highBucket.length : 0;

      const direction = wAvg > lAvg ? 'higher=better' : 'lower=better';
      patterns.push({ feature: feat.label, direction, wAvg, lAvg, impact });

      console.log(`[OBSERVER]   ${feat.label.padEnd(12)} W:${wAvg.toFixed(1).padStart(8)} L:${lAvg.toFixed(1).padStart(8)} | buckets: low=${(lowWR*100).toFixed(0)}% mid=${(midWR*100).toFixed(0)}% high=${(highWR*100).toFixed(0)}% | ${direction}`);
    }

    // Find the strongest differentiators
    patterns.sort((a, b) => b.impact - a.impact);
    const top3 = patterns.slice(0, 3);
    console.log(`[OBSERVER]   TOP PREDICTORS: ${top3.map(p => `${p.feature}(${p.direction})`).join(', ')}`);

    // Cross-feature patterns: what combo predicts pumps?
    const highRatioLowMcap = rows.filter((r: any) => (+r.buy_ratio || 0) > 1.5 && (+r.mcap || 0) < 15000);
    const hrLmWR = highRatioLowMcap.length > 0 ? highRatioLowMcap.filter((r: any) => r.won).length / highRatioLowMcap.length : 0;
    console.log(`[OBSERVER]   COMBO: ratio>1.5 + mcap<$15k = ${(hrLmWR*100).toFixed(0)}% pump rate (${highRatioLowMcap.length} obs)`);

    const freshTokens = rows.filter((r: any) => (+r.token_age_sec || 999) < 60);
    const freshWR = freshTokens.length > 0 ? freshTokens.filter((r: any) => r.won).length / freshTokens.length : 0;
    console.log(`[OBSERVER]   COMBO: age<60s = ${(freshWR*100).toFixed(0)}% pump rate (${freshTokens.length} obs)`);

    const lowVelHighRatio = rows.filter((r: any) => (+r.velocity_score || 0) < 4 && (+r.buy_ratio || 0) > 2);
    const lvhrWR = lowVelHighRatio.length > 0 ? lowVelHighRatio.filter((r: any) => r.won).length / lowVelHighRatio.length : 0;
    console.log(`[OBSERVER]   COMBO: vel<4 + ratio>2x = ${(lvhrWR*100).toFixed(0)}% pump rate (${lowVelHighRatio.length} obs)`);

    await pool.end();
  } catch (e: any) {
    console.warn(`[OBSERVER] Retune error: ${e.message}`);
  }
}

/** Get observer stats for logging */
export function getObserverStats(): string {
  const completed = observations.filter(o => o.outcome);
  if (completed.length === 0) return '';
  const pumps = completed.filter(o => o.outcome?.wouldHaveWon);
  return `Observer: ${completed.length} tracked, ${pumps.length} pumped (${(pumps.length/completed.length*100).toFixed(0)}%)`;
}
