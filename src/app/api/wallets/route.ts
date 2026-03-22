import { NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';

// ── Security: NO private keys ever in this file ───────────────────────────────
// Wallet dashboard shows only the single operator wallet (public key only)
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const WALLET_PUBLIC_KEY = process.env.WALLET_PUBLIC_KEY || '';

export async function GET() {
  try {
    if (!WALLET_PUBLIC_KEY) {
      return NextResponse.json([{ id: 'w1', pubkey: 'Not configured', balance: '0.000 SOL', status: 'Inactive', config: 'Set WALLET_PUBLIC_KEY env var' }]);
    }

    const connection = new Connection(RPC_ENDPOINT, 'confirmed');
    const pubkey = new PublicKey(WALLET_PUBLIC_KEY);
    const balLamps = await connection.getBalance(pubkey).catch(() => 0);
    const sol = (balLamps / 1e9).toFixed(6);

    return NextResponse.json([{
      id:      'w1',
      pubkey:  WALLET_PUBLIC_KEY,
      balance: `${sol} SOL`,
      status:  parseFloat(sol) > 0.001 ? 'Active' : 'Needs Funding',
      config:  'Jito Protected',
    }], {
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      }
    });
  } catch (e) {
    console.error('Wallet API Error:', e);
    return NextResponse.json([], { status: 500 });
  }
}

// ── POST: Disabled — wallet management is handled locally via .env only ───────
export async function POST() {
  return NextResponse.json(
    { error: 'Wallet registration is handled via server configuration, not the API.' },
    { status: 405 }
  );
}
