/**
 * postmortem.ts — Continuous post-trade analysis + auto-tuning
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs scheduled analysis on past trades using Helius + Birdeye data.
 * Computes feature importance, updates scorer weights automatically.
 *
 * Schedule: checks each trade at 1h, 6h, 24h after exit
 * Analysis: runs every 25 new completed post-mortems
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as birdeye from './birdeye';

const HELIUS_RPC = process.env.RPC_ENDPOINT || '';
const CHECK_INTERVALS = [
  { delayMs: 60 * 60 * 1000, label: '1h' },
  { delayMs: 6 * 60 * 60 * 1000, label: '6h' },
  { delayMs: 24 * 60 * 60 * 1000, label: '24h' },
];

let pool: any = null;
async function getPool() {
  if (pool) return pool;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;
  try {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: dbUrl, max: 2 });
    return pool;
  } catch { return null; }
}

/** Create postmortem table if it doesn't exist */
export async function initPostmortemTable() {
  const p = await getPool();
  if (!p) return;
  try {
    await p.query(`
      CREATE TABLE IF NOT EXISTS trade_postmortems (
        id SERIAL PRIMARY KEY,
        trade_id UUID REFERENCES sniper_trades(id),
        check_label TEXT NOT NULL,
        checked_at TIMESTAMPTZ DEFAULT NOW(),
        -- Token state at check time
        cur_price REAL,
        cur_mcap REAL,
        cur_liquidity REAL,
        cur_holders INTEGER,
        cur_volume_24h REAL,
        -- Changes since entry
        price_change_pct REAL,
        mcap_change_pct REAL,
        liq_change_pct REAL,
        holder_change INTEGER,
        -- Would-have-been PnL if we held
        hypothetical_pnl_pct REAL,
        -- Was our exit correct?
        exit_was_correct BOOLEAN,
        UNIQUE(trade_id, check_label)
      );

      CREATE TABLE IF NOT EXISTS feature_importance (
        id SERIAL PRIMARY KEY,
        computed_at TIMESTAMPTZ DEFAULT NOW(),
        feature_name TEXT NOT NULL,
        win_rate_low REAL,
        win_rate_mid REAL,
        win_rate_high REAL,
        predictive_power REAL,
        optimal_bucket_low REAL,
        optimal_bucket_high REAL,
        sample_size INTEGER,
        recommendation TEXT
      );
    `);
    console.log('[POSTMORTEM] Tables initialized');
  } catch (e: any) {
    console.warn(`[POSTMORTEM] Table init error: ${e.message}`);
  }
}

/** Run scheduled post-mortem checks on past trades */
export async function runPostmortems() {
  const p = await getPool();
  if (!p) return;

  try {
    // Find trades that need post-mortem checks
    const trades = await p.query(`
      SELECT t.id, t.mint, t.symbol, t.pnl_pct, t.exit_reason, t.created_at,
             t.entry_price_sol, t.buy_size_sol, t.mcap as entry_mcap,
             t.liquidity as entry_liq, t.buy_ratio, t.velocity_score,
             t.buys_1h, t.token_age_sec
      FROM sniper_trades t
      WHERE t.source NOT LIKE 'backtest%'
        AND t.source NOT LIKE 'artemis%'
        AND t.source NOT LIKE 'observer%'
        AND t.source NOT LIKE 'post-exit%'
        AND t.created_at > NOW() - INTERVAL '48 hours'
      ORDER BY t.created_at DESC
      LIMIT 50
    `);

    let checksRun = 0;
    for (const trade of trades.rows) {
      const tradeAge = Date.now() - new Date(trade.created_at).getTime();

      for (const interval of CHECK_INTERVALS) {
        if (tradeAge < interval.delayMs) continue;

        // Check if already done
        const existing = await p.query(
          'SELECT 1 FROM trade_postmortems WHERE trade_id = $1 AND check_label = $2',
          [trade.id, interval.label]
        );
        if (existing.rows.length > 0) continue;

        // Run the check
        await runSinglePostmortem(p, trade, interval.label);
        checksRun++;

        // Rate limit: max 3 checks per cycle
        if (checksRun >= 3) return;
      }
    }

    // Run analysis if we have enough data
    const pmCount = await p.query('SELECT count(*) FROM trade_postmortems');
    if (+pmCount.rows[0].count >= 10 && +pmCount.rows[0].count % 10 === 0) {
      await runFeatureAnalysis(p);
    }
  } catch (e: any) {
    console.warn(`[POSTMORTEM] Error: ${e.message}`);
  }
}

