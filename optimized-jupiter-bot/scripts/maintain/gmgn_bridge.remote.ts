/**
 * gmgn_bridge.ts — GMGN Data Bridge
 * ─────────────────────────────────────────────────────────────────────
 * PM2-managed process that periodically pulls GMGN intelligence via
 * their authenticated CLI and writes it to the signals/ directory
 * for the sniper and Gemma4 to consume.
 *
 * Data feeds:
 *   1. Trending tokens (5m + 1h) → signals/gmgn_trending.json
 *   2. Smart money trades       → signals/gmgn_smartmoney.json
 *   3. Token security checks    → signals/gmgn_security.json (on-demand)
 *
 * The sniper reads gmgn_trending.json during its poll cycle to discover
 * tokens that DexScreener might miss (GMGN sees smart wallet flow).
 * ─────────────────────────────────────────────────────────────────────
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

const SIGNALS_DIR = path.join(process.cwd(), 'signals');
const GMGN_TRENDING = path.join(SIGNALS_DIR, 'gmgn_trending.json');
const GMGN_SMARTMONEY = path.join(SIGNALS_DIR, 'gmgn_smartmoney.json');
const GMGN_FOLLOW_MONITOR = path.join(SIGNALS_DIR, 'gmgn_follow_monitor.json');
const GMGN_SECURITY = path.join(SIGNALS_DIR, 'gmgn_security.json');
const GMGN_ACTIVE_POSITIONS = path.join(SIGNALS_DIR, 'gmgn_active_positions.json');
const SNIPER_POSITIONS = path.join(SIGNALS_DIR, 'sniper_positions.json');
const TRENDING_FILE = path.join(SIGNALS_DIR, 'trending.json');
const FOLLOW_MONITOR_WINDOW_MS = 5 * 60_000;
const FOLLOW_MONITOR_MIN_INFLOW_USD = 250;
const FOLLOW_MONITOR_MIN_TRADES = 2;
const GMGN_CLI_BIN = process.platform === 'win32' ? 'gmgn-cli.cmd' : '/usr/bin/gmgn-cli';
const GMGN_CLI_TIMEOUT_MS = 120_000;
const GLOBAL_NPM_BIN = process.platform === 'win32'
  ? path.join(process.env.APPDATA || '', 'npm')
  : '/usr/local/bin';
const GMGN_CLI_JS = process.platform === 'win32'
  ? path.join(GLOBAL_NPM_BIN, 'node_modules', 'gmgn-cli', 'dist', 'index.js')
  : '';

let followMonitorDisabledLogged = false;
let trendingInFlight = false;
let smartMoneyInFlight = false;
let followMonitorInFlight = false;
let securityInFlight = false;
let activePositionsInFlight = false;

dotenv.config({ path: path.join(process.cwd(), '.env') });

// Ensure signals dir exists
if (!fs.existsSync(SIGNALS_DIR)) fs.mkdirSync(SIGNALS_DIR, { recursive: true });

// ── Helpers ──────────────────────────────────────────────────────────────────

function runGmgnCli(args: string): any | null {
  try {
    const argv = args.split(/\s+/).filter(Boolean);
    const useDirectNode = process.platform === 'win32' && fs.existsSync(GMGN_CLI_JS);
    const cmd = useDirectNode ? process.execPath : GMGN_CLI_BIN;
    const cmdArgs = useDirectNode ? [GMGN_CLI_JS, ...argv, '--raw'] : [...argv, '--raw'];
    const res = spawnSync(cmd, cmdArgs, {
      cwd: process.cwd(),
      timeout: GMGN_CLI_TIMEOUT_MS,
      encoding: 'utf-8',
      windowsHide: true,
      shell: true,
      env: { ...process.env },
    });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      const stderr = String(res.stderr || '').trim();
      const stdout = String(res.stdout || '').trim();
      throw new Error(stderr || stdout || `gmgn-cli exited ${res.status}`);
    }
    return JSON.parse(String(res.stdout || '').trim());
  } catch (e: any) {
    console.error(`[GMGN-BRIDGE] CLI error: ${e.message?.split('\n')[0]}`);
    return null;
  }
}

function safeWrite(filePath: string, data: any) {
  const payload = JSON.stringify(data, null, 2);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, payload);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (e: any) {
      if (attempt === 3) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1));
    }
  }
  try {
    fs.writeFileSync(filePath, payload);
  } finally {
    if (fs.existsSync(tmp)) {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
}

function asArray<T = any>(value: any): T[] {
  return Array.isArray(value) ? value : [];
}

function parseNumber(value: any): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? '0'));
  return Number.isFinite(n) ? n : 0;
}

// ── Feed 1: Trending Tokens ────────────────────────────────────────────────

interface TrendingToken {
  mint: string;
  symbol: string;
  name: string;
  price: number;
  marketCap: number;
  liquidity: number;
  volume5m: number;
  volume1h: number;
  swaps5m: number;
  swaps1h: number;
  buys: number;
  sells: number;
  priceChange5m: number;
  priceChange1h: number;
  holders: number;
  smartMoney: number;
  source: 'gmgn';
  fetchedAt: number;
}

interface FollowMonitorToken {
  mint: string;
  symbol: string;
  inflowUsd5m: number;
  tradeCount5m: number;
  uniqueWallets5m: number;
  fullPositionOpens5m: number;
  lastTradeAt: number;
  source: 'gmgn-follow-monitor';
}

interface ActivePositionSnapshot {
  mint: string;
  symbol: string;
  openedAt?: number;
  entryMode?: string;
  priceUsd: number;
  priceSol: number;
  liquidityUsd: number;
  holders: number;
  smartWallets: number;
  sniperWallets: number;
  top10HolderRate: number;
  launchpad: string;
  standard: string;
  creationTimestamp: number;
  poolCreationTimestamp: number;
  klineResolution: string;
  klineOpenUsd: number;
  klineHighUsd: number;
  klineLowUsd: number;
  klineCloseUsd: number;
  klineVolume: number;
  klineTime: number;
  link: string;
  security: any;
  fetchedAt: number;
}

function parseTrendingRank(rank: any[]): TrendingToken[] {
  const tokens: TrendingToken[] = [];
  for (const t of rank) {
    try {
      tokens.push({
        mint: t.address || '',
        symbol: t.symbol || '???',
        name: t.name || '',
        price: parseFloat(t.price || '0'),
        marketCap: parseFloat(t.market_cap || '0'),
        liquidity: parseFloat(t.liquidity || '0'),
        volume5m: parseFloat(t.volume_5m || t.volume || '0'),
        volume1h: parseFloat(t.volume_1h || t.volume || '0'),
        swaps5m: parseInt(t.swaps_5m || t.swaps || '0'),
        swaps1h: parseInt(t.swaps_1h || t.swaps || '0'),
        buys: parseInt(t.buys || '0'),
        sells: parseInt(t.sells || '0'),
        priceChange5m: parseFloat(t.price_change_percent_5m || t.price_change_5m || '0'),
        priceChange1h: parseFloat(t.price_change_percent_1h || t.price_change_1h || '0'),
        holders: parseInt(t.holder_count || '0'),
        smartMoney: parseInt(t.smart_money || '0'),
        source: 'gmgn',
        fetchedAt: Date.now(),
      });
    } catch { /* skip malformed */ }
  }
  return tokens;
}

