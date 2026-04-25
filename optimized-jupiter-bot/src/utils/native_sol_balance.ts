import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { callRpcGateway } from './rpc_client';

export const MIN_NATIVE_SOL_RESERVE = 0.02;
const NATIVE_BALANCE_CACHE_TTL_MS = 15_000;

interface CachedNativeBalance {
  lamports: number;
  updatedAt: number;
}

const nativeBalanceCache = new Map<string, CachedNativeBalance>();

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

async function readBalanceLamports(
  connection: Connection,
  owner: PublicKey,
): Promise<number | null> {
  try {
    const lamports = await Promise.race([
      connection.getBalance(owner),
      createTimeout(),
    ]) as number;
    return Number.isFinite(lamports) && lamports >= 0 ? lamports : null;
  } catch {
    return null;
  }
}

function normalizeOwnerKey(owner: PublicKey | string): string {
  return typeof owner === 'string' ? owner : owner.toBase58();
}

export function rememberNativeBalanceLamports(
  owner: PublicKey | string,
  nativeLamports: number,
  now = Date.now(),
) {
  const lamports = Number(nativeLamports);
  if (!Number.isFinite(lamports) || lamports < 0) return;
  nativeBalanceCache.set(normalizeOwnerKey(owner), {
    lamports,
    updatedAt: now,
  });
}

export function getCachedNativeBalanceLamports(
  owner: PublicKey | string,
  maxAgeMs = NATIVE_BALANCE_CACHE_TTL_MS,
  now = Date.now(),
): { lamports: number; ageMs: number } | null {
  const cached = nativeBalanceCache.get(normalizeOwnerKey(owner));
  if (!cached) return null;
  const ageMs = Math.max(0, now - cached.updatedAt);
  if (ageMs > Math.max(0, maxAgeMs)) return null;
  return {
    lamports: cached.lamports,
    ageMs,
  };
}

export function resetNativeBalanceCacheForTests() {
  nativeBalanceCache.clear();
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
  const ownerKey = owner.toBase58();
  try {
    const viaGateway = await Promise.race([
      callRpcGateway('getBalance', [ownerKey]),
      createTimeout(),
    ]) as any;
    const normalized = Number(viaGateway?.value ?? viaGateway ?? 0);
    if (Number.isFinite(normalized) && normalized >= 0) {
      rememberNativeBalanceLamports(ownerKey, normalized);
      return normalized;
    }
  } catch (error: any) {
    if (error?.message !== 'RPC_TIMEOUT') {
      console.warn(`[BALANCE] Gateway fallback for native SOL failed: ${error?.message || error}`);
    }
  }

  const directLamports = await readBalanceLamports(connection, owner);
  if (directLamports !== null) {
    rememberNativeBalanceLamports(ownerKey, directLamports);
    return directLamports;
  }

  const freshRpcEndpoint =
    process.env.SOLANA_RPC_URL ||
    process.env.RPC_ENDPOINT ||
    (connection as any)?.rpcEndpoint ||
    'https://api.mainnet-beta.solana.com';
  if (freshRpcEndpoint) {
    const freshLamports = await readBalanceLamports(
      new Connection(freshRpcEndpoint, { commitment: 'confirmed' }),
      owner,
    );
    if (freshLamports !== null) {
      rememberNativeBalanceLamports(ownerKey, freshLamports);
      console.warn(
        `[BALANCE] Recovered native SOL balance from a fresh RPC connection for ${ownerKey.slice(0, 8)}...`,
      );
      return freshLamports;
    }
  }

  const cached = getCachedNativeBalanceLamports(ownerKey);
  if (cached) {
    console.warn(
      `[BALANCE] Using cached native SOL balance ${(
        cached.lamports / LAMPORTS_PER_SOL
      ).toFixed(4)} SOL for ${ownerKey.slice(0, 8)}... after read failure (${cached.ageMs}ms old).`,
    );
    return cached.lamports;
  }

  return 0;
}

export async function getSpendableNativeBalance(
  connection: Connection,
  owner: PublicKey,
  reserveSol = MIN_NATIVE_SOL_RESERVE,
): Promise<NativeSolBalanceSnapshot> {
  const nativeLamports = await getNativeBalanceLamports(connection, owner);
  return computeSpendableNativeBalance(nativeLamports, reserveSol);
}
