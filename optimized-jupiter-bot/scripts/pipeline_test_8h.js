/**
 * 8-HOUR FORCED PIPELINE VERIFICATION TEST
 * ═══════════════════════════════════════════
 * Forces a SOL→TOKEN→SOL round-trip every 5 minutes regardless of profit.
 * Purpose: verify the full pipeline — quote, swap, confirm, dynamicSlippage,
 * fee collection — is working correctly after all recent fixes.
 *
 * Trade size: 0.01 SOL (small to minimize test cost)
 * Duration:   8 hours = 96 forced trades
 * Output:     pipeline_test_report.json + console log
 */
'use strict';
require('dotenv').config();
const nodeFetch = require('node-fetch');
const { Connection, Keypair, VersionedTransaction, Transaction } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────
const RPC       = process.env.RPC_ENDPOINT;
const JUP_KEY   = process.env.JUPITER_API_KEY;
const JUP_BASE  = 'https://api.jup.ag/swap/v1';
const JUP_H     = { 'Content-Type': 'application/json', 'x-api-key': JUP_KEY };
const FEE_ACCT  = process.env.PLATFORM_FEE_ACCOUNT_USDC || '';
const FEE_BPS   = parseInt(process.env.PLATFORM_FEE_BPS || '20');
const wSOL      = 'So11111111111111111111111111111111111111112';
const USDC      = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const TRADE_LAM    = 20_000_000;   // 0.02 SOL — larger = priority fee is smaller %
const INTERVAL_MS  = 5 * 60_000;  // 5 minutes
const DURATION_MS  = 8 * 60 * 60_000; // 8 hours
const REPORT_FILE  = path.join(__dirname, '..', 'pipeline_test_report.json');

