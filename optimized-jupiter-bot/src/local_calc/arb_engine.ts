import { globalPriceBook, PoolState } from './price_book';
import { logger, logTrade } from '../utils/logger';
import { config } from '../utils/config';
import { globalVerifier } from '../execution/verificationEngine';
import { submitTransactionWithRacing } from '../execution/racing';
import { buildVersionedTransaction } from '../execution/transaction';
import { loadStrategyParams, DEFAULT_PARAMS, StrategyParams } from '../strategy_tuner';

// ── AdaptiveMemory — EMA-20 route performance tracker ────────────────────────
// Uses exponential moving average (α = 2/(20+1) ≈ 0.0952) so recent scans
// outweigh old data and stale routes naturally decay without explicit resets.
// Entries older than 24h are evicted every 30 minutes to prevent map bloat.
const EMA_ALPHA  = 2 / (20 + 1);          // 20-period EMA
const ENTRY_TTL  = 24 * 60 * 60 * 1000;   // 24h — stale route expiry

class AdaptiveMemory {
    private routePerformance = new Map<string, {
        emaProfit:  number;   // EMA of profit BPS
        count:      number;   // total observations (for warm-up weighting)
        lastSeenTs: number;   // ms timestamp, used for TTL eviction
    }>();

    constructor() {
        // Sweep expired entries every 30 minutes
        setInterval(() => this.evict(), 30 * 60 * 1000);
    }

    private evict() {
        const cutoff = Date.now() - ENTRY_TTL;
        for (const [key, entry] of this.routePerformance) {
            if (entry.lastSeenTs < cutoff) this.routePerformance.delete(key);
        }
    }

    recordOutcome(routeKey: string, profitBps: number) {
        const existing = this.routePerformance.get(routeKey);
        if (!existing) {
            // First observation — seed EMA with the raw value
            this.routePerformance.set(routeKey, { emaProfit: profitBps, count: 1, lastSeenTs: Date.now() });
        } else {
            // EMA update: EMA_t = alpha * new + (1 - alpha) * EMA_{t-1}
            const newEma = EMA_ALPHA * profitBps + (1 - EMA_ALPHA) * existing.emaProfit;
            this.routePerformance.set(routeKey, {
                emaProfit:  newEma,
                count:      existing.count + 1,
                lastSeenTs: Date.now(),
            });
        }
    }

    getExpectedProfit(routeKey: string): number {
        return this.routePerformance.get(routeKey)?.emaProfit || 0;
    }

    /** Returns true if the route has warmed up (≥3 observations) */
    isWarmedUp(routeKey: string): boolean {
        return (this.routePerformance.get(routeKey)?.count || 0) >= 3;
    }

    /** Snapshot for logging — sorted by descending EMA profit */
    snapshot(): Array<{ routeKey: string; emaProfit: number; count: number }> {
        return [...this.routePerformance.entries()]
            .map(([routeKey, v]) => ({ routeKey, emaProfit: v.emaProfit, count: v.count }))
            .sort((a, b) => b.emaProfit - a.emaProfit);
    }
}

export const globalAdaptiveMemory = new AdaptiveMemory();


export interface Opportunity {
    type: string;
    description: string;
    expectedInSol: number;
    expectedOutSol: number;
    grossProfitSol: number;
    netProfit: number;
    tipAmount: number;
    pools: PoolState[];
}

export class ArbEngine {
    
    // Calculates Net Profit utilizing dynamic JITO scaling — reads live calibrated params
    private calculateDynamicNetProfit(grossProfitSol: number, amountInSol: number, params: StrategyParams): { netProfit: number, jitoTip: number } {
        const expectedProfitLamports = grossProfitSol * 1e9;
        const computeUnits = 1400000;
        
        // Priority Fee Logic (Formula: microLamports * CU / 1_000_000)
        const priorityFeeMicroLamports = params.PRIORITY_MICRO_LAMPORTS || config.PRIORITY_MICRO_LAMPORTS || 250000; 
        const priorityFeeLamports = (priorityFeeMicroLamports * computeUnits) / 1000000;
        const priorityFeeSol = priorityFeeLamports / 1e9;
        
        // Dynamic Tip — from strategy_params.json (calibrated every 72h via Kelly Criterion)
        let jitoTipLamports = expectedProfitLamports * params.TIP_PERCENTAGE;
        const maxTipLamports = 10000000; // 0.01 SOL max
        jitoTipLamports = Math.min(jitoTipLamports, maxTipLamports);
        jitoTipLamports = Math.max(jitoTipLamports, 2000000); // 0.002 SOL minimum
        
        const jitoTipSol = jitoTipLamports / 1e9;
        
        // Slippage — from strategy_params.json (adjusted by volatility every 72h)
        const slippageTolerance = params.MAX_SLIPPAGE_BPS / 10000;
        const slippageCost = amountInSol * slippageTolerance;
        
        const netProfit = grossProfitSol - jitoTipSol - priorityFeeSol - slippageCost;
        return { netProfit, jitoTip: jitoTipSol };
    }

