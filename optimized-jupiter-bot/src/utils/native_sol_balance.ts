import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { callRpcGateway } from './rpc_client';

export const MIN_NATIVE_SOL_RESERVE = 0.02;

export interface NativeSolBalanceSnapshot {
  nativeLamports: number;
  nativeSol: number;
  totalSol: number;
  spendableSol: number;
  reserveSol: number;
}

function createTimeout(ms = 5_000): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error('RPC_TIMEOUT')), ms);
  });
}

export function computeSpendableNativeBalance(
  nativeLamports: number,
  reserveSol = MIN_NATIVE_SOL_RESERVE,
): NativeSolBalanceSnapshot {
  const safeLamports = Number.isFinite(nativeLamports) ? Math.max(0, nativeLamports) : 0;
  const safeReserveSol = Number.isFinite(reserveSol) ? Math.max(0, reserveSol) : MIN_NATIVE_SOL_RESERVE;
  const nativeSol = safeLamports / LAMPORTS_PER_SOL;
  return {
    nativeLamports: safeLamports,
    nativeSol,
    totalSol: nativeSol,
    spendableSol: Math.max(0, nativeSol - safeReserveSol),
    reserveSol: safeReserveSol,
  };
}

export async function getNativeBalanceLamports(
  connection: Connection,
  owner: PublicKey,
): Promise<number> {
  try {
    const viaGateway = await Promise.race([
      callRpcGateway('getBalance', [owner.toBase58()]),
      createTimeout(),
    ]) as any;
    const normalized = Number(viaGateway?.value ?? viaGateway ?? 0);
    if (Number.isFinite(normalized) && normalized >= 0) return normalized;
  } catch (error: any) {
    if (error?.message !== 'RPC_TIMEOUT') {
      console.warn(`[BALANCE] Gateway fallback for native SOL failed: ${error?.message || error}`);
    }
  }

  try {
    return await Promise.race([
      connection.getBalance(owner),
      createTimeout(),
    ]) as number;
  } catch (error: any) {
    if (error?.message !== 'RPC_TIMEOUT') {
      console.warn(`[BALANCE] Direct native SOL read failed: ${error?.message || error}`);
    }
    return 0;
  }
}

export async function getSpendableNativeBalance(
  connection: Connection,
  owner: PublicKey,
  reserveSol = MIN_NATIVE_SOL_RESERVE,
): Promise<NativeSolBalanceSnapshot> {
  const nativeLamports = await getNativeBalanceLamports(connection, owner);
  return computeSpendableNativeBalance(nativeLamports, reserveSol);
}