// Candidate tokens to test (rotate through them)
const TOKENS = [
  { symbol: 'USDC',   mint: USDC },
  { symbol: 'BONK',   mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { symbol: 'WIF',    mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  { symbol: 'JUP',    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
  { symbol: 'BOME',   mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82' },
  { symbol: 'POPCAT', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
];

// ── State ────────────────────────────────────────────────────────────────────
const wallet  = Keypair.fromSecretKey(new Uint8Array(JSON.parse(fs.readFileSync(
  process.env.WALLET_KEYPAIR_PATH || './real_wallet.json', 'utf-8'))));
const conn    = new Connection(RPC, 'confirmed');
const start   = Date.now();
const end     = start + DURATION_MS;

const report  = { wallet: wallet.publicKey.toBase58(), startTime: new Date().toISOString(),
  totalTrades: 0, success: 0, failed: 0, totalCostLam: 0, trades: [] };

function saveReport() { fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2)); }

function log(msg) {
  const ts = new Date().toISOString().slice(11,19);
  console.log(`[${ts}] ${msg}`);
}

// ── Jupiter helpers ──────────────────────────────────────────────────────────
async function jupQuote(inM, outM, amt) {
  let url = `${JUP_BASE}/quote?inputMint=${inM}&outputMint=${outM}&amount=${amt}&slippageBps=200`;
  if (FEE_ACCT && FEE_BPS > 0 && outM === USDC) url += `&platformFeeBps=${FEE_BPS}`;
  const r = await nodeFetch(url, { headers: JUP_H });
  if (!r.ok) throw new Error(`quote ${r.status}`);
  const j = await r.json();
  if (!j.outAmount) throw new Error(`no outAmount: ${JSON.stringify(j).slice(0,60)}`);
  return j;
}

async function jupSwap(q) {
  const body = {
    quoteResponse: q,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    computeUnitPriceMicroLamports: 1_000_000,  // 1M — aggressive landing
    dynamicComputeUnitLimit: true,
    dynamicSlippage: true,
  };
  if (FEE_ACCT && q.outputMint === USDC) body.feeAccount = FEE_ACCT;
  const r = await nodeFetch(`${JUP_BASE}/swap`, { method: 'POST', headers: JUP_H, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`swap ${r.status}: ${(await r.text()).slice(0,60)}`);
  const j = await r.json();
  if (!j.swapTransaction) throw new Error(`no swapTx: ${JSON.stringify(j).slice(0,60)}`);
  return j.swapTransaction;
}

async function sendAndConfirm(txStr, label) {
  const buf = Buffer.from(txStr, 'base64');
  let tx; try { tx = VersionedTransaction.deserialize(buf); } catch(_) { tx = Transaction.from(buf); }
  tx.sign([wallet]);
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  log(`  🔗 ${label}: https://solscan.io/tx/${sig}`);
  const deadline = Date.now() + 45_000; // 45s tight window
  let lastResend = Date.now();
  while (Date.now() < deadline) {
    const st = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
    const s = st?.value;
    if (s?.err) throw new Error(`${label} err: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') {
      log(`  ✅ ${label} confirmed`);
      return sig;
    }
    // Resend every 5s to beat slot expiry
    if (Date.now() - lastResend > 5_000) {
      conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      lastResend = Date.now();
    }
    await new Promise(r => setTimeout(r, 1_000));
  }
  throw new Error(`${label} timeout`);
}

// ── Single forced trade round-trip ───────────────────────────────────────────
async function forcedTrade(tradeNum) {
  const token = TOKENS[tradeNum % TOKENS.length];
  const ts = new Date().toISOString();
  log(`\n${'─'.repeat(50)}`);
  log(`FORCED TRADE #${tradeNum} | Token: ${token.symbol} | ${ts}`);
  log(`${'─'.repeat(50)}`);

  const entry = { tradeNum, token: token.symbol, timestamp: ts, leg1Sig: null, leg2Sig: null,
    grossLam: null, success: false, error: null };

  const solBefore = await conn.getBalance(wallet.publicKey);
  log(`  SOL before: ${(solBefore/1e9).toFixed(6)}`);

  try {
    // LEG 1: SOL → TOKEN
    log(`  [LEG1] SOL → ${token.symbol}...`);
    const q1 = await jupQuote(wSOL, token.mint, TRADE_LAM);
    log(`    outAmount: ${Number(q1.outAmount).toLocaleString()} | fee: ${JSON.stringify(q1.platformFee||'none')}`);
    const tx1 = await jupSwap(q1);
    entry.leg1Sig = await sendAndConfirm(tx1, 'LEG1');

    await new Promise(r => setTimeout(r, 3_000)); // brief pause between legs

    // LEG 2: TOKEN → SOL
    log(`  [LEG2] ${token.symbol} → SOL...`);
    const q2 = await jupQuote(token.mint, wSOL, Number(q1.outAmount));
    log(`    outAmount: ${Number(q2.outAmount).toLocaleString()}`);
    const tx2 = await jupSwap(q2);
    entry.leg2Sig = await sendAndConfirm(tx2, 'LEG2');

    const solAfter = await conn.getBalance(wallet.publicKey);
    entry.grossLam = solAfter - solBefore;
    entry.success  = true;
    report.success++;
    report.totalCostLam += Math.abs(Math.min(0, entry.grossLam));

    log(`  📊 Net: ${entry.grossLam > 0 ? '+' : ''}${(entry.grossLam/1e9).toFixed(6)} SOL`);
    log(`     LEG1: https://solscan.io/tx/${entry.leg1Sig}`);
    log(`     LEG2: https://solscan.io/tx/${entry.leg2Sig}`);

  } catch(e) {
    entry.error = e.message;
    report.failed++;
    log(`  ❌ FAILED: ${e.message}`);
  }

  report.totalTrades++;
  report.trades.push(entry);
  saveReport();
}

// ── Main loop ────────────────────────────────────────────────────────────────
async function main() {
  log(`\n${'═'.repeat(50)}`);
  log(`  8-HOUR FORCED PIPELINE TEST`);
  log(`  Wallet: ${wallet.publicKey.toBase58()}`);
  log(`  Trade size: 0.01 SOL | Interval: 5min`);
  log(`  Tokens: ${TOKENS.map(t=>t.symbol).join(', ')}`);
  log(`  End time: ${new Date(end).toISOString().slice(11,19)}`);
  log(`${'═'.repeat(50)}\n`);

  let tradeNum = 1;

  // Immediate first trade
  await forcedTrade(tradeNum++);

  // Then every 5 minutes
  const iv = setInterval(async () => {
    if (Date.now() >= end) {
      clearInterval(iv);
      // Final summary
      log(`\n${'═'.repeat(50)}`);
      log(`  8-HOUR TEST COMPLETE`);
      log(`  Total trades:  ${report.totalTrades}`);
      log(`  Successful:    ${report.success}`);
      log(`  Failed:        ${report.failed}`);
      log(`  Total cost:    ${(report.totalCostLam/1e9).toFixed(6)} SOL`);
      log(`  Report saved:  ${REPORT_FILE}`);
      log(`${'═'.repeat(50)}`);
      report.endTime = new Date().toISOString();
      report.summary = `${report.success}/${report.totalTrades} trades succeeded, ${(report.totalCostLam/1e9).toFixed(6)} SOL test cost`;
      saveReport();
      process.exit(0);
    }
    const remaining = Math.ceil((end - Date.now()) / 60000);
    log(`\n⏳ ${remaining}min remaining — triggering trade #${tradeNum}`);
    await forcedTrade(tradeNum++);
  }, INTERVAL_MS);
}

main().catch(e => { log(`FATAL: ${e.message}`); process.exit(1); });
