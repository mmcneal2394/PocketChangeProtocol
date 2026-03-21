require('dotenv').config();
const f = require('node-fetch');
const KEY = process.env.JUPITER_API_KEY || 'YOUR_JUPITER_API_KEY';
const wSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TAKER = 'DnQhJawMXW7ZWA19XbzrV1q3KWZvMnpfyrxe4f74FHVj';
const AMT = 50000000;

async function probe(label, url, opts) {
  try {
    const r = await f(url, opts);
    const hdrs = {};
    for (const [k,v] of r.headers) if (k.includes('rate')||k.includes('limit')) hdrs[k]=v;
    const body = await r.text();
    console.log(`\n[${label}] ${r.status} | headers:${JSON.stringify(hdrs)}`);
    console.log(`  body: ${body.slice(0,200)}`);
  } catch(e) { console.log(`[${label}] ERR: ${e.message.slice(0,80)}`); }
}

async function main() {
  console.log('KEY:', KEY.slice(0,8)+'...');
  // Ultra v1 order (correct ultra endpoint for swap)
  await probe('ultra /v1/order POST', 'https://ultra-api.jup.ag/v1/order', {
    method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+KEY},
    body: JSON.stringify({ inputMint:wSOL, outputMint:USDC, amount:AMT, taker:TAKER })
  });
  // Ultra v1 quote  
  await probe('ultra /v1/quote GET', `https://ultra-api.jup.ag/v1/quote?inputMint=${wSOL}&outputMint=${USDC}&amount=${AMT}`, {
    headers: {'Authorization':'Bearer '+KEY}
  });
  // lite-api swap v1
  await probe('lite /swap/v1/quote', `https://lite-api.jup.ag/swap/v1/quote?inputMint=${wSOL}&outputMint=${USDC}&amount=${AMT}&slippageBps=50`, {});
  // Public v6 with key in header
  await probe('public v6/quote + key-header', `https://api.jup.ag/swap/v1/quote?inputMint=${wSOL}&outputMint=${USDC}&amount=${AMT}&slippageBps=50`, {
    headers:{'x-api-key':KEY}
  });
  await probe('api.jup.ag no key', `https://api.jup.ag/swap/v1/quote?inputMint=${wSOL}&outputMint=${USDC}&amount=${AMT}&slippageBps=50`, {});
}
main();