async function fetchTrending() {
  if (trendingInFlight) return 0;
  trendingInFlight = true;
  try {
  console.log('[GMGN-BRIDGE] Fetching new trenches (newly created pools)...');
  const trenches = runGmgnCli('market trenches --chain sol --type new_creation --filter-preset safe');
  const pumpTrenches = runGmgnCli('market trenches --chain sol --type near_completion --filter-preset safe');

  console.log('[GMGN-BRIDGE] Fetching 5m trending...');
  const data5m = runGmgnCli('market trending --chain sol --interval 5m --limit 30 --order-by swaps --direction desc');

  const tokensNew = trenches?.data?.new_creation ? parseTrendingRank(trenches.data.new_creation) : [];
  const tokensPump = pumpTrenches?.data?.pump ? parseTrendingRank(pumpTrenches.data.pump) : [];
  const tokens5m = data5m?.data?.rank ? parseTrendingRank(data5m.data.rank) : [];

  // Merge, dedup by mint
  const seen = new Set<string>();
  const merged: TrendingToken[] = [];

  // Prioritize NEW and PUMP tokens for massive latency advantage
  for (const t of [...tokensNew, ...tokensPump, ...tokens5m]) {
    if (!t.mint || seen.has(t.mint)) continue;
    seen.add(t.mint);
    merged.push(t);
  }

  safeWrite(GMGN_TRENDING, {
    updatedAt: Date.now(),
    count: merged.length,
    tokens: merged,
  });

  console.log(`[GMGN-BRIDGE] Discovery: ${tokensNew.length} NEW + ${tokensPump.length} PUMP + ${tokens5m.length} 5m = ${merged.length} unique tokens`);

  // Also inject into the sniper's trending.json for immediate discovery
  injectIntoSniperTrending(merged);

  return merged.length;
  } finally {
    trendingInFlight = false;
  }
}

