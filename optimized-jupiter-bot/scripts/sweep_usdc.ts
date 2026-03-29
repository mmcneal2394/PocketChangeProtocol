import { getQuote, executeSwap } from './maintain/momentum_sniper';

async function unwrap() {
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const WSOL_MINT = 'So11111111111111111111111111111111111111112';
  
  // 52.69175 USDC in 6 decimals
  const amount = 52691750;

  console.log(`Requesting Jup Quote to swap USDC -> WSOL`);
  const q = await getQuote(USDC_MINT, WSOL_MINT, amount, 200);
  
  if (!q) {
      console.log('Failed to fetch quote using momentum_sniper internal router');
      process.exit(1);
  }
  
  console.log(`Quote received: ${(Number(q.outAmount)/1e9).toFixed(4)} WSOL`);
  const sig = await executeSwap(q, 250000);
  console.log(`Result signature: ${sig}`);
}

unwrap();
