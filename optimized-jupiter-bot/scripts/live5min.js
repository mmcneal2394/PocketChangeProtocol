/**
 * 5-Minute Live Confirmation Test
 * =================================
 * - Executes real on-chain swaps using Jupiter Ultra API
 * - Trade size: 0.01 SOL per leg (minimal wallet exposure)
 * - Strategy: SOL → Token → SOL round trip via Ultra /order + /execute
 * - Duration: 5 minutes then stops and prints full summary
 * - Reports every Solscan TX hash in real-time
 *
 * Usage: node scripts/live5min.js
 */

require('dotenv').config();
const { Connection, Keypair, VersionedTransaction, Transaction } = require('@solana/web3.js');
const fs    = require('fs');
const fetch = require('node-fetch');
const bs58  = require('bs58');

const RPC   = process.env.RPC_ENDPOINT        || 'https://api.mainnet-beta.solana.com';
const WPATH = process.env.WALLET_KEYPAIR_PATH  || './real_wallet.json';
const KEY   = process.env.JUPITER_API_KEY      || '';
const BASE  = 'https://lite-api.jup.ag';
const SOL   = 'So11111111111111111111111111111111111111112';

const TRADE_SOL  = 0.01;                // ← 0.01 SOL per round-trip (minimal exposure)
const TRADE_LAM  = Math.floor(TRADE_SOL * 1e9);
const RUN_MS     = 5 * 60 * 1000;       // 5 minutes
const PAUSE_MS   = 12000;               // 12 seconds between trades (rate-limit safe)
const SLIP       = 50;                  // 0.5% slippage — looser to guarantee fill
const EXCLUDE    = encodeURIComponent(
  'GoonFi V2,AlphaQ,SolFi V2,BisonFi,HumidiFi,Sanctum,Sanctum Infinity,' +
  'VaultLiquidUnstake,eversol-stake-pool,socean-stake-pool,Marinade,Lido,SolBlaze'
);