function injectIntoSniperTrending(gmgnTokens: TrendingToken[]) {
  let existing: any[] = [];
  try {
    if (fs.existsSync(TRENDING_FILE)) {
      existing = JSON.parse(fs.readFileSync(TRENDING_FILE, 'utf-8'));
      if (!Array.isArray(existing)) existing = [];
    }
  } catch { existing = []; }

  const existingMints = new Set(existing.map((t: any) => t.baseToken?.address || t.mint));
  let added = 0;

  for (const t of gmgnTokens) {
    if (!t.mint || existingMints.has(t.mint)) continue;
    if (t.liquidity < 5000 || t.volume5m < 1000) continue;

    existing.push({
      chainId: 'solana',
      dexId: 'gmgn-bridge',
      url: `https://gmgn.ai/sol/token/${t.mint}`,
      baseToken: { address: t.mint, name: t.name, symbol: t.symbol },
      quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
      priceUsd: String(t.price),
      volume: { h1: t.volume1h, m5: t.volume5m },
      priceChange: { h1: t.priceChange1h, m5: t.priceChange5m },
      liquidity: { usd: t.liquidity },
      fdv: t.marketCap,
      txns: { h1: { buys: t.buys, sells: t.sells } },
      _gmgn: { smartMoney: t.smartMoney, holders: t.holders, source: 'gmgn-bridge' },
    });
    existingMints.add(t.mint);
    added++;
  }

  if (added > 0) {
    safeWrite(TRENDING_FILE, existing);
    console.log(`[GMGN-BRIDGE] Injected ${added} GMGN tokens into sniper trending (${existing.length} total)`);
  }
}

// ── Feed 2: Smart Money Trades ─────────────────────────────────────────────

async function fetchSmartMoney() {
  if (smartMoneyInFlight) return;
  smartMoneyInFlight = true;
  try {
  console.log('[GMGN-BRIDGE] Fetching smart money buys...');
  const buys = runGmgnCli('track smartmoney --chain sol --limit 50 --side buy');

  console.log('[GMGN-BRIDGE] Fetching smart money sells...');
  const sells = runGmgnCli('track smartmoney --chain sol --limit 50 --side sell');

  const buyTrades = buys?.data?.trades || buys?.data || [];
  const sellTrades = sells?.data?.trades || sells?.data || [];

  safeWrite(GMGN_SMARTMONEY, {
    updatedAt: Date.now(),
    buys: Array.isArray(buyTrades) ? buyTrades.slice(0, 50) : [],
    sells: Array.isArray(sellTrades) ? sellTrades.slice(0, 50) : [],
  });

  const buyCount = Array.isArray(buyTrades) ? buyTrades.length : 0;
  const sellCount = Array.isArray(sellTrades) ? sellTrades.length : 0;
  console.log(`[GMGN-BRIDGE] Smart money: ${buyCount} buys, ${sellCount} sells`);
  } finally {
    smartMoneyInFlight = false;
  }
}

