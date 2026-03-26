/**
 * chart_strategist.ts — TA Signal Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches OHLCV candles for trending tokens via GeckoTerminal (free, no key),
 * computes RSI-14, EMA-9/21 crossover, MACD, and volume delta, then outputs
 * per-token BUY / SELL / HOLD signals to signals/chart_strategy.json.
 *
 * The momentum_sniper and pumpfun_sniper read this file as an extra gate —
 * they will only enter if the strategist says BUY (or they can act standalone).
 *
 * Signal structure:
 *   { mint, symbol, signal: 'BUY'|'SELL'|'HOLD', confidence: 0-1,
 *     reasons: string[], rsi, ema9, ema21, macd, volDelta, updatedAt }
 * ─────────────────────────────────────────────────────────────────────────────
 */

import fs   from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(process.cwd(), '.env') });

const SIGNALS_DIR   = path.join(process.cwd(), 'signals');
const STRATEGY_FILE = path.join(SIGNALS_DIR, 'chart_strategy.json');
const TRENDING_FILE = path.join(SIGNALS_DIR, 'trending.json');
const SCAN_MS       = 20_000; // analyse every 20s

// ── Math helpers ──────────────────────────────────────────────────────────────
function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50; // neutral if not enough data
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    diff >= 0 ? (gains += diff) : (losses -= diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function macd(closes: number[]): { macd: number; signal: number; hist: number } {
  if (closes.length < 26) return { macd: 0, signal: 0, hist: 0 };
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12.map((v, i) => v - ema26[i]).slice(25); // align
  const signalLine = ema(macdLine, 9);
  const last = macdLine.length - 1;
  return {
    macd:   macdLine[last],
    signal: signalLine[last],
    hist:   macdLine[last] - signalLine[last],
  };
}

function volumeDelta(vols: number[]): number {
  // Compare avg last 3 candles to prior 3 — positive = volume expanding
  if (vols.length < 6) return 0;
  const recent = vols.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const prior  = vols.slice(-6, -3).reduce((a, b) => a + b, 0) / 3;
  return prior > 0 ? (recent - prior) / prior : 0;
}

// ── GeckoTerminal OHLCV ───────────────────────────────────────────────────────
// Free, no key needed. Returns 1m or 5m candles for Solana pools.
async function fetchOHLCV(poolAddress: string, resolution = '5m', limit = 50): Promise<{
  closes: number[]; volumes: number[]; timestamps: number[];
} | null> {
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/${resolution}?limit=${limit}&currency=usd`;
    const res  = await fetch(url, {
      headers: { 'Accept': 'application/json;version=20230302' },
      signal:  AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const ohlcv: any[][] = data?.data?.attributes?.ohlcv_list || [];
    if (ohlcv.length < 10) return null;

    // GeckoTerminal format: [timestamp, open, high, low, close, volume]
    const sorted = [...ohlcv].sort((a, b) => a[0] - b[0]);
    return {
      closes:     sorted.map(c => c[4]),
      volumes:    sorted.map(c => c[5]),
      timestamps: sorted.map(c => c[0]),
    };
  } catch { return null; }
}

// Find pool address for a mint via DexScreener
async function getPoolAddress(mint: string): Promise<string | null> {
  try {
    const res  = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(6000) });
    const data = await res.json();
    const pair = (data?.pairs || []).find((p: any) => p.chainId === 'solana');
    return pair?.pairAddress || null;
  } catch { return null; }
}

// ── Signal logic ──────────────────────────────────────────────────────────────
interface Signal {
  mint: string; symbol: string;
  signal: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  reasons: string[];
  rsi: number; ema9: number; ema21: number;
  macd: number; macdHist: number; volDelta: number;
  updatedAt: number;
}

function analyseCandles(mint: string, symbol: string, closes: number[], volumes: number[]): Signal {
  const rsiVal   = rsi(closes);
  const ema9Val  = ema(closes, 9)[ema(closes, 9).length - 1];
  const ema21Val = ema(closes, 21)[ema(closes, 21).length - 1];
  const macdRes  = macd(closes);
  const volDel   = volumeDelta(volumes);
  const lastClose = closes[closes.length - 1];
  const prevClose = closes[closes.length - 2];
  const priceMom  = (lastClose - prevClose) / prevClose * 100;

  const reasons: string[] = [];
  let buyScore = 0, sellScore = 0;

  // RSI
  if (rsiVal < 35)       { reasons.push(`RSI oversold ${rsiVal.toFixed(0)}`); buyScore += 2; }
  else if (rsiVal < 50)  { reasons.push(`RSI neutral-low ${rsiVal.toFixed(0)}`); buyScore += 1; }
  else if (rsiVal > 72)  { reasons.push(`RSI overbought ${rsiVal.toFixed(0)}`); sellScore += 2; }
  else if (rsiVal > 60)  { reasons.push(`RSI elevated ${rsiVal.toFixed(0)}`); sellScore += 1; }

  // EMA crossover
  if (ema9Val > ema21Val) {
    const spread = (ema9Val - ema21Val) / ema21Val * 100;
    reasons.push(`EMA9 > EMA21 +${spread.toFixed(1)}%`);
    buyScore += spread > 2 ? 2 : 1;
  } else {
    const spread = (ema21Val - ema9Val) / ema21Val * 100;
    reasons.push(`EMA9 < EMA21 -${spread.toFixed(1)}%`);
    sellScore += spread > 2 ? 2 : 1;
  }

  // MACD
  if (macdRes.hist > 0 && macdRes.macd > macdRes.signal) {
    reasons.push(`MACD bullish hist:+${macdRes.hist.toFixed(6)}`);
    buyScore += 1;
  } else if (macdRes.hist < 0) {
    reasons.push(`MACD bearish hist:${macdRes.hist.toFixed(6)}`);
    sellScore += 1;
  }
  // MACD crossover (extra weight)
  if (closes.length >= 3) {
    const prevMacdHist = macd(closes.slice(0, -1)).hist;
    if (prevMacdHist < 0 && macdRes.hist > 0) { reasons.push('MACD crossed bullish ↑'); buyScore += 2; }
    if (prevMacdHist > 0 && macdRes.hist < 0) { reasons.push('MACD crossed bearish ↓'); sellScore += 2; }
  }

  // Volume delta
  if (volDel > 0.30)       { reasons.push(`Vol surge +${(volDel*100).toFixed(0)}%`); buyScore += 2; }
  else if (volDel > 0.10)  { reasons.push(`Vol rising +${(volDel*100).toFixed(0)}%`); buyScore += 1; }
  else if (volDel < -0.20) { reasons.push(`Vol drying -${(Math.abs(volDel)*100).toFixed(0)}%`); sellScore += 1; }

  // Price momentum
  if (priceMom > 3)       { reasons.push(`Candle +${priceMom.toFixed(1)}%`); buyScore += 1; }
  else if (priceMom < -3) { reasons.push(`Candle ${priceMom.toFixed(1)}%`); sellScore += 1; }

  // Verdict
  const total = buyScore + sellScore;
  let signal: Signal['signal'] = 'HOLD';
  let confidence = 0;

  if (buyScore > sellScore && buyScore >= 3) {
    signal     = 'BUY';
    confidence = Math.min(buyScore / 9, 0.99);
  } else if (sellScore > buyScore && sellScore >= 3) {
    signal     = 'SELL';
    confidence = Math.min(sellScore / 9, 0.99);
  } else {
    confidence = 0.3;
  }

  return { mint, symbol, signal, confidence, reasons, rsi: rsiVal, ema9: ema9Val, ema21: ema21Val, macd: macdRes.macd, macdHist: macdRes.hist, volDelta: volDel, updatedAt: Date.now() };
}

// ── Main analysis loop ────────────────────────────────────────────────────────
async function analyseAll() {
  if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });

  const signals: Record<string, Signal> = {};
  let candidates: { mint: string; symbol: string }[] = [];

  // Pull candidates from trending.json
  try {
    const t = JSON.parse(fs.readFileSync(TRENDING_FILE, 'utf-8'));
    const tokenList = t.mints || t.tokens || [];
    candidates = tokenList.map((tk: any) => ({ mint: tk.mint || tk.address, symbol: tk.symbol })).filter((c: any) => c.mint);
  } catch { /* no trending yet */ }

  // Also pull from pumpfun positions if any
  try {
    const pf = JSON.parse(fs.readFileSync(path.join(SIGNALS_DIR, 'pumpfun_positions.json'), 'utf-8'));
    for (const p of (pf.positions || [])) { if (!candidates.find(c => c.mint === p.mint)) candidates.push({ mint: p.mint, symbol: p.symbol }); }
  } catch { /* ignore */ }

  if (!candidates.length) {
    console.log('[STRAT] No candidates — waiting for trending/pumpfun...');
    return;
  }

  let analysed = 0, buys = 0, sells = 0, holds = 0;

  for (const { mint, symbol } of candidates.slice(0, 8)) { // cap at 8 to avoid rate limits
    const pool = await getPoolAddress(mint);
    if (!pool) { console.log(`[STRAT] ⚠️ No pool for ${symbol}`); continue; }

    const ohlcv = await fetchOHLCV(pool, '5m', 50);
    if (!ohlcv) { console.log(`[STRAT] ⚠️ No OHLCV for ${symbol}`); continue; }

    const sig = analyseCandles(mint, symbol, ohlcv.closes, ohlcv.volumes);
    signals[mint] = sig;
    analysed++;

    const icon   = sig.signal === 'BUY' ? '📈' : sig.signal === 'SELL' ? '📉' : '➡️';
    const confStr = `${(sig.confidence * 100).toFixed(0)}%`;
    console.log(`[STRAT] ${icon} ${symbol.padEnd(8)} ${sig.signal.padEnd(4)} (${confStr.padStart(3)}) | RSI:${sig.rsi.toFixed(0)} | EMA9${sig.ema9 > sig.ema21 ? '>' : '<'}EMA21 | MACD:${sig.macdHist > 0 ? '↑' : '↓'} | Vol:${(sig.volDelta*100).toFixed(0)}% | ${sig.reasons.slice(0,3).join(', ')}`);

    if (sig.signal === 'BUY')  buys++;
    else if (sig.signal === 'SELL') sells++;
    else holds++;

    await new Promise(r => setTimeout(r, 500)); // rate-limit GeckoTerminal
  }

  fs.writeFileSync(STRATEGY_FILE, JSON.stringify({ signals, updatedAt: Date.now() }, null, 2));
  console.log(`[STRAT] 📊 Cycle done → ${analysed} tokens | BUY:${buys} SELL:${sells} HOLD:${holds} | file: signals/chart_strategy.json`);
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║  PCP CHART STRATEGIST — TA Signal Engine       ║');
  console.log('║  RSI-14 | EMA 9/21 Crossover | MACD | Vol Δ   ║');
  console.log(`║  Scan: every ${SCAN_MS/1000}s | Source: GeckoTerminal       ║`);
  console.log('╚════════════════════════════════════════════════╝');

  await analyseAll();
  setInterval(analyseAll, SCAN_MS);
  process.on('SIGTERM', () => process.exit(0));
}

main().catch(e => { console.error('[STRAT] Fatal:', e); process.exit(1); });
