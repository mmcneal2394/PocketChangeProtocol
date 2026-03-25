/**
 * readiness_check.ts — Full system readiness check before going live
 * Run: npx ts-node scripts/readiness_check.ts
 *
 * Checks: ENV vars, RPC ping, Geyser reachability, Jupiter API, wallet, price feed
 */
import * as dotenv from 'dotenv';
dotenv.config();
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

const PASS = '✅';
const FAIL = '❌';
const WARN = '⚠️';

interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn';
  detail: string;
}
const results: CheckResult[] = [];

function check(name: string, status: 'pass' | 'fail' | 'warn', detail: string) {
  const icon = status === 'pass' ? PASS : status === 'warn' ? WARN : FAIL;
  console.log(`  ${icon}  ${name.padEnd(32)} ${detail}`);
  results.push({ name, status, detail });
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║   PCP Arb Engine — LIVE READINESS CHECK              ║');
  console.log(`║   ${new Date().toISOString()}               ║`);
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // ── 1. Environment Variables ───────────────────────────────────────────────
  console.log('── [1] Environment Variables ─────────────────────────');
  const required = ['RPC_ENDPOINT', 'WALLET_KEYPAIR_PATH'];
  const optional = ['JUPITER_API_KEY', 'GEYSER_RPC', 'GEYSER_API_TOKEN'];
  for (const v of required) {
    const val = process.env[v];
    check(v, val ? 'pass' : 'fail', val ? `${val.slice(0, 30)}…` : 'MISSING');
  }
  for (const v of optional) {
    const val = process.env[v];
    check(v, val ? 'pass' : 'warn', val ? `${val.slice(0, 20)}…` : 'not set (optional)');
  }

  // ── 2. Wallet keypair ─────────────────────────────────────────────────────
  console.log('\n── [2] Wallet ────────────────────────────────────────');
  const kpPath = process.env.WALLET_KEYPAIR_PATH || '';
  if (fs.existsSync(kpPath)) {
    check('keypair file', 'pass', kpPath);
    try {
      const raw = JSON.parse(fs.readFileSync(kpPath, 'utf8'));
      const { Keypair } = await import('@solana/web3.js');
      const kp = Keypair.fromSecretKey(new Uint8Array(raw));
      check('wallet address', 'pass', kp.publicKey.toBase58());

      // Get balance
      const rpc = process.env.RPC_ENDPOINT!;
      const conn = new Connection(rpc, 'confirmed');
      const bal = await conn.getBalance(kp.publicKey);
      const solBal = bal / LAMPORTS_PER_SOL;
      const status = solBal >= 0.5 ? 'pass' : solBal >= 0.1 ? 'warn' : 'fail';
      check('wallet balance', status, `${solBal.toFixed(4)} SOL ${solBal < 0.1 ? '⚠️ TOO LOW' : solBal < 0.5 ? '(low — top up)' : '(sufficient)'}`);
    } catch (e: any) {
      check('wallet parse', 'fail', e.message);
    }
  } else {
    check('keypair file', 'fail', `not found: ${kpPath}`);
  }

  // ── 3. RPC ────────────────────────────────────────────────────────────────
  console.log('\n── [3] Helius RPC ────────────────────────────────────');
  try {
    const rpc = process.env.RPC_ENDPOINT!;
    const conn = new Connection(rpc, 'confirmed');
    const t0 = Date.now();
    const slot = await conn.getSlot();
    const latency = Date.now() - t0;
    check('RPC ping', latency < 500 ? 'pass' : 'warn', `slot ${slot.toLocaleString()} | ${latency}ms`);
  } catch (e: any) {
    check('RPC ping', 'fail', e.message.slice(0, 60));
  }

  // ── 4. Jupiter API ────────────────────────────────────────────────────────
  console.log('\n── [4] Jupiter Lite API ──────────────────────────────');
  try {
    const t0 = Date.now();
    const resp = await fetch(
      `https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=100000000&slippageBps=50`,
      { signal: AbortSignal.timeout(8000) }
    );
    const latency = Date.now() - t0;
    if (resp.ok) {
      const d = await resp.json();
      const price = (Number(d.outAmount) / 1e6).toFixed(2);
      check('Jupiter quote', 'pass', `SOL→USDC: $${price} | ${latency}ms`);
    } else {
      check('Jupiter quote', 'warn', `HTTP ${resp.status} | ${latency}ms`);
    }
  } catch (e: any) {
    check('Jupiter quote', 'fail', e.message.slice(0, 60));
  }

  // ── 5. Price Feed ─────────────────────────────────────────────────────────
  console.log('\n── [5] Live Price Feed ───────────────────────────────');
  try {
    const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {
      signal: AbortSignal.timeout(5000)
    });
    if (resp.ok) {
      const d = await resp.json();
      const price = d.solana.usd;
      const status = price > 50 && price < 1000 ? 'pass' : 'warn';
      check('SOL price (CoinGecko)', status, `$${price}`);
    }
  } catch (e: any) {
    check('SOL price (CoinGecko)', 'warn', e.message.slice(0, 40));
  }

  try {
    const resp = await fetch(
      `https://lite-api.jup.ag/swap/v1/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000000&slippageBps=50`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (resp.ok) {
      const d = await resp.json();
      const price = (Number(d.outAmount) / 1e6).toFixed(2);
      check('SOL price (Jupiter)', 'pass', `$${price}`);
    }
  } catch (e: any) {
    check('SOL price (Jupiter)', 'warn', e.message.slice(0, 40));
  }

  // ── 6. ATA Cache ─────────────────────────────────────────────────────────
  console.log('\n── [6] ATA Cache ─────────────────────────────────────');
  const ataPath = path.join(__dirname, '..', 'ata_cache.json');
  if (fs.existsSync(ataPath)) {
    const cache = JSON.parse(fs.readFileSync(ataPath, 'utf8'));
    const count = Array.isArray(cache) ? cache.length : Object.keys(cache).length;
    check('ata_cache.json', 'pass', `${count} pre-created ATAs`);
  } else {
    check('ata_cache.json', 'warn', 'not found — run setup_atas.ts to save gas');
  }

  // ── 7. Geyser ────────────────────────────────────────────────────────────
  console.log('\n── [7] Geyser / Chainstack ───────────────────────────');
  const geyserEndpoint = process.env.GEYSER_RPC || '';
  if (geyserEndpoint) {
    check('GEYSER_ENDPOINT', 'pass', geyserEndpoint.slice(0, 35) + '…');
    check('gRPC connection', 'warn', 'requires live engine to verify (skipped in check)');
  } else {
    check('GEYSER_ENDPOINT', 'warn', 'not set — Geyser will use fallback polling');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const passes = results.filter(r => r.status === 'pass').length;
  const warns  = results.filter(r => r.status === 'warn').length;
  const fails  = results.filter(r => r.status === 'fail').length;
  const total  = results.length;

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log(`║  RESULTS: ${passes}/${total} passed | ${warns} warnings | ${fails} failures   `);
  const ready = fails === 0;
  const verdict = fails === 0 && warns <= 2
    ? '🟢 READY FOR LIVE'
    : fails === 0
    ? '🟡 READY WITH WARNINGS'
    : '🔴 NOT READY — fix failures first';
  console.log(`║  VERDICT: ${verdict}`);
  console.log('╚══════════════════════════════════════════════════════╝\n');

  if (fails > 0) {
    console.log('Failures to fix:');
    results.filter(r => r.status === 'fail').forEach(r => {
      console.log(`  ❌ ${r.name}: ${r.detail}`);
    });
  }
  if (warns > 0) {
    console.log('Warnings (non-blocking):');
    results.filter(r => r.status === 'warn').forEach(r => {
      console.log(`  ⚠️  ${r.name}: ${r.detail}`);
    });
  }
  process.exit(fails > 0 ? 1 : 0);
}

main().catch(e => { console.error('Check failed:', e); process.exit(1); });
