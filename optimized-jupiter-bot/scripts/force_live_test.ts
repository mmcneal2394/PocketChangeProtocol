import { Opportunity } from '../src/local_calc/arb_engine';
import { logger } from '../src/utils/logger';
import { buildVersionedTransaction } from '../src/execution/transaction';
import { submitTransactionWithRacing } from '../src/execution/racing';
import * as cache from '../src/jupiter/cache';

// @ts-ignore
cache.getCachedBlockhash = () => "HsM57uX7d3FmP1mockedBlockhashForTesting8xW";

async function forceExecuteArbitrage(opp: Opportunity) {
    try {
        logger.info(`🚨 [LIVE FORCE TEST] Triggering physical local verification node...`);
        logger.info(`[COMPILATION] Constructing payload for ${opp.type} with tip: ${opp.tipAmount} SOL`);
        
        const mockIx = {
            programId: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
            accounts: [{ pubkey: "11111111111111111111111111111111", isSigner: false, isWritable: false }],
            data: "Aw=="
        };
        
        const ix1 = { setupInstructions: [], swapInstruction: mockIx, addressLookupTableAddresses: [] };
        const ix2 = { setupInstructions: [], swapInstruction: mockIx, addressLookupTableAddresses: [] };
        
        const tipLamports = Math.floor(opp.tipAmount * 1e9);
        
        const transaction = await buildVersionedTransaction(ix1, ix2, tipLamports);
        if (transaction) {
           await submitTransactionWithRacing(transaction);
        }
    } catch (e: any) {
        logger.error(`Execution failed actively: ${e.message}`);
    }
}

const forceOpp: Opportunity = {
    type: 'Force-Test-Hop',
    description: 'SOL -> USDC -> SOL (SYNTHETIC ROUTE)',
    expectedInSol: 0.05,
    expectedOutSol: 0.055,
    grossProfitSol: 0.005,
    netProfit: 0.004,
    tipAmount: 0.001,
    pools: []
};

forceExecuteArbitrage(forceOpp).then(() => {
    logger.info("✅ Live Force Test Suite Execution Completed!");
    process.exit(0);
});
