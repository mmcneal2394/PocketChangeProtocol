/**
 * scorer_db.ts — Postgres persistence for adaptive scorer
 * ─────────────────────────────────────────────────────────────────────────────
 * Replaces JSON file + Redis persistence with durable Postgres storage.
 *
 * Tables:
 *   sniper_trades  — every trade outcome (backtest + live)
 *   scorer_state   — current bucket stats, weights, threshold (singleton)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { EntryMetrics } from './adaptive_scorer';

let pool: any = null;

async function getPool() {
  if (pool) return pool;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn('[SCORER-DB] DATABASE_URL not set — Postgres persistence disabled');
    return null;
  }
  try {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: dbUrl, max: 3, idleTimeoutMillis: 30000 });
    await pool.query('SELECT 1');
    console.log('[SCORER-DB] Connected to Postgres');
    return pool;
  } catch (e: any) {
    console.warn(`[SCORER-DB] Postgres connection failed: ${e.message}`);
    return null;
  }
}

/** Load all trade outcomes from Postgres for scorer training */
export async function loadTradesFromDB(): Promise<Array<{
  symbol: string; mint: string; source: string; won: boolean;
  pnlPct: number; metrics: EntryMetrics; exitReason: string;
}>> {
  const p = await getPool();
  if (!p) return [];
  try {
    const res = await p.query(
      `SELECT symbol, mint, source, won, pnl_pct, exit_reason,
              volume_1h, price_change_1h, momentum_5m, buy_ratio, buys_1h,
              liquidity, mcap, token_age_sec, velocity_score
       FROM sniper_trades ORDER BY created_at ASC`
    );
    return res.rows.map((r: any) => ({
      symbol: r.symbol,
      mint: r.mint,
      source: r.source,
      won: r.won,
      pnlPct: r.pnl_pct,
      exitReason: r.exit_reason || 'unknown',
      metrics: {
        volume1h: r.volume_1h || 0,
        priceChange1h: r.price_change_1h || 0,
        momentum5m: r.momentum_5m || 0,
        buyRatio: r.buy_ratio || 1,
        buys1h: r.buys_1h || 0,
        liquidity: r.liquidity || 0,
        mcap: r.mcap || 0,
        tokenAgeSec: r.token_age_sec || 3600,
        velocityScore: r.velocity_score || 0,
        detectionSource: 0,
        source: r.source || 'dexscreener',
      } as EntryMetrics,
    }));
  } catch (e: any) {
    console.warn(`[SCORER-DB] Failed to load trades: ${e.message}`);
    return [];
  }
}

/** Persist a new trade outcome to Postgres */
export async function saveTradetoDB(params: {
  mint: string; symbol: string; source: string; txSignature?: string;
  metrics: EntryMetrics; adaptiveScore?: number; confidence?: string; threshold?: number;
  won: boolean; pnlPct: number; pnlSol?: number; holdMs?: number; exitReason?: string;
  entryPriceSol?: number; exitPriceSol?: number; buySizeSol?: number; tokenAmount?: number;
}): Promise<void> {
  const p = await getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO sniper_trades
       (mint, symbol, source, tx_signature,
        volume_1h, price_change_1h, momentum_5m, buy_ratio, buys_1h,
        liquidity, mcap, token_age_sec, velocity_score,
        adaptive_score, confidence, threshold,
        won, pnl_pct, pnl_sol, hold_ms, exit_reason,
        entry_price_sol, exit_price_sol, buy_size_sol, token_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [
        params.mint, params.symbol, params.source, params.txSignature || null,
        params.metrics.volume1h, params.metrics.priceChange1h, params.metrics.momentum5m,
        params.metrics.buyRatio, params.metrics.buys1h, params.metrics.liquidity,
        params.metrics.mcap, params.metrics.tokenAgeSec, params.metrics.velocityScore,
        params.adaptiveScore ?? null, params.confidence ?? null, params.threshold ?? null,
        params.won, params.pnlPct, params.pnlSol ?? 0, params.holdMs ?? 0,
        params.exitReason ?? null, params.entryPriceSol ?? null, params.exitPriceSol ?? null,
        params.buySizeSol ?? null, params.tokenAmount ?? null,
      ]
    );
  } catch (e: any) {
    console.warn(`[SCORER-DB] Failed to save trade: ${e.message}`);
  }
}

/** Load scorer state (bucket stats, weights, threshold) from Postgres */
export async function loadScorerState(): Promise<{
  bucketStats: Record<string, any>;
  featureWeights: Record<string, number>;
  winRate: number;
  threshold: number;
  totalTrades: number;
} | null> {
  const p = await getPool();
  if (!p) return null;
  try {
    const res = await p.query(`SELECT * FROM scorer_state WHERE id = 'singleton'`);
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      bucketStats: r.bucket_stats,
      featureWeights: r.feature_weights,
      winRate: r.win_rate,
      threshold: r.threshold,
      totalTrades: r.total_trades,
    };
  } catch (e: any) {
    console.warn(`[SCORER-DB] Failed to load state: ${e.message}`);
    return null;
  }
}

/** Save scorer state to Postgres (upsert singleton) */
export async function saveScorerState(state: {
  bucketStats: Record<string, any>;
  featureWeights: Record<string, number>;
  winRate: number;
  threshold: number;
  totalTrades: number;
}): Promise<void> {
  const p = await getPool();
  if (!p) return;
  try {
    await p.query(
      `INSERT INTO scorer_state (id, bucket_stats, feature_weights, win_rate, threshold, total_trades, updated_at)
       VALUES ('singleton', $1, $2, $3, $4, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET
         bucket_stats = $1, feature_weights = $2, win_rate = $3,
         threshold = $4, total_trades = $5, updated_at = NOW()`,
      [
        JSON.stringify(state.bucketStats), JSON.stringify(state.featureWeights),
        state.winRate, state.threshold, state.totalTrades,
      ]
    );
  } catch (e: any) {
    console.warn(`[SCORER-DB] Failed to save state: ${e.message}`);
  }
}

/** Get trade stats summary */
export async function getTradeStats(): Promise<{
  total: number; wins: number; losses: number; winRate: number;
  avgWinPnl: number; avgLossPnl: number;
  liveCount: number; backtestCount: number;
} | null> {
  const p = await getPool();
  if (!p) return null;
  try {
    const res = await p.query(`
      SELECT
        count(*) as total,
        count(*) FILTER (WHERE won) as wins,
        count(*) FILTER (WHERE NOT won) as losses,
        avg(pnl_pct) FILTER (WHERE won) as avg_win,
        avg(pnl_pct) FILTER (WHERE NOT won) as avg_loss,
        count(*) FILTER (WHERE source NOT LIKE 'backtest%' AND source NOT LIKE 'artemis%' AND source NOT LIKE 'pcp-backtest%') as live_count,
        count(*) FILTER (WHERE source LIKE 'backtest%' OR source LIKE 'artemis%' OR source LIKE 'pcp-backtest%') as backtest_count
      FROM sniper_trades
    `);
    const r = res.rows[0];
    return {
      total: +r.total, wins: +r.wins, losses: +r.losses,
      winRate: r.total > 0 ? r.wins / r.total : 0,
      avgWinPnl: +(r.avg_win || 0), avgLossPnl: +(r.avg_loss || 0),
      liveCount: +r.live_count, backtestCount: +r.backtest_count,
    };
  } catch (e: any) {
    console.warn(`[SCORER-DB] Failed to get stats: ${e.message}`);
    return null;
  }
}
