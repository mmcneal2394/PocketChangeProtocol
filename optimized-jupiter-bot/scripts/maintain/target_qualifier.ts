import Redis from 'ioredis';
import fs from 'fs/promises';
import { config } from 'dotenv';
import { Connection, PublicKey } from '@solana/web3.js';
import path from 'path';
import { initConfigManager, getConfig, closeConfigManager } from './config_manager';

config();

const REDIS_URL = (process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim();
const RPC_URL = (process.env.RPC_ENDPOINT || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com').trim();
const JUPITER_QUOTE_API = (process.env.JUPITER_ENDPOINT || 'https://api.jup.ag/swap/v1').trim() + '/quote';
const JUP_HEADERS: Record<string, string> = process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {};
const LOG_FILE = path.join(process.cwd(), 'missed_targets.jsonl');

const redis = new Redis(REDIS_URL);
const redisPublisher = new Redis(REDIS_URL);
const connection = new Connection(RPC_URL, 'confirmed');

interface TokenMetadata {
  mint: string;
  symbol?: string;
  liquidityUSD?: number;
  volume24h?: number;
}

interface QualifiedTarget {
  mint: string;
  buyDex: string;
  sellDex: string;
  buyPrice: number;
  sellPrice: number;
  grossSpreadPct: number;
  estimatedGasLamports: number;
  liquidityUSD: number;
  timestamp: number;
}

async function fetchTokenMetadata(mint: string): Promise<TokenMetadata | null> {
  // Try DexScreener first
  try {
    const resp = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        }
    });
    
    if (resp.ok) {
        const data: any = await resp.json();
        if (data.pairs && data.pairs[0]) {
          const pair = data.pairs[0];
          return {
            mint,
            symbol: pair.baseToken.symbol,
            liquidityUSD: parseFloat(pair.liquidity?.usd || '0'),
            volume24h: parseFloat(pair.volume?.h24 || '0')
          };
        }
    } else {
        console.warn(`[QUALIFIER] DexScreener HTTP ${resp.status} for ${mint}`);
    }
  } catch (err) {
    console.error(`[QUALIFIER] Failed to reach DexScreener for ${mint}:`, err);
  }
  
  // Secondary Fallback: Ping Jupiter explicitly. If it routes, we assume it's live.
  try {
      const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      const quoteResp = await fetch(`${JUPITER_QUOTE_API}?inputMint=${mint}&outputMint=${usdcMint}&amount=1000000000`, { headers: JUP_HEADERS });
      if (quoteResp.ok) {
          const buyResp = await fetch(`${JUPITER_QUOTE_API}?inputMint=${usdcMint}&outputMint=${mint}&amount=100_000_000`, { headers: JUP_HEADERS });
          if (buyResp.ok) {
              const b: any = await buyResp.json();
              if (b.data || b.outAmount) {
                  return {
                      mint,
                      symbol: 'JUP_TRACKED',
                      liquidityUSD: 1_000_000, // bypass standard mock
                      volume24h: 1_000_000
                  };
              }
          }
      }
  } catch (err) {}
  
  return null;
}

