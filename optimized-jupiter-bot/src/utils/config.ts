import { z } from 'zod';
import dotenv from 'dotenv';
import * as fs from 'fs';
dotenv.config();

// ── Runtime secret guard ─────────────────────────────────────────────────────
// Intercepts ALL console output and redacts anything that looks like a raw
// keypair (64-byte Uint8Array stringified) or an 85+ char base58 private key.
const REDACT = '[REDACTED-SECRET]';
const KEYPAIR_UINT8_RE = /\[(\d{1,3},){60,}\d{1,3}\]/g;   // stringified Uint8Array
const BASE58_LONG_RE   = /[1-9A-HJ-NP-Za-km-z]{85,90}/g;  // 88-char private key

function redactStr(s: string): string {
  return s
    .replace(KEYPAIR_UINT8_RE, REDACT)
    .replace(BASE58_LONG_RE, REDACT);
}
function redactArg(a: unknown): unknown {
  return typeof a === 'string' ? redactStr(a) : a;
}
(['log', 'warn', 'error', 'info', 'debug'] as const).forEach((m) => {
  const orig = (console[m] as Function).bind(console);
  (console as any)[m] = (...args: unknown[]) => orig(...args.map(redactArg));
});
// ─────────────────────────────────────────────────────────────────────────────

const envSchema = z.object({
  GEYSER_RPC: z.string().url().or(z.string()),
  GEYSER_API_TOKEN: z.string(),
  RPC_ENDPOINT: z.string().url(),
  RPC_WEBSOCKET: z.string().url(),

  JITO_AUTH: z.string().optional(),
  JITO_BLOCK_ENGINE: z.string().url(),
  JITO_TIP_AMOUNT: z.string().transform(Number),

  // Dynamic tip engine
  DYNAMIC_TIP_ENABLED:  z.string().default('true').transform(s => s === 'true'),
  TIP_FLOOR_LAMPORTS:   z.string().default('5000').transform(Number),   // min tip even on bad trades
  TIP_CEIL_PCT:         z.string().default('0.5').transform(Number),     // max tip = 50% of net profit

  JUPITER_ENDPOINT: z.string().url(),
  JUPITER_API_KEY: z.string(),

  WALLET_KEYPAIR_PATH: z.string(),
  WALLET_PUBLIC_KEY: z.string(),

  SLIPPAGE_BPS: z.string().transform(Number),
  MIN_PROFIT_BPS: z.string().transform(Number),
  MAX_TRADE_SIZE_SOL: z.string().transform(Number),
  RESTRICT_INTERMEDIATE_TOKENS: z.union([
    z.boolean(),
    z.string().transform((s) => s === 'true'),
  ]).default(true),
  BAGS_API_KEY: z.string().optional(),

  // Local Engine Constants
  MIN_PROFIT_SOL:            z.string().default('0.05').transform(Number),
  TIP_PERCENTAGE:            z.string().default('0.5').transform(Number),
  MAX_SLIPPAGE_BPS:          z.string().default('50').transform(Number),
  SCAN_INTERVAL_MS:          z.string().default('100').transform(Number),
  TOKENS_TO_SCAN:            z.string().default('So11111111111111111111111111111111111111112'),
  PRIORITY_MICRO_LAMPORTS:   z.string().default('250000').transform(Number),
  LOG_DB_PATH:               z.string().default('./trades.db'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('[config] Invalid environment variables');
  console.error(parsed.error.format());
  process.exit(1);
}

// Verify keypair file exists — but never read or log its contents here
const kpPath = parsed.data.WALLET_KEYPAIR_PATH;
if (!fs.existsSync(kpPath)) {
  console.error(`[config] Keypair file not found: ${kpPath}`);
  console.error('[config] Generate one: node scripts/gen_wallet.js');
  process.exit(1);
}

export const config = parsed.data;
