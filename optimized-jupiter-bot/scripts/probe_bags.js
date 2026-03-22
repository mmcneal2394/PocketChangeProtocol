/**
 * Deep probe api.bags.fm — try all plausible route patterns
 */
const f = require('node-fetch');
const KEY = 'process.env.BAGS_API_KEY';
const SOL  = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WALLET = 'DnQhJawMXW7ZWA19XbzrV1q3KWZvMnpfyrxe4f74FHVj';
const h = { 'x-api-key': KEY, 'Content-Type': 'application/json' };

async function probe(url, method = 'GET', body = null) {
  try {
    const r = await f(url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    let out; try { out = JSON.stringify(JSON.parse(t)).slice(0, 500); } catch(_) { out = t.slice(0, 200); }
    console.log(`[${r.status}] ${method} ${url.replace('https://api.bags.fm','')}`);
    if (r.status !== 404) console.log(`  >>> ${out}`);
  } catch(e) { console.log(`[ERR] ${url.slice(25,60)}: ${e.message.slice(0,80)}`); }
}

async function main() {
  const q = `inputMint=${SOL}&outputMint=${USDC}&amount=100000000&slippageBps=20`;
  const b = 'https://api.bags.fm';

  // Routes from Bags FM changelog hints: "trade", "swap"
  const paths = [
    // trade endpoints
    `/trade/quote?${q}`,
    `/trade/swap?${q}`,
    `/trade/quote`,
    // swap variants
    `/swap?${q}`,
    `/swap/v1/quote?${q}`,
    `/swap/quote?${q}`,
    `/swap/quote`,
    // token/price
    `/price?mint=${SOL}`,
    `/token/price?mint=${SOL}`,
    `/tokens/price?mints=${SOL},${USDC}`,
    // scanner
    `/scanner`,
    `/scan?mint=${SOL}`,
    `/opportunities`,
    `/arb`,
    `/arb/scan`,
    // jupiter proxy
    `/jupiter/quote?${q}`,
    `/jupiter/swap`,
  ];

  for (const p of paths) await probe(`${b}${p}`);

  // POST variants with body
  await probe(`${b}/trade/quote`, 'POST', { inputMint: SOL, outputMint: USDC, amount: '100000000', slippageBps: 20 });
  await probe(`${b}/swap`, 'POST', { inputMint: SOL, outputMint: USDC, amount: '100000000', userPublicKey: WALLET });
  await probe(`${b}/trade/swap`, 'POST', { inputMint: SOL, outputMint: USDC, amount: '100000000', slippageBps: 20, userPublicKey: WALLET });
}
main();