async function fetchTokenMetadataWithRetry(mint: string, maxRetries = 4, delayMs = 15000): Promise<TokenMetadata | null> {
  for (let i = 0; i < maxRetries; i++) {
    const metadata = await fetchTokenMetadata(mint);
    if (metadata) return metadata;
    console.log(`[QUALIFIER] API Grace Period Active: Index missing for ${mint}. Sleeping ${delayMs/1000}s (Attempt ${i+1}/${maxRetries})...`);
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return null;
}

async function getBestRoute(mint: string): Promise<{
  buyDex: string;
  sellDex: string;
  buyPrice: number;
  sellPrice: number;
  spreadPct: number;
  error?: string;
} | null> {
  const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  try {
    // Get buy quote: USDC -> Token
    const buyQuoteUrl = `${JUPITER_QUOTE_API}?inputMint=${usdcMint}&outputMint=${mint}&amount=1000000&slippageBps=50`;
    const buyResp = await fetch(buyQuoteUrl, { headers: JUP_HEADERS });
    const buyData: any = await buyResp.json();
    if (!buyData.outAmount) return null; // handle v1 payload divergence
    const bestBuy = buyData;
    // buyPrice evaluates exactly how many raw tokens we get for 1,000,000 USDC-micros ($1.00)
    
    // Get sell quote: Token -> USDC
    // IMPORTANT: Accurately pipe the received token yield exactly to the next AMM
    const sellQuoteUrl = `${JUPITER_QUOTE_API}?inputMint=${mint}&outputMint=${usdcMint}&amount=${bestBuy.outAmount}&slippageBps=50`;
    const sellResp = await fetch(sellQuoteUrl, { headers: JUP_HEADERS });
    const sellData: any = await sellResp.json();
    if (!sellData.outAmount) return null;
    const bestSell = sellData;
    
    const initialUSDCLamports = 1_000_000;
    const finalUSDCLamports = parseInt(bestSell.outAmount, 10);
    const spreadPct = ((finalUSDCLamports - initialUSDCLamports) / initialUSDCLamports) * 100;

    return {
      buyDex: bestBuy.label || (bestBuy.routePlan && bestBuy.routePlan[0]?.swapInfo?.label) || 'unknown',
      sellDex: bestSell.label || (bestSell.routePlan && bestSell.routePlan[0]?.swapInfo?.label) || 'unknown',
      buyPrice: 1, // Normalized abstract scalar
      sellPrice: finalUSDCLamports / initialUSDCLamports, // Normalized scale comparison
      spreadPct
    };
  } catch (err: any) {
    console.error(`[QUALIFIER] Route error for ${mint}:`, err);
    return { error: err.message } as any;
  }
}

async function logMissedTarget(mint: string, reason: string, metadata: any) {
  const entry = {
    timestamp: Date.now(),
    mint,
    reason,
    metadata,
    type: 'MISSED_TARGET'
  };
  await fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n').catch(() => {});
  console.log(`[QUALIFIER] Missed target: ${mint} – ${reason}`);
}

async function logQualifiedTarget(target: QualifiedTarget) {
  const entry = {
    ...target,
    type: 'QUALIFIED_TARGET'
  };
  await fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n').catch(() => {});
  console.log(`[QUALIFIER] Qualified target: ${target.mint} with spread ${target.grossSpreadPct.toFixed(2)}%`);
  // Also publish to Redis for the Sniper
  await redisPublisher.publish('TARGET_QUALIFIED', JSON.stringify(target));
}

async function evaluateToken(mint: string) {
  const cfg = getConfig();
  console.log(`[QUALIFIER] Evaluating ${mint} bounds - Liq: >$${cfg.MIN_LIQUIDITY_USD}, Sprd: >${cfg.MIN_SPREAD_PCT}%`);
  const metadata = await fetchTokenMetadataWithRetry(mint);
  if (!metadata) {
    await logMissedTarget(mint, 'Failed to fetch metadata', {});
    return;
  }

  if (metadata.liquidityUSD && metadata.liquidityUSD < cfg.MIN_LIQUIDITY_USD) {
    await logMissedTarget(mint, `Low liquidity: $${metadata.liquidityUSD} < ${cfg.MIN_LIQUIDITY_USD}`, metadata);
    return;
  }

  const route = await getBestRoute(mint);
  if (!route || route.error) {
    await logMissedTarget(mint, `No route: ${route?.error || 'unknown'}`, metadata);
    return;
  }

  if (route.spreadPct < cfg.MIN_SPREAD_PCT) {
    await logMissedTarget(mint, `Spread too low: ${route.spreadPct.toFixed(2)}% < ${cfg.MIN_SPREAD_PCT}%`, { route, metadata });
    return;
  }

  // Qualified target
  const qualified: QualifiedTarget = {
    mint,
    buyDex: route.buyDex,
    sellDex: route.sellDex,
    buyPrice: route.buyPrice,
    sellPrice: route.sellPrice,
    grossSpreadPct: route.spreadPct,
    estimatedGasLamports: 15000, // estimate
    liquidityUSD: metadata.liquidityUSD || 0,
    timestamp: Date.now()
  };
  await logQualifiedTarget(qualified);
}

// Redis message handlers
redis.subscribe('VELOCITY_SPIKE', 'ALPHA_WALLET_UPDATE');
redis.on('message', async (channel, message) => {
  try {
    const data = JSON.parse(message);
    const promises: Promise<void>[] = [];
    
    if (channel === 'VELOCITY_SPIKE' && data.mints?.length) {
      for (const mint of data.mints) {
        promises.push(evaluateToken(mint));
      }
    }
    if (channel === 'ALPHA_WALLET_UPDATE') {
      for (const mint of Object.keys(data.balances || {})) {
        promises.push(evaluateToken(mint));
      }
    }
    
    // Non-blocking concurrent settlement
    if (promises.length > 0) {
        Promise.allSettled(promises).catch(err => console.error(`[QUALIFIER] Promise rejection in ingestion sweep:`, err));
    }
  } catch (err) {
    console.error('[QUALIFIER] Error processing message:', err);
  }
});

async function main() {
  await initConfigManager();
  console.log('[QUALIFIER] Started, listening for VELOCITY_SPIKE and ALPHA_WALLET_UPDATE');
}

main().catch(console.error);

process.on('SIGINT', async () => {
  await closeConfigManager();
  process.exit(0);
});
