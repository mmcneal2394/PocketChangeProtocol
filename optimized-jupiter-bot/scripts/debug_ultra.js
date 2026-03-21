require('dotenv').config();
const f = require('node-fetch');
const W = 'DnQhJawMXW7ZWA19XbzrV1q3KWZvMnpfyrxe4f74FHVj';
const KEY = process.env.JUPITER_API_KEY || '';
const url = `https://lite-api.jup.ag/ultra/v1/order?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=200000000&slippageBps=20&taker=${W}`;
console.log('Testing:', url.slice(0,100));
f(url, { headers: { 'x-api-key': KEY } })
  .then(r => { console.log('Status:', r.status); return r.json(); })
  .then(d => { console.log('Keys:', Object.keys(d)); console.log('outAmount:', d.outAmount); console.log('error:', d.error); console.log('requestId:', d.requestId?.slice(0,20)); })
  .catch(e => console.log('FETCH ERROR:', e.message));
