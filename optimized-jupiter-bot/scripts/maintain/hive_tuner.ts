import axios from 'axios';
import fs from 'fs/promises';

const DROPLET_BASE = 'http://192.168.50.81:3000'; // Target local nextjs execution path based on initial env
const OLLAMA_URL = 'http://localhost:11434/api/generate';

const TUNE_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
const MIN_TRADES_FOR_TUNING = 10;

interface Trade {
  tradeId: string;
  timestamp: number;
  side: 'BUY' | 'SELL';
  mint: string;
  success: boolean;
  realizedPnL?: number;
  amountIn: number;
  amountOut: number;
  dex: string;
}

async function fetchRecentTrades(): Promise<Trade[]> {
  try {
      const resp = await axios.get(`${DROPLET_BASE}/api/trades`);
      return resp.data;
  } catch (err: any) {
      console.warn('[HIVE] Remote /api/trades failed. Trying local mock or fallback if available:', err.message);
      return [];
  }
}

function computeMetrics(trades: Trade[]) {
  const completedTrades = new Map<string, { buy: Trade; sell: Trade }>();
  for (const t of trades) {
    if (!completedTrades.has(t.tradeId)) {
      completedTrades.set(t.tradeId, { buy: null!, sell: null! });
    }
    const entry = completedTrades.get(t.tradeId)!;
    if (t.side === 'BUY') entry.buy = t;
    if (t.side === 'SELL') entry.sell = t;
  }

  const roundTrips = Array.from(completedTrades.values()).filter(rt => rt.buy && rt.sell);
  const successful = roundTrips.filter(rt => rt.sell.success && rt.sell.realizedPnL! > 0);
  const winRate = roundTrips.length ? successful.length / roundTrips.length : 0;
  const avgPnL = successful.reduce((sum, rt) => sum + rt.sell.realizedPnL!, 0) / (successful.length || 1);
  const totalPnL = successful.reduce((sum, rt) => sum + rt.sell.realizedPnL!, 0);
  
  return {
    totalTrades: roundTrips.length,
    winRate,
    avgPnL,
    totalPnL,
    lastTradeTime: trades.length ? trades[trades.length-1].timestamp : 0,
  };
}

async function askOllama(metrics: any, currentConfig: any): Promise<any> {
  const prompt = `
You are a DeFi arbitrage tuning agent. Based on the following performance metrics and current configuration, suggest updated values for these parameters:
- MIN_SPREAD_PCT (minimum gross spread % to enter a trade)
- PRIORITY_FEE_MICROLAMPORTS (priority fee in microlamports)
- BUY_AMOUNT_SOL (SOL amount per trade instead of USDC)
- TRADE_COOLDOWN_MS (cooldown between same mint trades)

Current config:
MIN_SPREAD_PCT: ${currentConfig.MIN_SPREAD_PCT}
PRIORITY_FEE_MICROLAMPORTS: ${currentConfig.PRIORITY_FEE_MICROLAMPORTS}
BUY_AMOUNT_SOL: ${currentConfig.BUY_AMOUNT_SOL}
TRADE_COOLDOWN_MS: ${currentConfig.TRADE_COOLDOWN_MS}

Performance metrics:
Total trades: ${metrics.totalTrades}
Win rate: ${(metrics.winRate * 100).toFixed(1)}%
Average PnL per winning trade: ${metrics.avgPnL.toFixed(4)} SOL
Total PnL: ${metrics.totalPnL.toFixed(4)} SOL

If win rate < 40%, decrease MIN_SPREAD_PCT by 0.2% and increase priority fee slightly.
If win rate > 70%, increase MIN_SPREAD_PCT by 0.1% to capture higher quality.
If total trades < 10, keep current config.

Return ONLY a JSON object with the new values, no extra text. Example:
{"MIN_SPREAD_PCT":1.3,"PRIORITY_FEE_MICROLAMPORTS":55000,"BUY_AMOUNT_SOL":0.05,"TRADE_COOLDOWN_MS":45000}
`;

  try {
      const response = await axios.post(OLLAMA_URL, {
        model: 'llama3.2:1b',
        prompt,
        stream: false,
        format: 'json',
      });
      return JSON.parse(response.data.response);
  } catch (err: any) {
      console.error('[HIVE] Ollama query failed:', err.message);
      return {};
  }
}

async function applyUpdates(updates: any) {
  try {
      await axios.post(`${DROPLET_BASE}/api/config`, { updates });
      console.log('[HIVE] Applied updates across remote node pipeline:', updates);
  } catch(e: any) {
      console.error('[HIVE] Failed applying updates:', e.message);
  }
}

async function getCurrentConfig(): Promise<any> {
  return {
    MIN_SPREAD_PCT: parseFloat(process.env.MIN_SPREAD_PCT || '1.5'),
    PRIORITY_FEE_MICROLAMPORTS: parseInt(process.env.PRIORITY_FEE_MICROLAMPORTS || '50000'),
    BUY_AMOUNT_SOL: parseFloat(process.env.BUY_AMOUNT_SOL || '0.05'),
    TRADE_COOLDOWN_MS: parseInt(process.env.TRADE_COOLDOWN_MS || '60000'),
  };
}

async function tuneLoop() {
  console.log('[HIVE] Deploying intelligence layer parameters... Waiting for market data');
  while (true) {
    try {
      const trades = await fetchRecentTrades();
      if (trades.length < MIN_TRADES_FOR_TUNING) {
        console.log(`[HIVE] Data buffer pooling. Acquired ${trades.length} of ${MIN_TRADES_FOR_TUNING} targets required for tuning computation...`);
        await new Promise(r => setTimeout(r, TUNE_INTERVAL_MS));
        continue;
      }
      const metrics = computeMetrics(trades);
      console.log('[HIVE] Trade Metrics Evaluation:', metrics);
      const currentConfig = await getCurrentConfig();
      const suggestions = await askOllama(metrics, currentConfig);
      console.log('[HIVE] Neural drift projection computed:', suggestions);
      
      let changed = false;
      for (const [k, v] of Object.entries(suggestions)) {
        if (currentConfig[k] !== v && v !== undefined) changed = true;
      }
      
      if (changed) {
        await applyUpdates(suggestions);
      } else {
        console.log('[HIVE] Drift projections nominal. Continuing operation.');
      }
    } catch (err) {
      console.error('[HIVE] Error in inference layer tuning sequence:', err);
    }
    await new Promise(r => setTimeout(r, TUNE_INTERVAL_MS));
  }
}

tuneLoop();
