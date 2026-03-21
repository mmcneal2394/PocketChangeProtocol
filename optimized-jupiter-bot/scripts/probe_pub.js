const f = require('node-fetch');
const url = 'https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=100000000&slippageBps=20';
f(url).then(r => { console.log('status:', r.status); return r.json(); })
  .then(d => console.log('outAmount:', d.outAmount, 'error:', d.error || 'none'))
  .catch(e => console.log('FETCH ERROR:', e.message));
