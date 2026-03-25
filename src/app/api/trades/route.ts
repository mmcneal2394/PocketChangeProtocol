import { NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';
import path from 'path';
import fs from 'fs';

// ── Security: NEVER read .env from disk — use process.env only ───────────────
// Wallet balance is read-only (public key only, no private key needed)
const RPC_URL   = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const WALLET_PK = process.env.WALLET_PUBLIC_KEY || '';

// ── Security: Sanitize all output fields before sending to client ─────────────
function sanitizeOutput(val: unknown, maxLen = 200): string {
  if (val === null || val === undefined) return '';
  const s = String(val);
  return s
    .replace(/<[^>]*>/g, '')       // strip HTML
    .replace(/[<>'"]/g, '')        // strip XSS chars
    .slice(0, maxLen);
}

export async function GET() {
  try {
    // ── Wallet balance: public key only, no private key involved ─────────────
    let balance = 0;
    if (WALLET_PK) {
      try {
        const connection = new Connection(RPC_URL, 'confirmed');
        balance = await connection.getBalance(new PublicKey(WALLET_PK)) / 1e9;
      } catch { balance = 0; }
    }

    // ── Read trade logs ───────────────────────────────────────────────────────
    // Try telemetry.jsonl (engine-worker output), fallback to trades.json
    const candidatePaths = [
      path.join(process.cwd(), 'engine-worker', 'telemetry.jsonl'),
      path.join(process.cwd(), 'telemetry.jsonl'),
      path.join(process.cwd(), 'trades.json'),
    ];

    let rawLogs: any[] = [];
    for (const dbPath of candidatePaths) {
      if (!fs.existsSync(dbPath)) continue;
      try {
        const raw = fs.readFileSync(dbPath, 'utf8').trim();
        if (dbPath.endsWith('.jsonl')) {
          rawLogs = raw.split('\n')
            .map(l => l.trim())
            .filter(l => l.startsWith('{'))
            .map(l => JSON.parse(l));
        } else {
          rawLogs = JSON.parse(raw);
        }
        if (rawLogs.length > 0) break;
      } catch { continue; }
    }

    const recentLogs = rawLogs.slice(-15).reverse();

    // ── Sanitize all fields before returning to client ────────────────────────
    const formattedLogs = recentLogs.map((tx: any) => {
      const isSuccess = sanitizeOutput(tx.status, 20).includes('SUCCESS');
      const profitSol = parseFloat(tx.profit_sol || tx.profitAmt || 0);
      const safePct   = isNaN(profitSol) ? 0 : Math.min(100, Math.max(-100, profitSol));
      const shortHash = sanitizeOutput(tx.tx_signature || tx.txHash, 100);
      const displayHash = shortHash.length > 9
        ? `${shortHash.slice(0, 5)}...${shortHash.slice(-4)}`
        : 'REJECTED';

      return {
        id:      sanitizeOutput(tx.tx_signature || tx.id || String(Math.random()), 100),
        route:   sanitizeOutput(tx.route || 'UNKNOWN', 80),
        status:  sanitizeOutput(tx.status || 'FAILED', 20),
        profit:  isSuccess ? `+${safePct.toFixed(4)} SOL` : '$0.00',
        ok:      isSuccess,
        hash:    displayHash,
        details: sanitizeOutput(`Latency: ${tx.execution_time_ms || '?'}ms`, 80),
        balance: parseFloat(balance.toFixed(6)),
      };
    });

    return NextResponse.json(formattedLogs, {
      headers: {
        // Prevent caching of live trade data
        'Cache-Control': 'no-store',
        // Content security
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
      }
    });

  } catch (error) {
    console.error('Trade API Error:', error);
    return NextResponse.json([], { status: 500 });
  }
}
