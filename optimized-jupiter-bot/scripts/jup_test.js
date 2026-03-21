// Test Jupiter price v3 and CoinGecko for LST prices
const f = require('node-fetch');
const h = { 'x-api-key': 'YOUR_JUPITER_API_KEY' };
const MSOL = 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So';
const SOL  = 'So11111111111111111111111111111111111111112';
const JSOL = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn';

(async () => {
  // Test v3
  const r3 = await f(`https://api.jup.ag/price/v3?ids=${MSOL},${SOL}`, { headers: h });
  console.log('v3 status:', r3.status);
  const t3 = await r3.text();
  console.log('v3 response:', t3.slice(0, 400));

  // Test CoinGecko for mSOL
  try {
    const rc = await f('https://api.coingecko.com/api/v3/simple/price?ids=msol,solana&vs_currencies=usd');
    const jc = await rc.json();
    console.log('CoinGecko mSOL:', jc.msol?.usd, 'SOL:', jc.solana?.usd);
    if (jc.msol?.usd && jc.solana?.usd) {
      console.log('mSOL/SOL ratio:', (jc.msol.usd / jc.solana.usd).toFixed(5));
    }
  } catch(e) { console.log('CoinGecko err:', e.message); }

  // Test Birdeye free tier
  try {
    const rb = await f(`https://public-api.birdeye.so/defi/price?address=${MSOL}`, { timeout: 5000 });
    const jb = await rb.json();
    console.log('Birdeye mSOL:', JSON.stringify(jb).slice(0, 200));
  } catch(e) { console.log('Birdeye err:', e.message); }
})().catch(e => console.error('ERR:', e.message));