async function fetchFollowMonitor() {
  if (followMonitorInFlight) return 0;
  followMonitorInFlight = true;
  try {
  console.log('[GMGN-BRIDGE] Fetching follow monitor buys...');
  const resp = runGmgnCli('track follow-wallet --chain sol --limit 100 --side buy');
  if (!resp) {
    if (!followMonitorDisabledLogged) {
      console.log('[GMGN-BRIDGE] Follow monitor unavailable: CLI auth/config not ready');
      followMonitorDisabledLogged = true;
    }
    safeWrite(GMGN_FOLLOW_MONITOR, {
      updatedAt: Date.now(),
      enabled: false,
      reason: 'follow-wallet auth unavailable',
      count: 0,
      tokens: [],
    });
    return 0;
  }

  followMonitorDisabledLogged = false;
  const rows = asArray(resp?.list || resp?.data?.list || resp?.data);
  const cutoffSeconds = Math.floor((Date.now() - FOLLOW_MONITOR_WINDOW_MS) / 1000);
  const grouped = new Map<string, {
    mint: string;
    symbol: string;
    inflowUsd5m: number;
    tradeCount5m: number;
    wallets: Set<string>;
    fullPositionOpens5m: number;
    lastTradeAt: number;
  }>();

  for (const row of rows) {
    const ts = parseNumber(row?.timestamp);
    const mint = String(row?.base_address || '').trim();
    if (!mint || ts < cutoffSeconds) continue;

    const symbol = String(row?.base_token?.symbol || row?.symbol || '???').trim() || '???';
    const maker = String(row?.maker || row?.maker_info?.address || '').trim();
    const amountUsd = parseNumber(row?.amount_usd || row?.cost_usd);
    const existing = grouped.get(mint) || {
      mint,
      symbol,
      inflowUsd5m: 0,
      tradeCount5m: 0,
      wallets: new Set<string>(),
      fullPositionOpens5m: 0,
      lastTradeAt: ts,
    };

    existing.inflowUsd5m += amountUsd;
    existing.tradeCount5m += 1;
    existing.lastTradeAt = Math.max(existing.lastTradeAt, ts);
    if (maker) existing.wallets.add(maker);
    if (String(row?.is_open_or_close ?? '') === '1') existing.fullPositionOpens5m += 1;
    grouped.set(mint, existing);
  }

  const tokens: FollowMonitorToken[] = Array.from(grouped.values())
    .map((item) => ({
      mint: item.mint,
      symbol: item.symbol,
      inflowUsd5m: Number(item.inflowUsd5m.toFixed(2)),
      tradeCount5m: item.tradeCount5m,
      uniqueWallets5m: item.wallets.size,
      fullPositionOpens5m: item.fullPositionOpens5m,
      lastTradeAt: item.lastTradeAt,
      source: 'gmgn-follow-monitor' as const,
    }))
    .filter((item) =>
      item.inflowUsd5m >= FOLLOW_MONITOR_MIN_INFLOW_USD &&
      item.tradeCount5m >= FOLLOW_MONITOR_MIN_TRADES
    )
    .sort((a, b) =>
      (b.inflowUsd5m - a.inflowUsd5m) ||
      (b.uniqueWallets5m - a.uniqueWallets5m) ||
      (b.lastTradeAt - a.lastTradeAt)
    );

  safeWrite(GMGN_FOLLOW_MONITOR, {
    updatedAt: Date.now(),
    enabled: true,
    windowMinutes: 5,
    count: tokens.length,
    tokens,
  });

  injectFollowMonitorIntoTrending(tokens);
  console.log(`[GMGN-BRIDGE] Follow monitor: ${tokens.length} inflow token(s) in 5m window`);
  return tokens.length;
  } finally {
    followMonitorInFlight = false;
  }
}