async function runSinglePostmortem(pool: any, trade: any, label: string) {
  try {
    // Get current token state from Birdeye
    const overview = await birdeye.getTokenOverview(trade.mint);
    if (!overview) {
      console.log(`[POSTMORTEM] ${trade.symbol} @${label}: Birdeye unavailable, skipping`);
      return;
    }

    // Get holder data from Helius
    let curHolders = overview.holders;
    try {
      const { Connection, PublicKey } = require('@solana/web3.js');
      const conn = new Connection(HELIUS_RPC, 'confirmed');
      const largest = await conn.getTokenLargestAccounts(new PublicKey(trade.mint));
      if (largest.value.length > 0) {
        curHolders = largest.value.filter((a: any) => (a.uiAmount || 0) > 0).length;
      }
    } catch {}

    // Compute changes
    const entryMcap = +trade.entry_mcap || 0;
    const mcapChange = entryMcap > 0 ? ((overview.mcap - entryMcap) / entryMcap) * 100 : 0;
    const entryLiq = +trade.entry_liq || 0;
    const liqChange = entryLiq > 0 ? ((overview.liquidity - entryLiq) / entryLiq) * 100 : 0;

    // Hypothetical PnL if we'd held
    const hypotheticalPnl = mcapChange; // rough proxy: mcap change ≈ price change

    // Was our exit correct? If token is now lower than when we exited, yes.
    const exitWasCorrect = hypotheticalPnl < +trade.pnl_pct;

    await pool.query(`
      INSERT INTO trade_postmortems (trade_id, check_label, cur_price, cur_mcap, cur_liquidity,
        cur_holders, cur_volume_24h, price_change_pct, mcap_change_pct, liq_change_pct,
        holder_change, hypothetical_pnl_pct, exit_was_correct)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      ON CONFLICT (trade_id, check_label) DO NOTHING
    `, [
      trade.id, label, overview.price, overview.mcap, overview.liquidity,
      curHolders, overview.volume24h, overview.priceChange24h, mcapChange,
      liqChange, curHolders, hypotheticalPnl, exitWasCorrect
    ]);

    const tag = exitWasCorrect ? 'GOOD EXIT' : 'LEFT MONEY';
    console.log(`[POSTMORTEM] ${trade.symbol} @${label}: ${tag} | sold:${(+trade.pnl_pct).toFixed(0)}% held-would-be:${hypotheticalPnl.toFixed(0)}% | mcap:$${(overview.mcap/1000).toFixed(0)}k holders:${curHolders}`);
  } catch (e: any) {
    console.warn(`[POSTMORTEM] ${trade.symbol} @${label} error: ${e.message}`);
  }
}

