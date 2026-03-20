import { VersionedTransaction } from '@solana/web3.js';
export declare function submitTransactionWithRacing(transaction: VersionedTransaction): Promise<[PromiseSettledResult<{
    success: boolean;
    provider: string;
    result: import("@solsdk/jito-ts/dist/sdk/block-engine/utils").Result<string, import("@solsdk/jito-ts/dist/sdk/block-engine/searcher").SearcherClientError>;
    error?: never;
} | {
    success: boolean;
    provider: string;
    error: any;
    result?: never;
}>, PromiseSettledResult<{
    success: boolean;
    provider: string;
    signature: string;
    error?: never;
} | {
    success: boolean;
    provider: string;
    error: any;
    signature?: never;
}>]>;
//# sourceMappingURL=racing.d.ts.map