    private detectTriangularArb(pools: PoolState[], params: StrategyParams): Opportunity[] {
        const opportunities: Opportunity[] = [];
        const startingSol = params.MAX_TRADE_SIZE_SOL;
        
        // Native 3-hop Scanner (SOL -> Token A -> Token B -> SOL)
        for (let i = 0; i < pools.length; i++) {
            for (let j = 0; j < pools.length; j++) {
                if (i === j) continue;
                for (let k = 0; k < pools.length; k++) {
                    if (k === i || k === j) continue;
                    
                    const poolA = pools[i];
                    const poolB = pools[j];
                    const poolC = pools[k];
                    
                    if (poolA.tokenA === "SOL" && poolC.tokenB === "USDC") {
                        let inter1 = globalPriceBook.calculateOutput(poolA, startingSol, true);
                        let inter2 = globalPriceBook.calculateOutput(poolB, inter1, true);
                        let finalOut = globalPriceBook.calculateOutput(poolC, inter2, false);
                        
                        let gross = finalOut - startingSol;
                        if (gross > -0.01) {
                            const { netProfit, jitoTip } = this.calculateDynamicNetProfit(gross, startingSol, params);
                            if (netProfit > params.MIN_PROFIT_SOL) {
                                opportunities.push({
                                    type: 'Triangular-3-Hop',
                                    description: `SOL -> ${poolA.dex} -> ${poolB.dex} -> ${poolC.dex} -> SOL`,
                                    expectedInSol: startingSol,
                                    expectedOutSol: finalOut,
                                    grossProfitSol: gross,
                                    netProfit,
                                    tipAmount: jitoTip,
                                    pools: [poolA, poolB, poolC]
                                });
                            }
                        }
                    }
                }
            }
        }
        return opportunities;
    }

    private detectSplitArb(pools: PoolState[], params: StrategyParams): Opportunity[] {
        const opportunities: Opportunity[] = [];
        const startingSol = params.MAX_TRADE_SIZE_SOL;
        const split = params.SPLIT_RATIO; // calibrated every 72h
        
        // Multi-DEX splitting: Buy 1 DEX, distribute sell across 2 to reduce price impact
        for (let i = 0; i < pools.length; i++) {
            for (let j = i + 1; j < pools.length; j++) {
                for (let k = j + 1; k < pools.length; k++) {
                    const poolA = pools[i];
                    const poolB = pools[j];
                    const poolC = pools[k];
                    
                    if (poolA.tokenA === poolB.tokenA && poolB.tokenA === poolC.tokenA) {
                         let intermediateTokens = globalPriceBook.calculateOutput(poolA, startingSol, true);
                         
                         let splitOut1 = globalPriceBook.calculateOutput(poolB, intermediateTokens * split, false);
                         let splitOut2 = globalPriceBook.calculateOutput(poolC, intermediateTokens * (1 - split), false);
                         
                         let totalOut = splitOut1 + splitOut2;
                         let gross = totalOut - startingSol;
                         
                         if (gross > params.MIN_PROFIT_SOL) {
                              const { netProfit, jitoTip } = this.calculateDynamicNetProfit(gross, startingSol, params);
                              if (netProfit > params.MIN_PROFIT_SOL) {
                                  opportunities.push({
                                      type: 'Split-Routing',
                                      description: `Buy ${poolA.dex} -> Split [${Math.round(split*100)}%:${poolB.dex} / ${Math.round((1-split)*100)}%:${poolC.dex}]`,
                                      expectedInSol: startingSol,
                                      expectedOutSol: totalOut,
                                      grossProfitSol: gross,
                                      netProfit,
                                      tipAmount: jitoTip,
                                      pools: [poolA, poolB, poolC]
                                  });
                              }
                         }
                    }
                }
            }
        }
        return opportunities;
    }

