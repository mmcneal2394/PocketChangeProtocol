export interface ArbitrageOpportunity {
    tokenA: string;
    tokenB: string;
    profitBps: number;
    expectedOutput: number;
    routes: string[];
}
export interface SwapInstructions {
    setupInstructions: any[];
    swapInstruction: any;
    cleanupInstruction: any;
    addressLookupTableAddresses: string[];
}
export interface ParallelSwapResult {
    ix1: SwapInstructions;
    ix2: SwapInstructions;
}
export interface RacingResult {
    success: boolean;
    signature?: string;
    provider?: 'jito-bundle' | 'jito-single' | 'rpc';
    error?: string;
}
//# sourceMappingURL=index.d.ts.map