function injectFollowMonitorIntoTrending(tokens: FollowMonitorToken[]) {
  let existing: any[] = [];
  try {
    if (fs.existsSync(TRENDING_FILE)) {
      existing = JSON.parse(fs.readFileSync(TRENDING_FILE, 'utf-8'));
      if (!Array.isArray(existing)) existing = [];
    }
  } catch {
    existing = [];
  }

  const indexByMint = new Map<string, any>();
  for (const row of existing) {
    const mint = row?.baseToken?.address || row?.mint;
    if (mint) indexByMint.set(mint, row);
  }

  let touched = 0;
  for (const token of tokens) {
    const existingRow = indexByMint.get(token.mint);
    if (existingRow) {
      existingRow._gmgn = {
        ...(existingRow._gmgn || {}),
        source: existingRow._gmgn?.source || 'gmgn-bridge',
        followMonitor: {
          inflowUsd5m: token.inflowUsd5m,
          tradeCount5m: token.tradeCount5m,
          uniqueWallets5m: token.uniqueWallets5m,
          fullPositionOpens5m: token.fullPositionOpens5m,
          lastTradeAt: token.lastTradeAt,
        },
      };
      touched++;
      continue;
    }

    existing.push({
      chainId: 'solana',
      dexId: 'gmgn-follow-monitor',
      url: `https://gmgn.ai/sol/token/${token.mint}`,
      baseToken: { address: token.mint, name: token.symbol, symbol: token.symbol },
      quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
      priceUsd: '0',
      volume: { h1: token.inflowUsd5m, m5: token.inflowUsd5m },
      priceChange: { h1: 0, m5: 0 },
      liquidity: { usd: 0 },
      fdv: 0,
      txns: { h1: { buys: token.tradeCount5m, sells: 0 } },
      _gmgn: {
        source: 'gmgn-follow-monitor',
        followMonitor: {
          inflowUsd5m: token.inflowUsd5m,
          tradeCount5m: token.tradeCount5m,
          uniqueWallets5m: token.uniqueWallets5m,
          fullPositionOpens5m: token.fullPositionOpens5m,
          lastTradeAt: token.lastTradeAt,
        },
      },
    });
    touched++;
  }

  if (touched > 0) {
    safeWrite(TRENDING_FILE, existing);
    console.log(`[GMGN-BRIDGE] Annotated ${touched} trending rows with follow-monitor inflow`);
  }
}

// ── Feed 3: Token Security (on-demand for sniper positions) ────────────────

export async function checkTokenSecurity(mint: string): Promise<any> {
  const data = runGmgnCli(`token security --chain sol --address ${mint}`);
  return data?.data || null;
}

export async function fetchTokenInfo(mint: string): Promise<any> {
  return runGmgnCli(`token info --chain sol --address ${mint}`);
}

export async function fetchTokenKline(
  mint: string,
  resolution = '1m',
  lookbackSeconds = 900
): Promise<any> {
  const now = Math.floor(Date.now() / 1000);
  const from = Math.max(0, now - lookbackSeconds);
  return runGmgnCli(`market kline --chain sol --address ${mint} --resolution ${resolution} --from ${from} --to ${now}`);
}

async function batchSecurityCheck() {
  if (securityInFlight) return;
  securityInFlight = true;
  try {
    // Check security for any tokens the sniper is tracking
    const posFile = path.join(SIGNALS_DIR, 'sniper_positions.json');
    if (!fs.existsSync(posFile)) return;

    const store = JSON.parse(fs.readFileSync(posFile, 'utf-8'));
    const positions = store.positions || [];
    if (positions.length === 0) return;

    const results: Record<string, any> = {};
    for (const pos of positions) {
      console.log(`[GMGN-BRIDGE] Security check: ${pos.symbol} (${pos.mint})`);
      const sec = await checkTokenSecurity(pos.mint);
      if (sec) results[pos.mint] = { ...sec, checkedAt: Date.now(), symbol: pos.symbol };
      // Rate limit between security checks
      await new Promise(r => setTimeout(r, 5000));
    }

    if (Object.keys(results).length > 0) {
      safeWrite(GMGN_SECURITY, { updatedAt: Date.now(), tokens: results });
      console.log(`[GMGN-BRIDGE] Security checked ${Object.keys(results).length} active positions`);
    }
  } catch (e: any) {
    console.warn('[GMGN-BRIDGE] Security check error:', e.message);
  } finally {
    securityInFlight = false;
  }
}

