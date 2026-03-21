require('dotenv').config();
const f = require('node-fetch');
const W = 'DnQhJawMXW7ZWA19XbzrV1q3KWZvMnpfyrxe4f74FHVj';
const K = process.env.JUPITER_API_KEY;
const U = 'https://lite-api.jup.ag/ultra/v1';
const S = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function main() {
  console.log('Testing LEG1: SOL->USDC...');
  const r1 = await f(`${U}/order?inputMint=${S}&outputMint=${USDC}&amount=150000000&slippageBps=20&taker=${W}`, { headers: { 'x-api-key': K } });
  console.log('LEG1 status:', r1.status);
  const o1 = await r1.json();
  console.log('LEG1 keys:', Object.keys(o1));
  console.log('LEG1 outAmount:', o1.outAmount);
  console.log('LEG1 error:', o1.error);
  console.log('LEG1 errorMessage:', o1.errorMessage);
  console.log('LEG1 transaction:', o1.transaction ? o1.transaction.slice(0,30)+'...' : 'NULL');
  console.log('LEG1 requestId:', o1.requestId);

  if (!o1.outAmount) { console.log('STOP: no outAmount'); return; }
  await new Promise(r => setTimeout(r, 1000));

  const amt2 = Number(o1.outAmount);
  console.log('\nTesting LEG2: USDC->SOL, amount:', amt2);
  const r2 = await f(`${U}/order?inputMint=${USDC}&outputMint=${S}&amount=${amt2}&slippageBps=20&taker=${W}`, { headers: { 'x-api-key': K } });
  console.log('LEG2 status:', r2.status);
  const o2 = await r2.json();
  console.log('LEG2 keys:', Object.keys(o2));
  console.log('LEG2 outAmount:', o2.outAmount);
  console.log('LEG2 error:', o2.error);
  console.log('LEG2 errorMessage:', o2.errorMessage);
  console.log('LEG2 transaction:', o2.transaction ? o2.transaction.slice(0,30)+'...' : 'NULL');
  console.log('LEG2 requestId:', o2.requestId);

  if (o2.outAmount) {
    const net = (Number(o2.outAmount) - 150000000) / 1e9;
    console.log('\nRound-trip net:', net.toFixed(6), 'SOL');
  }
}
main().catch(e => console.log('FATAL:', e.message));
