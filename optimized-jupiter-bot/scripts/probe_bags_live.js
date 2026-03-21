require('dotenv').config();
const f = require('node-fetch');
const BASE = 'https://public-api-v2.bags.fm/api/v1';
const SOL  = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const KEY = process.env.BAGS_API_KEY;
async function main() {
  const url = `${BASE}/trade/quote?inputMint=${SOL}&outputMint=${USDC}&amount=100000000&slippageMode=auto&slippageBps=20`;
  const r = await f(url, { headers: { 'x-api-key': KEY } });
  const body = await r.json();
  // Dump full response so we can find the correct field names
  console.log('STATUS:', r.status);
  console.log('FULL BODY:', JSON.stringify(body, null, 2).slice(0, 2000));
}
main().catch(e => console.log('ERR:', e.message));
