/**
 * Quick probe: /swap/v1/quote → /swap/v1/swap → inspect tx + fee fields
 * No execution. Just verifies the endpoint works and shows what fees apply.
 */
require('dotenv').config();
const f = require('node-fetch');
const { Connection, VersionedTransaction } = require('@solana/web3.js');

const K    = process.env.JUPITER_API_KEY;
const RPC  = process.env.RPC_ENDPOINT;
const PK   = 'DnQhJawMXW7ZWA19XbzrV1q3KWZvMnpfyrxe4f74FHVj';
const SOL  = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const LAM  = 150_000_000; // 0.15 SOL
const conn = new Connection(RPC, { commitment: 'confirmed' });

async function main() {
  // Step 1: Quote
  console.log('Fetching /swap/v1/quote SOL→USDC...');
  const qr = await f(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${SOL}&outputMint=${USDC}&amount=${LAM}&slippageBps=20`, { headers: { 'x-api-key': K } });
  const q  = await qr.json();
  console.log('Quote status:', qr.status);
  console.log('Quote outAmount:', q.outAmount, '(USDC lamports)');
  console.log('Quote keys:', Object.keys(q).join(', '));
  if (!q.outAmount) { console.log('QUOTE FAILED:', JSON.stringify(q).slice(0,200)); return; }

  // Step 2: Swap (standard, no Ultra)
  console.log('\nFetching /swap/v1/swap...');
  const sr = await f('https://lite-api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': K },
    body: JSON.stringify({
      quoteResponse: q,
      userPublicKey: PK,
      wrapAndUnwrapSol: true,
      computeUnitPriceMicroLamports: 10000,
      prioritizationFeeLamports: 'auto',
    })
  });
  const s = await sr.json();
  console.log('Swap status:', sr.status);
  console.log('Swap keys:', Object.keys(s).join(', '));
  console.log('swapTransaction present:', !!s.swapTransaction);
  console.log('error:', s.error, '| code:', s.errorCode);

  if (s.swapTransaction) {
    const buf = Buffer.from(s.swapTransaction, 'base64');
    console.log('\nTx length:', buf.length, 'bytes');
    try {
      const tx = VersionedTransaction.deserialize(buf);
      const msg = tx.message;
      console.log('Tx version: versioned (v0)');
      console.log('Static account keys:', msg.staticAccountKeys.length);
      console.log('Instructions count:', msg.compiledInstructions.length);

      // Check for Jupiter fee-related accounts
      const accounts = msg.staticAccountKeys.map(k => k.toBase58());
      const JUPITER_FEE_ACCOUNT = 'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf';
      const hasJupFee = accounts.includes(JUPITER_FEE_ACCOUNT);
      console.log('\nJupiter platform fee account in tx:', hasJupFee ? '⚠️  YES (fee applies)' : '✅ NO (no platform fee)');
      console.log('All accounts:', accounts.slice(0,6).join('\n  '));
    } catch(e) {
      console.log('Deserialize error:', e.message);
    }
  }

  // Step 3: Simulate to get exact fee breakdown
  if (s.swapTransaction) {
    console.log('\nSimulating transaction (no execution)...');
    try {
      const buf = Buffer.from(s.swapTransaction, 'base64');
      const tx  = VersionedTransaction.deserialize(buf);
      const sim = await conn.simulateTransaction(tx, { commitment: 'processed', replaceRecentBlockhash: true });
      console.log('Simulation err:', sim.value.err || 'none ✅');
      console.log('Units consumed:', sim.value.unitsConsumed);
      const estFeeSOL = (sim.value.unitsConsumed * 10000) / 1e9; // at 10000 microlamports/CU
      console.log('Est priority fee:', estFeeSOL.toFixed(8), 'SOL @10k microLam/CU');
    } catch(e) {
      console.log('Sim error:', e.message.slice(0,100));
    }
  }
}
main().catch(e => console.log('FATAL:', e.message));
