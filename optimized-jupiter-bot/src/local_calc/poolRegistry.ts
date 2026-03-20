import { Connection, PublicKey } from '@solana/web3.js';
import { PoolState } from './price_book';

export class PoolRegistry {
  private pools = new Map<string, PoolState>();
  private byToken = new Map<string, Set<string>>();

  add(info: PoolState) {
    this.pools.set(info.address, info);
    if (!this.byToken.has(info.tokenA)) this.byToken.set(info.tokenA, new Set());
    if (!this.byToken.has(info.tokenB)) this.byToken.set(info.tokenB, new Set());
    this.byToken.get(info.tokenA)!.add(info.address);
    this.byToken.get(info.tokenB)!.add(info.address);
  }

  getPoolsForToken(token: string): PoolState[] {
    const addresses = this.byToken.get(token) || new Set();
    return Array.from(addresses).map(addr => this.pools.get(addr)).filter(Boolean) as PoolState[];
  }

  async pruneDeadPools(connection: Connection) {
    for (const [addr, info] of this.pools) {
      try {
        const account = await connection.getAccountInfo(new PublicKey(addr));
        if (!account || account.lamports === 0) {
          this.pools.delete(addr);
          this.byToken.get(info.tokenA)?.delete(addr);
          this.byToken.get(info.tokenB)?.delete(addr);
        }
      } catch { 
         // gracefully suppress RPC errors during mass pruning sweeps
      }
    }
  }

  getAllPools(): PoolState[] {
      return Array.from(this.pools.values());
  }
}

export const globalPoolRegistry = new PoolRegistry();