function computePriceSolFromTokenInfo(info: any): number {
  const quoteSymbol = String(info?.pool?.quote_symbol || '').toUpperCase();
  const baseReserve = parseNumber(info?.pool?.base_reserve);
  const quoteReserve = parseNumber(info?.pool?.quote_reserve);
  if (quoteSymbol === 'SOL' && baseReserve > 0 && quoteReserve > 0) {
    return quoteReserve / baseReserve;
  }
  return 0;
}

function annotateTrackedRows(rows: ActivePositionSnapshot[]) {
  let existing: any[] = [];
  try {
    if (fs.existsSync(TRENDING_FILE)) {
      existing = JSON.parse(fs.readFileSync(TRENDING_FILE, 'utf-8'));
      if (!Array.isArray(existing)) existing = [];
    }
  } catch {
    existing = [];
  }

  let touched = 0;
  for (const row of existing) {
    const mint = row?.baseToken?.address || row?.mint;
    if (!mint) continue;
    const snap = rows.find(r => r.mint === mint);
    if (!snap) continue;
    row.priceUsd = row.priceUsd && row.priceUsd !== '0' ? row.priceUsd : String(snap.priceUsd || 0);
    row.liquidity = { ...(row.liquidity || {}), usd: row?.liquidity?.usd || snap.liquidityUsd || 0 };
    row._gmgn = {
      ...(row._gmgn || {}),
      source: row?._gmgn?.source || 'gmgn-bridge',
      activePosition: {
        priceUsd: snap.priceUsd,
        priceSol: snap.priceSol,
        holders: snap.holders,
        smartWallets: snap.smartWallets,
        sniperWallets: snap.sniperWallets,
        top10HolderRate: snap.top10HolderRate,
        launchpad: snap.launchpad,
        standard: snap.standard,
        fetchedAt: snap.fetchedAt,
      },
    };
    touched++;
  }

  if (touched > 0) {
    safeWrite(TRENDING_FILE, existing);
    console.log(`[GMGN-BRIDGE] Annotated ${touched} trending rows with active-position GMGN metadata`);
  }
}

async function refreshActivePositionMetadata() {
  if (activePositionsInFlight) return;
  activePositionsInFlight = true;
  try {
    if (!fs.existsSync(SNIPER_POSITIONS)) {
      safeWrite(GMGN_ACTIVE_POSITIONS, { updatedAt: Date.now(), count: 0, positions: [] });
      return;
    }

    const store = JSON.parse(fs.readFileSync(SNIPER_POSITIONS, 'utf-8'));
    const positions = Array.isArray(store?.positions) ? store.positions : [];
    if (positions.length === 0) {
      safeWrite(GMGN_ACTIVE_POSITIONS, { updatedAt: Date.now(), count: 0, positions: [] });
      return;
    }

    const snapshots: ActivePositionSnapshot[] = [];
    for (const pos of positions) {
      console.log(`[GMGN-BRIDGE] Position snapshot: ${pos.symbol} (${pos.mint})`);
      const info = await fetchTokenInfo(pos.mint);
      const sec = await checkTokenSecurity(pos.mint);
      const kline = await fetchTokenKline(pos.mint, '1m', 900);
      if (!info) {
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }

      const candles = asArray<any>(kline?.list || kline?.data?.list || kline?.data);
      const latestCandle = candles.length > 0 ? candles[candles.length - 1] : null;

      const latestKlineCloseUsd = parseNumber(latestCandle?.close);
      const priceUsd = parseNumber(info?.price) || latestKlineCloseUsd;
      const priceSol = computePriceSolFromTokenInfo(info);
      snapshots.push({
        mint: pos.mint,
        symbol: pos.symbol,
        openedAt: pos.openedAt,
        entryMode: pos.entryMode,
        priceUsd,
        priceSol,
        liquidityUsd: parseNumber(info?.liquidity || info?.pool?.liquidity),
        holders: parseNumber(info?.holder_count || info?.stat?.holder_count),
        smartWallets: parseNumber(info?.wallet_tags_stat?.smart_wallets),
        sniperWallets: parseNumber(info?.wallet_tags_stat?.sniper_wallets),
        top10HolderRate: parseNumber(info?.dev?.top_10_holder_rate || info?.stat?.top_10_holder_rate),
        launchpad: String(info?.launchpad || ''),
        standard: String(info?.standard || ''),
        creationTimestamp: parseNumber(info?.creation_timestamp),
        poolCreationTimestamp: parseNumber(info?.pool?.creation_timestamp || info?.open_timestamp),
        klineResolution: '1m',
        klineOpenUsd: parseNumber(latestCandle?.open),
        klineHighUsd: parseNumber(latestCandle?.high),
        klineLowUsd: parseNumber(latestCandle?.low),
        klineCloseUsd: latestKlineCloseUsd,
        klineVolume: parseNumber(latestCandle?.volume),
        klineTime: parseNumber(latestCandle?.time),
        link: String(info?.link?.gmgn || ''),
        security: sec || null,
        fetchedAt: Date.now(),
      });
      await new Promise(r => setTimeout(r, 1500));
    }

    safeWrite(GMGN_ACTIVE_POSITIONS, {
      updatedAt: Date.now(),
      count: snapshots.length,
      positions: snapshots,
    });
    annotateTrackedRows(snapshots);
    console.log(`[GMGN-BRIDGE] Refreshed ${snapshots.length} active position snapshot(s)`);
  } catch (e: any) {
    console.warn('[GMGN-BRIDGE] Active position snapshot error:', e.message);
  } finally {
    activePositionsInFlight = false;
  }
}

