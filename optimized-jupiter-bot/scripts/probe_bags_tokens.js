/**
 * Probe Bags API for long-tail token discovery endpoints
 * Looking for: top tokens, recent launches, high-volume tokens
 */
require('dotenv').config();
const f = require('node-fetch');
const BASE = 'https://public-api-v2.bags.fm/api/v1';
const KEY = process.env.BAGS_API_KEY;
const h = { 'x-api-key': KEY };

async function probe(path, params = '') {
  const url = `${BASE}${path}${params ? '?'+params : ''}`;
  const r = await f(url, { headers: h });
  const body = await r.text();
  let parsed; try { parsed = JSON.parse(body); } catch(_) { parsed = body; }
  console.log(`\n[${r.status}] GET ${path}${params?'?'+params:''}`);
  if (typeof parsed === 'object') {
    console.log(JSON.stringify(parsed, null, 2).slice(0, 600));
  } else {
    console.log(body.slice(0, 200));
  }
}

async function main() {
  // From SDK: top Bags tokens by lifetime fees
  await probe('/token-launch/top-tokens/lifetime-fees');
  await probe('/token-launch/top-tokens/lifetime-fees', 'limit=5');
  // Try trending / recent launches
  await probe('/token-launch/trending');
  await probe('/token-launch/recent');
  await probe('/token-launch/tokens');
  await probe('/token-launch/tokens', 'limit=10&sortBy=volume');
  // Try trade history / recent swaps to find active tokens
  await probe('/trade/history');
  await probe('/trade/recent');
  // Token prices
  await probe('/token-launch/prices', 'mints=So11111111111111111111111111111111111111112');
}
main().catch(e => console.log('ERR:', e.message));
