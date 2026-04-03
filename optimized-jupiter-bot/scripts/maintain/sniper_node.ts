import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import Redis from 'ioredis';
import bs58 from 'bs58';
import fs from 'fs/promises';
import { config } from 'dotenv';
import path from 'path';
import { initConfigManager, getConfig, closeConfigManager } from './config_manager';

config();

const RPC_URL = (process.env.SOLANA_RPC_URL || process.env.RPC_ENDPOINT || '').trim();
const PRIVATE_KEY = process.env.PRIVATE_KEY_1 || process.env.PRIVATE_KEY!;
const DRY_RUN = process.env.DRY_RUN !== 'false'; // Default to dry-run mode for safety
const REDIS_URL = (process.env.REDIS_URL || 'redis://127.0.0.1:6379').trim();
const JUPITER_API = process.env.JUPITER_ENDPOINT || 'https://api.jup.ag/swap/v1';
const JUP_HEADERS: Record<string, string> = process.env.JUPITER_API_KEY ? { 'x-api-key': process.env.JUPITER_API_KEY } : {};

const redis = new Redis(REDIS_URL);
if (!PRIVATE_KEY) throw new Error("No Wallet Key configured!");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const connection = new Connection(RPC_URL, 'confirmed');

// In-memory dedup
const recentTrades = new Map<string, number>();

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

interface TradeJournalEntry {
  tradeId: string;
  timestamp: number;
  mint: string;
  side: 'BUY' | 'SELL' | 'ROUND_TRIP';
  buyTx?: string;
  sellTx?: string;
  amountIn: number;
  amountOut: number;
  price: number;
  dex: string;
  success: boolean;
  error?: string;
  parentBuyId?: string;
  realizedPnL?: number;
}

const LOG_FILE = path.join(process.cwd(), 'trade_journal.jsonl');

async function logTrade(entry: TradeJournalEntry) {
  const line = JSON.stringify(entry) + '\n';
  await fs.appendFile(LOG_FILE, line).catch(console.error);
  console.log('[SNIPER] Journal:', entry);
}

