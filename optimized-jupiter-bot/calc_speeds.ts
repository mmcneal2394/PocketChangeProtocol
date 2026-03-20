import { fetchJupiterQuote } from './src/jupiter/quotes';
import { config } from './src/utils/config';

const TOKENS = {
  WSOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  WIF: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYtM2wYSzRo",
  BONK: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  RAY: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  JUP: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbPwdrsxGBK",
  PYTH: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3AkTftx2K2aFCh",
  JTO: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
  POPCAT: "7GCihgDB8fe6KNjn2gN7ZDB2h2n2i2Z7pW2r2YjN1e8p",
  BOME: "ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgM2W8qT"
};

const TARGETS = [
  TOKENS.USDC, TOKENS.WIF, TOKENS.BONK, TOKENS.RAY, TOKENS.JUP,
  TOKENS.PYTH, TOKENS.JTO, TOKENS.POPCAT, TOKENS.BOME
];

async function runTest() {
  console.log("⚡ Executing Speed Calculation for Latest Scan Targets...\n");
  
  let totalTime = 0;
  let successfulScans = 0;
  
  for (let i = 0; i < TARGETS.length; i++) {
    const mint = TARGETS[i];
    const tradeSizeLamports = 100000000; // 0.1 SOL
    
    const startMs = performance.now();
    try {
      const quote1 = await fetchJupiterQuote(TOKENS.WSOL, mint, tradeSizeLamports);
      if (!quote1) throw new Error("Null quote1");
      const quote2 = await fetchJupiterQuote(mint, TOKENS.WSOL, Number(quote1.otherAmountThreshold));
      if (!quote2) throw new Error("Null quote2");
      
      const endMs = performance.now();
      const speedMs = endMs - startMs;
      
      totalTime += speedMs;
      successfulScans++;
      
      let mintDisplay = Object.keys(TOKENS).find(key => TOKENS[key as keyof typeof TOKENS] === mint) || mint.substring(0, 8);
      console.log(`[${i+1}] Target: WSOL -> ${mintDisplay} -> WSOL | Sweep Speed: ${speedMs.toFixed(2)} ms`);
    } catch(e) {
      console.log(`[${i+1}] Target: WSOL -> ${mint.substring(0,4)}... | Failed to route`);
    }
  }
  
  if (successfulScans > 0) {
    console.log(`\n📊 Average Scan Speed: ${(totalTime / successfulScans).toFixed(2)} ms per full Triangular Route`);
  }
}

runTest();
