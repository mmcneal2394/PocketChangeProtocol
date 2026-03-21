"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.globalPriceBook = exports.PriceBook = void 0;
class PriceBook {
    constructor() {
        this.raydiumPools = new Map();
        this.orcaPools = new Map();
        this.meteoraPools = new Map();
    }
    updatePool(accountData) {
        // Parse raw Geyser data into PoolState based on owner Program ID
        // Simplified structure for the mathematical mock
        const owner = accountData?.account?.owner?.toString() || "";
        const pubkey = accountData?.pubkey?.toString() || "UNKNOWN";
        const now = Date.now();
        // Here we would deserialize the buffer based on DEX layout
        // For architectural setup, we mock the parsing
        if (owner.includes("675kPX9MHTjS")) {
            this.raydiumPools.set(pubkey, { address: pubkey, dex: "Raydium", tokenA: "SOL", tokenB: "USDC", reserveA: 100n, reserveB: BigInt(Math.floor(15000 + Math.random() * 50)), feeRate: 0.0025, lastUpdated: now });
        }
        else if (owner.includes("whirLbMiicV")) {
            // Massive simulated discrepancy mapping
            this.orcaPools.set(pubkey, { address: pubkey, dex: "Orca", tokenA: "SOL", tokenB: "USDC", reserveA: 100n, reserveB: BigInt(Math.floor(65200 + Math.random() * 50)), feeRate: 0.0030, lastUpdated: now });
        }
        else if (owner.includes("Eo7WjKq67r")) {
            this.meteoraPools.set(pubkey, { address: pubkey, dex: "Meteora", tokenA: "SOL", tokenB: "USDC", reserveA: 100n, reserveB: 14980n, feeRate: 0.0015, lastUpdated: now });
        }
    }
    getAllPools() {
        return [
            ...Array.from(this.raydiumPools.values()),
            ...Array.from(this.orcaPools.values()),
            ...Array.from(this.meteoraPools.values()),
        ];
    }
    // Calculate expected output for Token A -> Token B natively (Constant Product formula minimal)
    calculateOutput(pool, amountIn, isAToB) {
        const reserveIn = isAToB ? Number(pool.reserveA) : Number(pool.reserveB);
        const reserveOut = isAToB ? Number(pool.reserveB) : Number(pool.reserveA);
        const amountInWithFee = amountIn * (1 - pool.feeRate);
        const denominator = reserveIn + amountInWithFee;
        if (denominator === 0)
            return 0;
        return (amountInWithFee * reserveOut) / denominator;
    }
}
exports.PriceBook = PriceBook;
exports.globalPriceBook = new PriceBook();