async function executeSwap(
  inputMint: string,
  outputMint: string,
  amount: number      // in natural units (e.g., 0.01 SOL)
): Promise<{ txid: string; outAmount: number } | null> {
  const cfg = getConfig();
  const slippageBps = cfg.MAX_SLIPPAGE_BPS;
  const priorityFee = cfg.PRIORITY_FEE_MICROLAMPORTS;
  try {
    // Get quote
    const quoteUrl = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${Math.floor(amount * 10**9)}&slippageBps=${slippageBps}`;
    const quoteResp = await fetch(quoteUrl, { headers: JUP_HEADERS });
    const quote: any = await quoteResp.json();
    if (!quote || quote.error) throw new Error(`Quote failed: ${quote.error}`);

    // Get swap transaction
    const swapResp = await fetch(`${JUPITER_API}/swap`, {
      method: 'POST',
      headers: { ...JUP_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: priorityFee,
      }),
    });
    const swapData: any = await swapResp.json();
    const tx = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, 'base64'));

    // Send or simulate transaction
    let signature = 'simulated_' + Math.floor(Math.random()*10000);
    if (DRY_RUN) {
        const sim = await connection.simulateTransaction(tx, { replaceRecentBlockhash: true, commitment: 'processed' });
        if (sim.value.err) throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
        console.log(`[DRY RUN] Tx Simulated successfully. Compute spent: ${sim.value.unitsConsumed} units.`);
    } else {
        signature = await connection.sendTransaction(tx, { maxRetries: 3 });
        const confirmation = await connection.confirmTransaction(signature, 'confirmed');
        if (confirmation.value.err) throw new Error(`Transaction failed: ${confirmation.value.err}`);
    }

    const outAmount = quote.outAmount / 10**9; // convert to natural units
    return { txid: signature, outAmount };
  } catch (err) {
    console.error('[SNIPER] Swap error:', err);
    return null;
  }
}

async function executeRoundTrip(target: QualifiedTarget) {
  const cfg = getConfig();
  const tradeId = `${target.mint}-${Date.now()}`;
  const startTime = Date.now();

  const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const solMint = 'So11111111111111111111111111111111111111112';

  // Decide base asset: use USDC if liquidity is high, otherwise SOL.
  const useUsdc = target.liquidityUSD > cfg.MIN_LIQUIDITY_USD;
  const baseMint = useUsdc ? usdcMint : solMint;

  console.log(`[SNIPER] Attempting round-trip for ${target.mint} using ${useUsdc ? 'USDC' : 'SOL'} as base`);

  // Buy leg: base -> target
  const buyAmount = useUsdc ? cfg.BUY_AMOUNT_USDC : cfg.BUY_AMOUNT_SOL;
  const buyResult = await executeSwap(baseMint, target.mint, buyAmount);
  if (!buyResult) {
    await logTrade({
      tradeId, timestamp: startTime, mint: target.mint, side: 'BUY',
      amountIn: buyAmount, amountOut: 0, price: 0, dex: target.buyDex,
      success: false, error: 'Buy leg failed', parentBuyId: undefined
    });
    return;
  }

  await logTrade({
    tradeId, timestamp: startTime, mint: target.mint, side: 'BUY',
    amountIn: buyAmount, amountOut: buyResult.outAmount, price: target.buyPrice,
    dex: target.buyDex, success: true, buyTx: buyResult.txid
  });

  // 2. Sell leg: target -> base
  const sellResult = await executeSwap(target.mint, baseMint, buyResult.outAmount);
  if (!sellResult) {
    await logTrade({
      tradeId, timestamp: Date.now(), mint: target.mint, side: 'SELL',
      amountIn: buyResult.outAmount, amountOut: 0, price: 0, dex: target.sellDex,
      success: false, error: 'Sell leg failed', parentBuyId: tradeId
    });
    return;
  }

  const realizedPnL = sellResult.outAmount - buyAmount;
  await logTrade({
    tradeId, timestamp: Date.now(), mint: target.mint, side: 'SELL',
    amountIn: buyResult.outAmount, amountOut: sellResult.outAmount, price: target.sellPrice,
    dex: target.sellDex, success: true, sellTx: sellResult.txid, parentBuyId: tradeId,
    realizedPnL
  });

  console.log(`[SNIPER] Round-trip complete for ${target.mint}: PnL = ${realizedPnL.toFixed(6)} ${useUsdc ? 'USDC' : 'SOL'}`);
}

// Redis subscription
redis.subscribe('TARGET_QUALIFIED');
redis.on('message', async (channel, message) => {
  if (channel !== 'TARGET_QUALIFIED') return;
  try {
    const target: QualifiedTarget = JSON.parse(message);
    const now = Date.now();
    const lastTrade = recentTrades.get(target.mint);
    const cfg = getConfig();
    if (lastTrade && (now - lastTrade) < cfg.TRADE_COOLDOWN_MS) {
      console.log(`[SNIPER] Skipping ${target.mint} – trade cooldown active`);
      return;
    }
    recentTrades.set(target.mint, now);
    // Clean old entries every 5 minutes
    if (recentTrades.size > 1000) {
      for (const [mint, ts] of recentTrades.entries()) {
        if (now - ts > cfg.TRADE_COOLDOWN_MS) recentTrades.delete(mint);
      }
    }

    // Execute concurrently decoupled from redis ingestion
    Promise.resolve(executeRoundTrip(target)).catch(err => {
      console.error(`[SNIPER] execution exception for ${target.mint}:`, err);
    });
  } catch (err) {
    console.error('[SNIPER] Error processing target:', err);
  }
});

async function main() {
  await initConfigManager();
  console.log(`[SNIPER] Started, wallet: ${wallet.publicKey.toBase58()}`);
  if (DRY_RUN) console.log(`[SNIPER] ⚠️ DRY RUN MODE ACTIVE ⚠️ - Transactions will be simulated, not sent.`);
}

main().catch(console.error);

process.on('SIGINT', async () => {
  await closeConfigManager();
  process.exit(0);
});
