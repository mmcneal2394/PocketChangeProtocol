/**
 * heartbeat.js — PCP Engine Liveness Pulse
 * ─────────────────────────────────────────
 * Every 60s: Jupiter quote (free — confirms RPC + Jupiter API alive)
 * Every 5min: micro-swap 0.001 SOL → USDC → SOL (verifies full swap pipeline)
 * 
 * Writes signals/heartbeat.json with liveness state readable by monitor UI.
 * Auto-restarts pcp-sniper if 3+ consecutive quote failures detected.
 */
const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const RPC        = process.env.RPC_ENDPOINT;
const JUP_KEY    = process.env.JUPITER_API_KEY || '';
const JUP_BASE   = process.env.JUPITER_ENDPOINT || 'https://api.jup.ag/swap/v1';
const WALLET_PATH= process.env.WALLET_KEYPAIR_PATH;
const SIGNALS    = path.join(__dirname, 'signals');
const HB_FILE    = path.join(SIGNALS, 'heartbeat.json');
const WSOL       = 'So11111111111111111111111111111111111111112';
const USDC       = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PING_LAMPORTS   = 1_000_000; // 0.001 SOL per pulse swap
const QUOTE_INTERVAL  = 60_000;    // quote every 60s
const SWAP_INTERVAL   = 3_600_000; // actual swap every 1h
const MAX_FAILURES    = 3;

const connection = new Connection(RPC, { commitment: 'confirmed' });
const walletJson = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
const wallet     = Keypair.fromSecretKey(new Uint8Array(walletJson));

let consecutiveFailures = 0;
let totalSwaps  = 0;
let totalPings  = 0;
let lastSwapTs  = 0;
let sessionStart= Date.now();

function writeState(status, latencyMs, note = '') {
  const state = {
    ts:               Date.now(),
    status,           // 'ok' | 'warn' | 'dead'
    latency_ms:       latencyMs,
    consecutive_failures: consecutiveFailures,
    total_pings:      totalPings,
    total_swaps:      totalSwaps,
    last_swap_ts:     lastSwapTs,
    session_start:    sessionStart,
    note,
    wallet: wallet.publicKey.toBase58().slice(0, 12) + '…',
  };
  fs.writeFileSync(HB_FILE, JSON.stringify(state, null, 2));
}

async function jupFetch(endpoint, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (JUP_KEY) headers['x-api-key'] = JUP_KEY;
  const res = await fetch(`${JUP_BASE}${endpoint}`, {
    method: 'POST', headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`JUP ${endpoint} ${res.status}`);
  return res.json();
}

async function getQuote(inMint, outMint, amountLamports) {
  const params = new URLSearchParams({
    inputMint: inMint, outputMint: outMint,
    amount: String(amountLamports), slippageBps: '100', restrictIntermediateTokens: 'true',
  });
  const headers = {};
  if (JUP_KEY) headers['x-api-key'] = JUP_KEY;
  const res = await fetch(`${JUP_BASE}/quote?${params}`, {
    headers, signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Quote ${res.status}`);
  return res.json();
}

// ── Quote ping — verifies RPC and Jupiter API ──────────────────────────────
async function quotePing() {
  const t0 = Date.now();
  try {
    await getQuote(WSOL, USDC, PING_LAMPORTS);
    const ms = Date.now() - t0;
    consecutiveFailures = 0;
    totalPings++;
    writeState('ok', ms, `quote OK in ${ms}ms`);
    console.log(`[HB] ✅ Quote ping OK — ${ms}ms | pings:${totalPings} swaps:${totalSwaps}`);
  } catch (e) {
    consecutiveFailures++;
    const ms = Date.now() - t0;
    writeState(consecutiveFailures >= MAX_FAILURES ? 'dead' : 'warn', ms, `quote fail: ${e.message}`);
    console.log(`[HB] ⚠️  Quote FAILED (${consecutiveFailures}/${MAX_FAILURES}) — ${e.message}`);
    if (consecutiveFailures >= MAX_FAILURES) {
      console.log('[HB] 🚨 3 consecutive failures — restarting pcp-sniper');
      try { execSync('pm2 restart pcp-sniper', { timeout: 10000 }); } catch {}
    }
  }
}

// ── Micro-swap — full pipeline test ───────────────────────────────────────
async function microSwap() {
  const t0 = Date.now();
  try {
    // SOL → USDC
    const quote = await getQuote(WSOL, USDC, PING_LAMPORTS);
    const swapData = await jupFetch('/swap', {
      quoteResponse: quote, userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true, prioritizationFeeLamports: 1000,
    });
    if (!swapData.swapTransaction) throw new Error('No swapTransaction returned');
    const buf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx  = VersionedTransaction.deserialize(buf);
    tx.sign([wallet]);
    const sig = await connection.sendTransaction(tx, { maxRetries: 2, skipPreflight: true });
    const ms  = Date.now() - t0;
    totalSwaps++;
    lastSwapTs = Date.now();
    writeState('ok', ms, `swap OK ${sig.slice(0,12)}… in ${ms}ms`);
    console.log(`[HB] 💊 Pulse swap confirmed — ${ms}ms | https://solscan.io/tx/${sig}`);
  } catch (e) {
    const ms = Date.now() - t0;
    consecutiveFailures++;
    writeState('warn', ms, `swap fail: ${e.message}`);
    console.log(`[HB] ❌ Pulse swap FAILED — ${e.message}`);
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────
console.log('[HB] PCP Heartbeat starting…');
console.log(`[HB]   Quote every ${QUOTE_INTERVAL/1000}s | Swap every ${SWAP_INTERVAL/1000}s`);
console.log(`[HB]   Wallet: ${wallet.publicKey.toBase58().slice(0, 16)}…`);

writeState('ok', 0, 'starting');

// Run quote immediately
quotePing();

// Quote loop
setInterval(quotePing, QUOTE_INTERVAL);

// Swap loop (offset by 30s so it doesn't collide with first quote)
setTimeout(() => {
  microSwap();
  setInterval(microSwap, SWAP_INTERVAL);
}, 30_000);
