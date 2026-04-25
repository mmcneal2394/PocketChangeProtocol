import { PublicKey } from '@solana/web3.js';

function normalizeRpcValue(value: any): any {
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value)) return value.map(normalizeRpcValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeRpcValue(entry)]));
  }
  return value;
}

export async function callRpcGateway(method: string, params: any[] = []): Promise<any> {
  const endpoint = process.env.RPC_GATEWAY || process.env.RPC_ENDPOINT;
  if (!endpoint) {
    throw new Error('RPC endpoint is not configured');
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params: normalizeRpcValue(params),
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (payload?.error) {
    const detail = payload.error?.message || JSON.stringify(payload.error);
    throw new Error(`RPC ${method} failed: ${detail}`);
  }
  return payload?.result;
}

module.exports = { callRpcGateway };
