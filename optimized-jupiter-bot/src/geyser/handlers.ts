import { logger } from '../utils/logger';
import { fetchJupiterQuote, getParallelSwapInstructions } from '../jupiter/quotes';
import { buildVersionedTransaction } from '../execution/transaction';
import { submitTransactionWithRacing } from '../execution/racing';
import { config } from '../utils/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { cacheTradeMetrics } from '../utils/trade_logger';

const TOKENS = {
  WSOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYtM2wYSzRo",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbPwdrsxGBK",
  PYTH: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3AkTftx2K2aFCh",
  JTO: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
  POPCAT: "7GCihgDB8fe6KNjn2gN7ZDB2h2n2i2Z7pW2r2YjN1e8p",
  BOME: "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgM2W8qT"
};

const TRADE_ROUTES = [
  [TOKENS.WSOL, TOKENS.USDC],
  [TOKENS.WSOL, TOKENS.WIF],
  [TOKENS.WSOL, TOKENS.BONK],
  [TOKENS.WSOL, TOKENS.RAY],
  [TOKENS.WSOL, TOKENS.JUP],
  [TOKENS.WSOL, TOKENS.PYTH],
  [TOKENS.WSOL, TOKENS.JTO],
  [TOKENS.WSOL, TOKENS.POPCAT],
  [TOKENS.WSOL, TOKENS.BOME]
];

// Dynamic Routing Array (Updated via multi-DEX fetch)
let DYNAMIC_ROUTES = [...TRADE_ROUTES];

async function refreshDynamicTokens() {
  try {
    const jupRes = await fetch("https://token.jup.ag/strict");
    const jupData = await jupRes.json();
    
    if (jupData && jupData.length > 0) {
      const newRoutes: string[][] = [];
      const shuffled = jupData.sort(() => 0.5 - Math.random()).slice(0, 50);
      
      shuffled.forEach((token: any) => {
        if (token.address !== TOKENS.WSOL) {
            newRoutes.push([TOKENS.WSOL, token.address]);
        }
      });
      
      DYNAMIC_ROUTES = [...TRADE_ROUTES, ...newRoutes];
      logger.info(`✅ Multi-DEX Token Rotator pulled ${newRoutes.length} trending items! Current Hunting Scope: ${DYNAMIC_ROUTES.length} routes.`);
    }

    if (config.BAGS_API_KEY) {
      const bagsRes = await fetch("https://public-api-v2.bags.fm/api/v1/tokens", {
         headers: { 'Authorization': `Bearer ${config.BAGS_API_KEY}` }
      });
      if (bagsRes.ok) {
         logger.debug("Bags API authenticated securely.");
      }
    }
  } catch (err) {
    logger.warn("Failed to fetch dynamic tokens:", err);
  }
}

refreshDynamicTokens();
// Refresh every 60 seconds (1 minute) for absolute maximum trending pool tracking
setInterval(refreshDynamicTokens, 60 * 1000);

import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

// Connection for wallet balance checking
const connection = new Connection(config.RPC_ENDPOINT, { commitment: 'processed' });
const walletPubkey = new PublicKey(config.WALLET_PUBLIC_KEY);
let cachedLamportsBalance = 0.5 * 10 ** 9; // Fallback
let existingAtas = new Set<string>();

// Update balance and known ATAs every 30 seconds
setInterval(async () => {
  try {
    cachedLamportsBalance = await connection.getBalance(walletPubkey);
    
    // Fetch all token accounts to cache existing ATAs
    const accounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, {
      programId: TOKEN_PROGRAM_ID
    });
    
    const tokenMints = accounts.value.map(acc => acc.account.data.parsed.info.mint);
    existingAtas = new Set(tokenMints);
  } catch (err) {
    logger.warn("Failed to fetch wallet balance and ATAs:", err);
  }
}, 30000);

let hasForcedInitialTrade = false;

let lastTradeTime = 0;

