import { AddressLookupTableAccount } from '@solana/web3.js';
export declare function fetchRecentBlockhash(): Promise<string | undefined>;
export declare function getCachedBlockhash(): string | null;
export declare function startBlockhashCache(): Promise<void>;
export declare function getAddressLookupTable(address: string, forceRefresh?: boolean): Promise<AddressLookupTableAccount | null | undefined>;
//# sourceMappingURL=cache.d.ts.map