// Rotation of proven high-liquidity tokens
const TOKENS = [
  { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' },
  { symbol: 'RAY',  mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
  { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { symbol: 'WIF',  mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  { symbol: 'JUP',  mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'  },
];

const connection = new Connection(RPC, { commitment: 'confirmed' });
const walletRaw  = JSON.parse(fs.readFileSync(WPATH, 'utf-8'));
const wallet     = Keypair.fromSecretKey(new Uint8Array(walletRaw));

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function jupFetch(path, opts = {}) {
  const url = `${BASE}${path}`;
  const res  = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, ...(opts.headers || {}) }
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 150)}`);
  return JSON.parse(text);
}

async function signAndSend(b64tx) {
  const buf  = Buffer.from(b64tx, 'base64');
  let tx;
  try {
    tx = VersionedTransaction.deserialize(buf);
    tx.sign([wallet]);
  } catch(_) {
    tx = Transaction.from(buf);
    tx.sign(wallet);
  }
  const signed = Buffer.from(tx.serialize()).toString('base64');
  return { signed, sig: bs58.encode(tx.signatures[0]) };
}

async function executeUltraLeg(inputMint, outputMint, amount, label) {
  const order = await jupFetch(
    `/ultra/v1/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIP}&taker=${wallet.publicKey.toBase58()}&excludeDexes=${EXCLUDE}`
  );
  if (order.error) throw new Error(`Order error: ${JSON.stringify(order)}`);

  const { signed, sig } = await signAndSend(order.transaction);

  const exec = await jupFetch('/ultra/v1/execute', {
    method: 'POST',
    body: JSON.stringify({ signedTransaction: signed, requestId: order.requestId })
  });

  return { status: exec.status, sig, outAmount: order.outAmount, error: exec.error };
}

async function roundTrip(token) {
  const start = Date.now();
  process.stdout.write(`  → LEG1: SOL(${TRADE_SOL}) → ${token.symbol}... `);

  const leg1 = await executeUltraLeg(SOL, token.mint, TRADE_LAM, `SOL→${token.symbol}`);
  if (leg1.status !== 'Success') throw new Error(`Leg1 failed: ${leg1.error || leg1.status}`);
  const outAmount = parseInt(leg1.outAmount || '0');
  console.log(`✅ (${Date.now()-start}ms)  sig: https://solscan.io/tx/${leg1.sig}`);

  await sleep(3000); // brief pause between legs

  process.stdout.write(`  → LEG2: ${token.symbol}(${outAmount}) → SOL... `);
  const leg2 = await executeUltraLeg(token.mint, SOL, outAmount, `${token.symbol}→SOL`);
  if (leg2.status !== 'Success') throw new Error(`Leg2 failed: ${leg2.error || leg2.status}`);
  const roundMs = Date.now() - start;
  console.log(`✅ (${roundMs}ms)  sig: https://solscan.io/tx/${leg2.sig}`);

  return { sig1: leg1.sig, sig2: leg2.sig, ms: roundMs, symbol: token.symbol };
}

async function main() {
  const startBalance = (await connection.getBalance(wallet.publicKey)) / 1e9;
  const endTime      = Date.now() + RUN_MS;
  let tokenIdx       = 0;
  const trades       = [];
  const failed       = [];

  console.log('\n' + '═'.repeat(64));
  console.log('  🧪 5-MINUTE LIVE CONFIRMATION TEST');
  console.log('═'.repeat(64));
  console.log(`  Wallet:      ${wallet.publicKey.toBase58()}`);
  console.log(`  Balance:     ${startBalance.toFixed(6)} SOL`);
  console.log(`  Trade Size:  ${TRADE_SOL} SOL per round-trip (minimal exposure)`);
  console.log(`  Slippage:    0.5% (loose — guarantees fill)`);
  console.log(`  Duration:    5 minutes`);
  console.log(`  Pause:       ${PAUSE_MS/1000}s between trades`);
  console.log(`  DEX Filter:  Vote-account pools excluded ✅`);
  console.log('═'.repeat(64) + '\n');

  let round = 0;
  while (Date.now() < endTime) {
    round++;
    const remaining = Math.round((endTime - Date.now()) / 1000);
    const token = TOKENS[tokenIdx % TOKENS.length];
    tokenIdx++;

    console.log(`\n[Round ${round}] ${token.symbol} | ~${remaining}s remaining`);

    try {
      const result = await roundTrip(token);
      trades.push(result);
      console.log(`  ✅ Round-trip complete in ${result.ms}ms`);
    } catch(e) {
      failed.push({ round, symbol: token.symbol, error: e.message.slice(0, 120) });
      console.log(`  ❌ Failed: ${e.message.slice(0, 120)}`);
    }

    if (Date.now() < endTime) {
      const wait = Math.min(PAUSE_MS, endTime - Date.now());
      if (wait > 1000) {
        process.stdout.write(`  ⏳ Next trade in ${wait/1000}s...`);
        await sleep(wait);
        process.stdout.write(`\r  ✓ Ready                     \n`);
      }
    }
  }

  // ── Final Report ──────────────────────────────────────────────────
  const finalBalance = (await connection.getBalance(wallet.publicKey)) / 1e9;
  const delta        = finalBalance - startBalance;

  console.log('\n' + '═'.repeat(64));
  console.log('  📊 5-MINUTE TEST SUMMARY');
  console.log('═'.repeat(64));
  console.log(`  Balance Before:  ${startBalance.toFixed(6)} SOL`);
  console.log(`  Balance After:   ${finalBalance.toFixed(6)} SOL`);
  console.log(`  Net Delta:       ${delta >= 0 ? '+' : ''}${delta.toFixed(6)} SOL  (fees + slippage cost)`);
  console.log(`  Rounds:          ${round}`);
  console.log(`  Successful:      ${trades.length}`);
  console.log(`  Failed:          ${failed.length}`);
  console.log('─'.repeat(64));

  if (trades.length > 0) {
    console.log(`\n  ✅ CONFIRMED ON-CHAIN TRANSACTIONS:`);
    trades.forEach((t, i) => {
      console.log(`  [${i+1}] ${t.symbol} round-trip (${t.ms}ms)`);
      console.log(`      LEG1: https://solscan.io/tx/${t.sig1}`);
      console.log(`      LEG2: https://solscan.io/tx/${t.sig2}`);
    });
  }

  if (failed.length > 0) {
    console.log(`\n  ❌ FAILURES:`);
    failed.forEach(f => console.log(`  Round ${f.round} [${f.symbol}]: ${f.error}`));
  }

  console.log('\n' + '═'.repeat(64) + '\n');

  // Write JSON summary for easy import
  fs.writeFileSync('./live5min_summary.json', JSON.stringify({
    timestamp: new Date().toISOString(),
    wallet: wallet.publicKey.toBase58(),
    balanceBefore: startBalance,
    balanceAfter: finalBalance,
    delta,
    trades,
    failed
  }, null, 2));
  console.log('  📄 Full summary written to live5min_summary.json');
}

main().catch(e => { console.error('\n❌ FATAL:', e.message); process.exit(1); });
