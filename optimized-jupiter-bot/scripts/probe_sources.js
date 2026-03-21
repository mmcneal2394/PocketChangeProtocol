require('dotenv').config();
const f = require('node-fetch');

async function probe(label, url, opts = {}) {
  try {
    const r = await f(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, ...opts });
    const body = await r.text();
    let j; try { j = JSON.parse(body); } catch(_) { j = null; }
    console.log(`\n[${r.status}] ${label}`);
    if (j && Array.isArray(j)) {
      console.log(`  Array[${j.length}] — first item keys: ${j[0] ? Object.keys(j[0]).join(', ') : 'empty'}`);
      if (j[0]?.mint) console.log(`  Sample mint: ${j[0].mint}  symbol: ${j[0].symbol||j[0].name}`);
    } else if (j && j.coins) {
      console.log(`  .coins Array[${j.coins.length}] — keys: ${Object.keys(j.coins[0]||{}).join(', ')}`);
    } else if (j && j.pairs) {
      console.log(`  .pairs Array[${j.pairs.length}]`);
      if (j.pairs[0]) console.log(`  Sample: ${j.pairs[0].baseToken?.symbol} ${j.pairs[0].baseToken?.address} dex:${j.pairs[0].dexId}`);
    } else {
      console.log(' ', body.slice(0, 200));
    }
  } catch(e) { console.log(`  ERROR: ${e.message}`); }
}

async function main() {
  // Pump.fun API endpoints
  await probe('pump.fun /coins trending',   'https://frontend-api.pump.fun/coins?offset=0&limit=20&sort=last_reply&order=DESC&includeNsfw=false');
  await probe('pump.fun /coins top volume', 'https://frontend-api.pump.fun/coins?offset=0&limit=20&sort=volume&order=DESC');
  await probe('pump.fun /coins king_of_hill','https://frontend-api.pump.fun/coins/king-of-the-hill?offset=0&limit=10');
  // DexScreener pump.fun pairs
  await probe('DexScreener pump-fun new',   'https://api.dexscreener.com/latest/dex/search?q=pump%20fun%20solana');
  await probe('DexScreener boosted tokens', 'https://api.dexscreener.com/token-boosts/latest/v1');
  await probe('DexScreener top boosted',    'https://api.dexscreener.com/token-boosts/top/v1');
  await probe('DexScreener trending pairs', 'https://api.dexscreener.com/latest/dex/search?q=solana trending');
  // Birdeye free trending
  await probe('Birdeye trending',           'https://public-api.birdeye.so/defi/trending_tokens?sort_by=volume24hUSD&sort_type=desc&offset=0&limit=20&chain=solana');
}
main();
