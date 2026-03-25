import { NextResponse } from 'next/server';
import { Connection, PublicKey } from '@solana/web3.js';
import path from 'path';
import fs from 'fs';

// ── Security: Strict input sanitization ──────────────────────────────────────
function sanitizeString(val: unknown, maxLen = 200): string {
  if (typeof val !== 'string') return '';
  // Strip any HTML, script tags, or prompt-injection sequences
  return val
    .replace(/<[^>]*>/g, '')           // strip HTML tags
    .replace(/[{}<>]/g, '')            // strip template/injection chars
    .replace(/\bignore\b.*\binstruction\b/gi, '[filtered]') // prompt injection
    .replace(/\bsystem\b.*\bprompt\b/gi, '[filtered]')
    .slice(0, maxLen)
    .trim();
}

function sanitizeNumber(val: unknown, min = -1000, max = 1000): number {
  const n = parseFloat(String(val));
  if (isNaN(n)) return 0;
  return Math.min(max, Math.max(min, n));
}

// ── Auth: require TRADE_LOG_SECRET header ────────────────────────────────────
const TRADE_SECRET = process.env.TRADE_LOG_SECRET || '';

export async function POST(req: Request) {
  try {
    // ── Authentication ───────────────────────────────────────────────────────
    const authHeader = req.headers.get('x-trade-secret');
    if (!TRADE_SECRET || authHeader !== TRADE_SECRET) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // ── Parse & validate input ───────────────────────────────────────────────
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    // Whitelist exactly the fields we accept — reject everything else
    const ALLOWED_STATUSES = ['success', 'failed', 'pending', 'EXEC_SUCCESS', 'EXEC_FAILED'];
    const status = sanitizeString(body.status, 20);
    if (!ALLOWED_STATUSES.includes(status)) {
      return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
    }

    const log = {
      id:         `tx_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      walletId:   sanitizeString(body.walletPubkey, 44),   // base58 pubkey max
      status:     status,
      profitAmt:  sanitizeNumber(body.profitAmt, -100, 100),
      route:      sanitizeString(body.route, 100),
      txHash:     sanitizeString(body.txHash, 100),
      createdAt:  new Date().toISOString(),
    };

    // Validate pubkey format (base58, 32-44 chars)
    if (log.walletId && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(log.walletId)) {
      return NextResponse.json({ error: 'Invalid wallet address' }, { status: 400 });
    }

    // Write to trades.json (local file, not on Vercel — use DB in prod)
    const dbPath = path.join(process.cwd(), 'trades.json');
    let logs: any[] = [];
    try { logs = JSON.parse(fs.readFileSync(dbPath, 'utf8')); }
    catch { logs = []; }

    // Cap at 1000 entries to prevent disk bloat
    logs.push(log);
    if (logs.length > 1000) logs = logs.slice(-1000);
    fs.writeFileSync(dbPath, JSON.stringify(logs, null, 2));

    return NextResponse.json({ success: true, id: log.id });

  } catch (e: any) {
    console.error('Trade Log Error:', e.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