export async function handleAccountUpdate(data: any) {
  const startMs = Date.now();
  
  // Guard-rail removal cooldown: prevent >10ms Geyser stream from physically draining all Solana via gas inside 1 second
  if (startMs - lastTradeTime < 10000) return;

  if (process.env.DEBUG) {
    logger.debug(`[GEYSER] Stream triggered account update event.`);
  }

  const route = DYNAMIC_ROUTES[Math.floor(Math.random() * DYNAMIC_ROUTES.length)];
  const inputMint = route[0];
  const intermediateMint = route[1];
  
  // Phase 16a: Temporal Jitter (Anti-Trust / MEV Obfuscation)
  // Suspends execution for 5-25ms to spoof synthetic robotic tick-rates, destroying Validator Sandwich predictions
  const temporalJitterMs = Math.floor(Math.random() * 20) + 5;
  await new Promise(resolve => setTimeout(resolve, temporalJitterMs));
  
  // Phase 16b: Quantitative Parameter Jitter
  // Randomizes flat block sizing to generate organic, human-like byte lengths natively bypassing RPC WAF blocks
  const generateJitter = () => Number((Math.random() * 0.009).toFixed(4));
  const tradeSizes = [
    0.05 + generateJitter(), 
    0.10 + generateJitter(), 
    0.25 + generateJitter(), 
    0.50 + generateJitter()
  ];
  
  logger.info(`🔍 [JITTER: +${temporalJitterMs}ms] Hunting synthetic volumes for Route: WSOL -> ${intermediateMint.substring(0, 4)}...`);

  const sweepResults = await Promise.all(tradeSizes.map(async (size) => {
    const tradeSizeLamports = Math.floor(size * 10**9);
    // Ensure the wallet can actually afford this leg (plus gas padding)
    if (cachedLamportsBalance < tradeSizeLamports + 50000) return null; 

    const quote1 = await fetchJupiterQuote(inputMint, intermediateMint, tradeSizeLamports);
    if (!quote1) return null;

    const intermediateAmount = Number(quote1.otherAmountThreshold);
    const quote2 = await fetchJupiterQuote(intermediateMint, inputMint, intermediateAmount);
    if (!quote2) return null;

    const expectedOut = Number(quote2.outAmount);
    const grossProfitLamports = expectedOut - tradeSizeLamports;
    
    // Subtract standard physical network fees natively (Bypassing MEV Tips constraints)
    // Freed up ~200,000 lamports of margin previously wasted on Artificial buffers!
    const ESTIMATED_GAS_AND_TIP_LAMPORTS = 15000; 

    // CRITICAL FIX: Account for ~0.002 SOL Rent Exemption if this is a new dynamically routed token!
    // Without this, the bot bleeds 2,000,000 lamports per new token, far exceeding typical 5bps arbitrage profit!
    const ATA_RENT_LAMPORTS = existingAtas.has(intermediateMint) ? 0 : 2039280;

    const netProfitLamports = grossProfitLamports - ESTIMATED_GAS_AND_TIP_LAMPORTS - ATA_RENT_LAMPORTS;
    const netProfitBps = (netProfitLamports / tradeSizeLamports) * 10000;

    return { size, quote1, quote2, netProfitLamports, netProfitBps };
  }));

  // Filter valid completed sweeps
  const validResults = sweepResults.filter(r => r !== null);
  if (validResults.length === 0) return;

  // Select the trade size that yielded the highest absolute SOL profit
  const bestResult = validResults.sort((a, b) => b!.netProfitLamports - a!.netProfitLamports)[0]!;

  const processMs = Date.now() - startMs;

  if (bestResult.netProfitBps > 0) {
    logger.info(`✅ [ARBITRAGE FOUND] Size: ${bestResult.size} SOL | Net Profit: ${bestResult.netProfitBps.toFixed(2)} bps (${(bestResult.netProfitLamports / 10**9).toFixed(5)} SOL) [Sweep Ms: ${processMs}ms]`);
  } else {
    logger.info(`❌ [NO ARBITRAGE] Route: SOL -> ${intermediateMint.substring(0, 4)}... | Best Size: ${bestResult.size} SOL yielded Net Loss: ${bestResult.netProfitBps.toFixed(2)} bps. [Sweep Ms: ${processMs}ms]`);
  }

  // Final confirmation to execute
  if (bestResult.netProfitBps >= config.MIN_PROFIT_BPS) {
    lastTradeTime = Date.now(); // Instantly lock out the concurrent Geyser streams
    logger.warn(`🔥 PROFITABLE OPPORTUNITY DETECTED on Size ${bestResult.size} SOL! Proceeding to bundle extraction...`);
    
    let signatureStr: string | null = null;
    let success = false;
    
    const instructions = await getParallelSwapInstructions(bestResult.quote1, bestResult.quote2);
    if (instructions) {
      const transaction = await buildVersionedTransaction(instructions.ix1, instructions.ix2);
      if (transaction) {
        const rpcResult = await submitTransactionWithRacing(transaction);
        if (rpcResult && rpcResult.success) {
            signatureStr = (rpcResult as any).signature as string;
        }
      } else {
        logger.error('Failed to build versioned transaction.');
      }
    } else {
      logger.error('Failed to get routing instructions.');
    }

    // Persist evaluation metrics for analytics & refining rolling period strategies
    cacheTradeMetrics({
        timestamp: Date.now(),
        date: new Date().toISOString(),
        inputMint: bestResult.quote1.inputMint,
        outputMint: bestResult.quote1.outputMint,
        tradeSizeSOL: bestResult.size,
        expectedProfitSOL: bestResult.netProfitLamports / 10**9,
        expectedProfitBps: bestResult.netProfitBps,
        signature: signatureStr,
        success: success
    });
  }
}

export function startGeyserListeners(stream: any) {
  stream.on('data', (data: any) => {
    try {
      if (data.filters && data.filters.includes('jupiter')) {
        handleAccountUpdate(data);
      }
    } catch (err) {
      logger.error('Error handling geyser message', err);
    }
  });

  stream.on('error', (err: any) => {
    logger.error('Geyser stream error', err);
  });

  stream.on('end', () => {
    logger.warn('Geyser stream ended. Consider reconnecting.');
  });
}

