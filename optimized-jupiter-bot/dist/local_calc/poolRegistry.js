"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.globalPoolRegistry = exports.PoolRegistry = void 0;
const web3_js_1 = require("@solana/web3.js");
class PoolRegistry {
    constructor() {
        this.pools = new Map();
        this.byToken = new Map();
    }
    add(info) {
        this.pools.set(info.address, info);
        if (!this.byToken.has(info.tokenA))
            this.byToken.set(info.tokenA, new Set());
        if (!this.byToken.has(info.tokenB))
            this.byToken.set(info.tokenB, new Set());
        this.byToken.get(info.tokenA).add(info.address);
        this.byToken.get(info.tokenB).add(info.address);
    }
    getPoolsForToken(token) {
        const addresses = this.byToken.get(token) || new Set();
        return Array.from(addresses).map(addr => this.pools.get(addr)).filter(Boolean);
    }
    async pruneDeadPools(connection) {
        for (const [addr, info] of this.pools) {
            try {
                const account = await connection.getAccountInfo(new web3_js_1.PublicKey(addr));
                if (!account || account.lamports === 0) {
                    this.pools.delete(addr);
                    this.byToken.get(info.tokenA)?.delete(addr);
                    this.byToken.get(info.tokenB)?.delete(addr);
                }
            }
            catch {
                // gracefully suppress RPC errors during mass pruning sweeps
            }
        }
    }
    getAllPools() {
        return Array.from(this.pools.values());
    }
}
exports.PoolRegistry = PoolRegistry;
exports.globalPoolRegistry = new PoolRegistry();