    private detectSimpleArb(pools: PoolState[], params: StrategyParams): Opportunity[] {
        const opportunities: Opportunity[] = [];
        const startingSol = params.MAX_TRADE_SIZE_SOL;

        for (let i = 0; i < pools.length; i++) {
            for (let j = i + 1; j < pools.length; j++) {
                const poolA = pools[i];
                const poolB = pools[j];

                if (poolA.tokenA === poolB.tokenA && poolA.tokenB === poolB.tokenB) {
                    
                    // Route 1: Pool A -> Pool B
                    let intermediate = globalPriceBook.calculateOutput(poolA, startingSol, true);
                    let finalOut1 = globalPriceBook.calculateOutput(poolB, intermediate, false);
                    let gross1 = finalOut1 - startingSol;
                    
                    if (gross1 > params.MIN_PROFIT_SOL) {
                        const { netProfit, jitoTip } = this.calculateDynamicNetProfit(gross1, startingSol, params);
                        if (netProfit > params.MIN_PROFIT_SOL) {
                            opportunities.push({
                                type: 'Simple-2-Hop',
                                description: `SOL -> ${poolA.tokenB} (${poolA.dex}) -> SOL (${poolB.dex})`,
                                expectedInSol: startingSol,
                                expectedOutSol: finalOut1,
                                grossProfitSol: gross1,
                                netProfit,
                                tipAmount: jitoTip,
                                pools: [poolA, poolB]
                            });
                        }
                    }

                    // Route 2: Pool B -> Pool A
                    let intermediate2 = globalPriceBook.calculateOutput(poolB, startingSol, true);
                    let finalOut2 = globalPriceBook.calculateOutput(poolA, intermediate2, false);
                    let gross2 = finalOut2 - startingSol;
                    
                    if (gross2 > params.MIN_PROFIT_SOL) {
                        const { netProfit, jitoTip } = this.calculateDynamicNetProfit(gross2, startingSol, params);
                        if (netProfit > params.MIN_PROFIT_SOL) {
                            opportunities.push({
                                type: 'Simple-2-Hop',
                                description: `SOL -> ${poolB.tokenB} (${poolB.dex}) -> SOL (${poolA.dex})`,
                                expectedInSol: startingSol,
                                expectedOutSol: finalOut2,
                                grossProfitSol: gross2,
                                netProfit,
                                tipAmount: jitoTip,
                                pools: [poolB, poolA]
                            });
                        }
                    }
                }
            }
        }
        return opportunities;
    }

    private lastExecutionTs = 0;

    public async runArbitrageScan() {
        const startMs = performance.now();
        const pools = globalPriceBook.getAllPools();
        
        if (pools.length < 2) return;

        // Load latest calibrated params (reads strategy_params.json if updated by tuner)
        const params = loadStrategyParams();
        
        // Parallel execution of all three strategy detectors
        const allOpps = await Promise.all([
            this.detectSimpleArb(pools, params),
            this.detectTriangularArb(pools, params),
            this.detectSplitArb(pools, params)
        ]);

        const validOpps = allOpps.flat().sort((a, b) => b.netProfit - a.netProfit);
        const calcTime = performance.now() - startMs;

        if (Math.random() < 0.01) {
            logger.info(`[SCAN] Checking ${pools.length} pools internally mapped...`);
        }

        if (validOpps.length > 0) {
            const best = validOpps[0];
            const spread = (best.grossProfitSol / best.expectedInSol) * 100;
            const spreadBps = spread * 100;

            const routeKey = best.pools.map(p => p.dex).join('-');

            // Adaptive Memory dynamically tracking EMA of detected pathways
            globalAdaptiveMemory.recordOutcome(routeKey, spreadBps);
            
            logger.info(`[FOUND] SOL/USDC: ${routeKey} (${spread.toFixed(1)}% spread | EMA: ${(globalAdaptiveMemory.getExpectedProfit(routeKey)/100).toFixed(2)}%)`);
            logger.info(`[PROFIT] Gross: ${best.grossProfitSol.toFixed(4)} SOL | Tip: ${best.tipAmount.toFixed(4)} SOL | Net: ${best.netProfit.toFixed(4)} SOL ✅`);
            logger.info(`[PERF] Detection latency: ${calcTime.toFixed(2)}ms\n`);
            
            // Persist securely to 50GB local SQLite natively evaluating expected metrics reliably
            logTrade({
                timestamp: Date.now() * 1000, 
                slot: 0, 
                opportunity: {
                    type: best.type,
                    route: best.pools.map(p => p.tokenB),
                    expectedIn: best.expectedInSol * 1e9,
                    expectedOut: best.expectedOutSol * 1e9,
                    expectedProfitLamports: best.grossProfitSol * 1e9,
                    expectedProfitBps: spreadBps
                },
                decision: 'executed',
                jitoTipLamports: best.tipAmount * 1e9,
                priorityFeeLamports: 100000,
                latencyMs: calcTime,
                priceBookSnapshot: null
            });

            // Execute best opportunity
            await this.executeArbitrage(best);
        }
    }
    