// ── Main Loop ──────────────────────────────────────────────────────────────

const TRENDING_INTERVAL = 60_000;     // 60s — trending tokens
const SMARTMONEY_INTERVAL = 120_000;  // 2min — smart money trades
const FOLLOW_MONITOR_INTERVAL = 60_000; // 60s — followed-wallet 5m inflow
const SECURITY_INTERVAL = 300_000;    // 5min — security checks on active positions
const ACTIVE_POSITION_INTERVAL = 60_000; // 60s — GMGN metadata for live positions

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  GMGN DATA BRIDGE v1.0                  ║');
  console.log('║  Trending + Smart Money + Security       ║');
  console.log('║  Feeds → signals/ for sniper discovery   ║');
  console.log('╚══════════════════════════════════════════╝');

  // Initial fetch
  await fetchTrending();
  await fetchSmartMoney();
  await fetchFollowMonitor();
  await refreshActivePositionMetadata();

  // Periodic feeds
  setInterval(async () => {
    try { await fetchTrending(); } catch (e: any) { console.error('[GMGN-BRIDGE] Trending error:', e.message); }
  }, TRENDING_INTERVAL);

  setInterval(async () => {
    try { await fetchSmartMoney(); } catch (e: any) { console.error('[GMGN-BRIDGE] Smart money error:', e.message); }
  }, SMARTMONEY_INTERVAL);

  setInterval(async () => {
    try { await fetchFollowMonitor(); } catch (e: any) { console.error('[GMGN-BRIDGE] Follow monitor error:', e.message); }
  }, FOLLOW_MONITOR_INTERVAL);

  setInterval(async () => {
    try { await batchSecurityCheck(); } catch (e: any) { console.error('[GMGN-BRIDGE] Security error:', e.message); }
  }, SECURITY_INTERVAL);

  setInterval(async () => {
    try { await refreshActivePositionMetadata(); } catch (e: any) { console.error('[GMGN-BRIDGE] Active position snapshot error:', e.message); }
  }, ACTIVE_POSITION_INTERVAL);

  // Keep process alive
  process.on('SIGTERM', () => {
    console.log('[GMGN-BRIDGE] Shutting down...');
    process.exit(0);
  });
}

main().catch(e => {
  console.error('[GMGN-BRIDGE] Fatal:', e);
  process.exit(1);
});
