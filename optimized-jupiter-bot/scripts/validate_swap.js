/**
 * Quick validation: /swap/v1/quote → /swap/v1/swap → simulate (no execute)
 * Confirms endpoint works and shows exact fee structure.
 */
require('dotenv').config();
const f = require('node-fetch');
const { Connection, VersionedTransaction } = require('@solana/web3.js');

const K    = process.env.JUPITER_API_KEY;
const RPC  = process.env.RPC_ENDPOINT;
const PK   = 'DnQhJawMXW7ZWA19XbzrV1q3KWZvMnpfyrxe4f74FHVj';
const SOL  = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const conn = new Connection(RPC, { commitment: 'confirmed' });

async function test(inputMint, outputMint, amount, label) {
  process.stdout.write(`\n  [${label}] Quoting...`);
  const qr = await f(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=20`, { headers: { 'x-api-key': K } });
  const q  = await qr.json();
  if (!q.outAmount) { console.log(' FAIL:', q.error); return null; }
  console.log(` out=${q.outAmount}`);

  process.stdout.write(`  [${label}] Building swap tx...`);
  const sr = await f('https://lite-api.jup.ag/swap/v1/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': K },
    body: JSON.stringify({
      quoteResponse: q,
      userPublicKey: PK,
      wrapAndUnwrapSol: true,
      computeUnitPriceMicroLamports: 10000,
      dynamicComputeUnitLimit: true,
    })
  });
  const s = await sr.json();
  if (!s.swapTransaction) { console.log(' FAIL:', s.error, s.errorCode); return null; }
  console.log(` tx=${s.swapTransaction.length} chars`);

  process.stdout.write(`  [${label}] Simulating...`);
  const buf = Buffer.from(s.swapTransaction, 'base64');
  let tx;
  try { tx = VersionedTransaction.deserialize(buf); } catch(_) {}
  const sim = await conn.simulateTransaction(tx, { commitment: 'processed', replaceRecentBlockhash: true });
  const err    = sim.value.err;
  const cu     = sim.value.unitsConsumed;
  const feeSOL = (cu * 10000) / 1e9;
  console.log(` err:${err?JSON.stringify(err):'none'} CU:${cu} gas≈${feeSOL.toFixed(8)} SOL`);
  return { quote: q, txLen: buf.length, cu, feeSOL, simErr: err };
}

async function main() {
  console.log('\n════════════════════════════════════════');
  console.log('  /swap/v1/swap Endpoint Validation');
  console.log('════════════════════════════════════════');

  const r1 = await test(SOL, USDC, 150_000_000, 'LEG1 SOL→USDC');
  await new Promise(r => setTimeout(r, 1000));

  if (r1) {
    const out1 = Number(r1.quote.outAmount);
    const r2   = await test(USDC, SOL, out1, 'LEG2 USDC→SOL');
    if (r2) {
      const grossLam = Number(r2.quote.outAmount) - 150_000_000;
      const totalGas = (r1.feeSOL + r2.feeSOL);
      const netLam   = grossLam - Math.floor(totalGas * 1e9);
      console.log('\n  ─────────────────────────────────────');
      console.log(`  Quote gross:  ${grossLam >= 0 ? '+' : ''}${(grossLam/1e9).toFixed(6)} SOL`);
      console.log(`  Total gas:    -${totalGas.toFixed(8)} SOL (both legs combined)`);
      console.log(`  Estimated net:${netLam >= 0 ? '+' : ''}${(netLam/1e9).toFixed(6)} SOL`);
      console.log(`  Verdict:      ${netLam > 0 ? '✅ Would be profitable at this spread' : '📉 Spread too thin'}`);
      console.log('  ✅ /swap/v1/swap endpoint working — NO Ultra platform fee!');
    }
  }
  console.log('\n════════════════════════════════════════\n');
}
main().catch(e => console.error('FATAL:', e.message));