    private async executeArbitrage(opp: Opportunity) {
        if (Date.now() - this.lastExecutionTs < 5000) return; // Sandbox 5s Throttle Rate Limit
        this.lastExecutionTs = Date.now();
        try {
            logger.info(`[COMPILATION] Constructing payload for ${opp.type} with tip: ${opp.tipAmount} SOL`);
            
            const API_KEY = config.JUPITER_API_KEY || 'YOUR_JUPITER_API_KEY';

            const fetchWithTimeout = async (url: string, options: any, retries = 3) => {
                for (let i = 0; i < retries; i++) {
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 3000);
                    try {
                        const res = await fetch(url, { ...options, signal: controller.signal });
                        clearTimeout(timeout);
                        if (res.status === 429) {
                            if (i === retries - 1) throw new Error("Rate limited permanently");
                            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
                            continue;
                        }
                        return res;
                    } catch (e: any) {
                        clearTimeout(timeout);
                        if (i === retries - 1) throw e;
                    }
                }
            };

            // ── Jupiter authenticated endpoints (600 req/min) ────────────────────────
            const JAUTH_BASE = 'https://quote-api.jup.ag/v6';
            const AUTH_HDR   = { 'x-api-key': API_KEY };

            const q1Req = await fetchWithTimeout(
              `${JAUTH_BASE}/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=${Math.floor(opp.expectedInSol * 1e9)}&slippageBps=500`,
              { headers: AUTH_HDR }
            );
            const quote1 = await q1Req?.json();

            const q2Req = await fetchWithTimeout(
              `${JAUTH_BASE}/quote?inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&outputMint=So11111111111111111111111111111111111111112&amount=${quote1.outAmount}&slippageBps=500`,
              { headers: AUTH_HDR }
            );
            const quote2 = await q2Req?.json();

            const ix1Req = await fetchWithTimeout(`${JAUTH_BASE}/swap-instructions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...AUTH_HDR },
                body: JSON.stringify({ quoteResponse: quote1, userPublicKey: config.WALLET_PUBLIC_KEY, wrapAndUnwrapSol: true, prioritizationFeeLamports: "auto" })
            });
            const ix1 = await ix1Req?.json();

            const ix2Req = await fetchWithTimeout(`${JAUTH_BASE}/swap-instructions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...AUTH_HDR },
                body: JSON.stringify({ quoteResponse: quote2, userPublicKey: config.WALLET_PUBLIC_KEY, wrapAndUnwrapSol: true, prioritizationFeeLamports: "auto" })
            });
            const ix2 = await ix2Req?.json();

            const tipLamports = Math.floor(opp.tipAmount * 1e9);
            const transaction = await buildVersionedTransaction(ix1, ix2, tipLamports);
            if (transaction) {
               await submitTransactionWithRacing(transaction);
            }
        } catch (e: any) {
            logger.error(`Execution failed actively: ${e.message}`);
        }
    }
}

export const globalArbEngine = new ArbEngine();
