export declare function fetchJupiterQuote(inputToken: string, outputToken: string, amount: number): Promise<import("@jup-ag/api").QuoteResponse | null>;
export declare function getParallelSwapInstructions(quote1: any, quote2: any): Promise<{
    ix1: import("@jup-ag/api").SwapInstructionsResponse;
    ix2: import("@jup-ag/api").SwapInstructionsResponse;
} | null>;
//# sourceMappingURL=quotes.d.ts.map