/** Statistical analysis: which features predict wins? */
async function runFeatureAnalysis(pool: any) {
  try {
    console.log('[POSTMORTEM] ═══ RUNNING FEATURE ANALYSIS ═══');

    // Get all live trades with their entry metrics
    const trades = await pool.query(`
      SELECT won, pnl_pct, buy_ratio, velocity_score, mcap, token_age_sec,
             liquidity, buys_1h, volume_1h, price_change_1h
      FROM sniper_trades
      WHERE source NOT LIKE 'backtest%' AND source NOT LIKE 'artemis%'
        AND source NOT LIKE 'observer%' AND source NOT LIKE 'post-exit%'
      ORDER BY created_at DESC
      LIMIT 200
    `);

    if (trades.rows.length < 10) {
      console.log('[POSTMORTEM] Not enough trades for analysis');
      return;
    }

    const rows = trades.rows;
    const wins = rows.filter((r: any) => r.won);
    const losses = rows.filter((r: any) => !r.won);
    const totalWR = wins.length / rows.length;

    const features = [
      { key: 'buy_ratio', label: 'Buy Ratio' },
      { key: 'velocity_score', label: 'Velocity' },
      { key: 'mcap', label: 'Mcap' },
      { key: 'token_age_sec', label: 'Token Age' },
      { key: 'liquidity', label: 'Liquidity' },
      { key: 'buys_1h', label: 'Buys/1h' },
      { key: 'volume_1h', label: 'Volume/1h' },
      { key: 'price_change_1h', label: 'PriceChg1h' },
    ];

    const results: any[] = [];

    for (const feat of features) {
      const vals = rows.map((r: any) => +r[feat.key] || 0).sort((a: number, b: number) => a - b);
      if (vals.length < 3) continue;

      const p33 = vals[Math.floor(vals.length * 0.33)];
      const p66 = vals[Math.floor(vals.length * 0.66)];

      const lowBucket = rows.filter((r: any) => (+r[feat.key] || 0) <= p33);
      const midBucket = rows.filter((r: any) => (+r[feat.key] || 0) > p33 && (+r[feat.key] || 0) <= p66);
      const highBucket = rows.filter((r: any) => (+r[feat.key] || 0) > p66);

      const lowWR = lowBucket.length > 0 ? lowBucket.filter((r: any) => r.won).length / lowBucket.length : totalWR;
      const midWR = midBucket.length > 0 ? midBucket.filter((r: any) => r.won).length / midBucket.length : totalWR;
      const highWR = highBucket.length > 0 ? highBucket.filter((r: any) => r.won).length / highBucket.length : totalWR;

      // Predictive power: how much does this feature differentiate wins from losses?
      const variance = ((lowWR - totalWR) ** 2 + (midWR - totalWR) ** 2 + (highWR - totalWR) ** 2) / 3;
      const power = Math.sqrt(variance);

      // Best bucket
      const bestBucket = lowWR >= midWR && lowWR >= highWR ? 'low' : (highWR >= midWR ? 'high' : 'mid');
      const recommendation = `${bestBucket} bucket wins at ${(Math.max(lowWR, midWR, highWR) * 100).toFixed(0)}%`;

      results.push({ feature: feat.label, key: feat.key, lowWR, midWR, highWR, power, p33, p66, recommendation, sampleSize: rows.length });

      // Save to DB
      await pool.query(`
        INSERT INTO feature_importance (feature_name, win_rate_low, win_rate_mid, win_rate_high,
          predictive_power, optimal_bucket_low, optimal_bucket_high, sample_size, recommendation)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [feat.label, lowWR, midWR, highWR, power, p33, p66, rows.length, recommendation]);

      console.log(`[POSTMORTEM]   ${feat.label.padEnd(12)} low:${(lowWR*100).toFixed(0)}% mid:${(midWR*100).toFixed(0)}% high:${(highWR*100).toFixed(0)}% | power:${(power*100).toFixed(1)} | ${recommendation}`);
    }

    // Sort by predictive power
    results.sort((a, b) => b.power - a.power);
    console.log(`[POSTMORTEM]   TOP PREDICTORS: ${results.slice(0, 3).map(r => `${r.feature}(${(r.power*100).toFixed(0)})`).join(', ')}`);

    // Auto-update scorer weights based on predictive power
    await autoUpdateScorer(pool, results);

    // Post-mortem exit analysis
    const pmData = await pool.query(`
      SELECT pm.check_label, pm.exit_was_correct, t.exit_reason
      FROM trade_postmortems pm
      JOIN sniper_trades t ON t.id = pm.trade_id
      WHERE pm.check_label = '1h'
    `);

    if (pmData.rows.length >= 5) {
      const byExit: Record<string, { correct: number; total: number }> = {};
      for (const r of pmData.rows) {
        const reason = (r.exit_reason || '').split(' ')[0];
        if (!byExit[reason]) byExit[reason] = { correct: 0, total: 0 };
        byExit[reason].total++;
        if (r.exit_was_correct) byExit[reason].correct++;
      }
      console.log('[POSTMORTEM]   EXIT ACCURACY (1h later):');
      for (const [reason, data] of Object.entries(byExit)) {
        console.log(`[POSTMORTEM]     ${reason.padEnd(15)} ${data.correct}/${data.total} correct (${(data.correct/data.total*100).toFixed(0)}%)`);
      }
    }

    console.log('[POSTMORTEM] ═══ ANALYSIS COMPLETE ═══');
  } catch (e: any) {
    console.warn(`[POSTMORTEM] Analysis error: ${e.message}`);
  }
}

async function autoUpdateScorer(pool: any, results: any[]) {
  try {
    // Load current scorer state
    const state = await pool.query('SELECT * FROM scorer_state WHERE id = $1', ['singleton']);
    if (state.rows.length === 0) return;

    const weights = state.rows[0].feature_weights || {};
    let changed = false;

    for (const r of results) {
      const currentWeight = weights[r.key] || 1.0;
      // Scale weight by predictive power: more predictive = higher weight
      // Base weight 1.0, scale by power (0-0.5 range typically)
      const newWeight = 1.0 + (r.power * 5);
      const clampedWeight = Math.max(0.3, Math.min(3.0, newWeight));

      if (Math.abs(clampedWeight - currentWeight) > 0.1) {
        weights[r.key] = parseFloat(clampedWeight.toFixed(2));
        console.log(`[POSTMORTEM] Auto-update: ${r.feature} weight ${currentWeight.toFixed(2)} → ${clampedWeight.toFixed(2)} (power: ${(r.power*100).toFixed(0)})`);
        changed = true;
      }
    }

    if (changed) {
      await pool.query(
        'UPDATE scorer_state SET feature_weights = $1, updated_at = NOW() WHERE id = $2',
        [JSON.stringify(weights), 'singleton']
      );
      console.log('[POSTMORTEM] Scorer weights updated in Postgres');
    }
  } catch (e: any) {
    console.warn(`[POSTMORTEM] Auto-update error: ${e.message}`);
  }
}

/** Get summary for Telegram reporting */
export async function getPostmortemSummary(): Promise<string | null> {
  const p = await getPool();
  if (!p) return null;
  try {
    const res = await p.query(`
      SELECT
        count(*) as total,
        count(*) FILTER (WHERE exit_was_correct) as correct,
        avg(hypothetical_pnl_pct) as avg_held_pnl
      FROM trade_postmortems
      WHERE check_label = '1h'
        AND checked_at > NOW() - INTERVAL '24 hours'
    `);
    const r = res.rows[0];
    if (+r.total === 0) return null;
    const accuracy = (+r.correct / +r.total * 100).toFixed(0);
    const heldPnl = (+r.avg_held_pnl).toFixed(0);
    return `Exit accuracy: ${accuracy}% (${r.correct}/${r.total}) | Avg if held 1h: ${heldPnl}%`;
  } catch { return null; }
}
