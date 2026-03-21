const { z } = require('zod');

const envSchema = z.object({
  GEYSER_ENDPOINT: z.string().url().or(z.string()),
  GEYSER_API_TOKEN: z.string(),
  RPC_ENDPOINT: z.string().url(),
  RPC_WEBSOCKET: z.string().url(),

  JITO_AUTH: z.string().optional(),
  JITO_BLOCK_ENGINE: z.string().url(),
  JITO_TIP_AMOUNT: z.string().transform(Number),

  JUPITER_ENDPOINT: z.string().url(),
  JUPITER_API_KEY: z.string(),

  WALLET_KEYPAIR_PATH: z.string(),
  WALLET_PUBLIC_KEY: z.string(),

  SLIPPAGE_BPS: z.string().transform(Number),
  MIN_PROFIT_BPS: z.string().transform(Number),
  MAX_TRADE_SIZE_SOL: z.string().transform(Number),
  RESTRICT_INTERMEDIATE_TOKENS: z.union([z.boolean(), z.string().transform((s) => s === 'true')]).default(true),
  BAGS_API_KEY: z.string().optional(),

  // Local Engine Constants
  MIN_PROFIT_SOL: z.string().default("0.05").transform(Number),
  TIP_PERCENTAGE: z.string().default("0.5").transform(Number),
  MAX_SLIPPAGE_BPS: z.string().default("50").transform(Number),
  SCAN_INTERVAL_MS: z.string().default("100").transform(Number),
  TOKENS_TO_SCAN: z.string().default("So11111111111111111111111111111111111111112"),
  
  // Storage System Mappings
  LOG_DB_PATH: z.string().default("./trades.db")
});

const parsed = envSchema.safeParse({});
console.log(parsed.error.format());
