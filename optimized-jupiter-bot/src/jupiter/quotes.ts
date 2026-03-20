import { config } from '../utils/config';
import { logger } from '../utils/logger';

export async function fetchJupiterQuote(inputToken: string, outputToken: string, amount: number) {
  try {
    const params = new URLSearchParams({
      inputMint: inputToken,
      outputMint: outputToken,
      amount: amount.toString(),
      slippageBps: config.SLIPPAGE_BPS.toString(),
      restrictIntermediateTokens: config.RESTRICT_INTERMEDIATE_TOKENS.toString(),
    });

    const quoteRes = await fetch(`${config.JUPITER_ENDPOINT}/quote?${params.toString()}`, {
      headers: { 'x-api-key': config.JUPITER_API_KEY }
    });
    
    if (!quoteRes.ok) {
        const errText = await quoteRes.text();
        throw new Error(`Quote failed: ${quoteRes.statusText} - ${errText}`);
    }
    return await quoteRes.json();
  } catch (error) {
    logger.error('Failed to fetching Jupiter quote:', error);
    return null;
  }
}

export async function getParallelSwapInstructions(quote1: any, quote2: any) {
  try {
    const fetchSwap = (quoteParams: any) => fetch(`${config.JUPITER_ENDPOINT}/swap-instructions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.JUPITER_API_KEY,
      },
      body: JSON.stringify({
        quoteResponse: quoteParams,
        userPublicKey: config.WALLET_PUBLIC_KEY,
        wrapAndUnwrapSol: false,
        dynamicComputeUnitLimit: true,
      }),
    }).then(r => r.json());

    const [ix1, ix2] = await Promise.all([fetchSwap(quote1), fetchSwap(quote2)]);
    return { ix1, ix2 };
  } catch (error) {
    logger.error('Failed to get swap instructions in parallel:', error);
    return null;
  }
}
