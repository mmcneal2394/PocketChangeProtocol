require('dotenv').config();
const f = require('node-fetch');
const BAGS_API = 'https://public-api-v2.bags.fm/api/v1';
const KEYS = [
  process.env.BAGS_API_KEY, process.env.BAGS_API_KEY_2, process.env.BAGS_API_KEY_3,
  process.env.BAGS_API_KEY_4, process.env.BAGS_API_KEY_5, process.env.BAGS_API_KEY_6,
];
const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
async function main() {
  console.log(`\nPREFLIGHT CHECK — ${new Date().toISOString()}\n${'─'.repeat(52)}`);
  let okCount = 0;
  for (let i = 0; i < KEYS.length; i++) {
    const key = KEYS[i];
    try {
      const r = await f(`${BAGS_API}/trade/quote?inputMint=${SOL}&outputMint=${USDC}&amount=20000000&slippageMode=auto&slippageBps=50`,
        { headers: { 'x-api-key': key } });
      const rl = r.headers.get('x-ratelimit-remaining');
      const j  = await r.json();
      if (r.status === 429) { console.log(`  key${i+1}: ❌ 429 (still throttled)`); continue; }
      if (j.success && j.response?.outAmount) {
        console.log(`  key${i+1}: ✅ [rl:${rl}]  outAmount: ${j.response.outAmount}`);
        okCount++;
      } else {
        console.log(`  key${i+1}: ⚠️  bad response: ${JSON.stringify(j).slice(0,60)}`);
      }
    } catch(e) { console.log(`  key${i+1}: ❌ ${e.message.slice(0,50)}`); }
    await new Promise(r => setTimeout(r, 400));
  }
  console.log(`${'─'.repeat(52)}`);
  console.log(`  Result: ${okCount}/${KEYS.length} keys healthy`);
  if (okCount >= 3) { console.log('  ✅ READY TO LAUNCH'); process.exit(0); }
  else { console.log('  ❌ NOT READY — wait for key recovery'); process.exit(1); }
}
main();
